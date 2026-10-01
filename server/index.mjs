import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { cleanText, extractLinks, htmlToText, normalizeUrl } from './mail-content.mjs';

const PORT = Number(process.env.PORT || 8797);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 15000);
const SYNC_CONCURRENCY = Math.max(1, Number(process.env.SYNC_CONCURRENCY) || 8);
const GRAPH_SCOPE = process.env.GRAPH_SCOPE || 'https://graph.microsoft.com/Mail.Read';
const TOKEN_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const GRAPH_ME = 'https://graph.microsoft.com/v1.0/me';
const MESSAGE_FIELDS = 'id,subject,from,receivedDateTime,isRead,bodyPreview,internetMessageId';
const HISTORY_FOLDERS = new Set(['inbox', 'junkemail']);
const FULL_MESSAGE_CACHE_SIZE = 60;
const EMAIL_PATTERN = /^[^\s@|]+@[^\s@|]+\.[^\s@|]+$/;
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(projectRoot, process.env.DATA_DIR || '.data');
const keyPath = path.join(dataDir, 'master.key');
const statePath = path.join(dataDir, 'state.json');
const tempStatePath = path.join(dataDir, 'state.json.tmp');
const backupStatePath = path.join(dataDir, 'state.backup.json');

class MailError extends Error {
  constructor(message, detail = '') {
    super(message);
    this.detail = detail;
  }
}

const app = express();
let state = emptyState();
let masterKey;

function emptyState() {
  return { accounts: [], messages: [] };
}

function now() {
  return new Date().toISOString();
}

function timeOf(value) {
  const time = new Date(value ?? 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// ---------------------------------------------------------------------------
// Storage. state.json is only ever replaced atomically (temp file + rename),
// and every successful start leaves a known-good copy in state.backup.json,
// so a crash or a killed process can no longer wipe the accounts.
// ---------------------------------------------------------------------------

async function ensureStorage() {
  await fs.mkdir(dataDir, { recursive: true });
  state = await loadState();
  masterKey = await loadOrCreateMasterKey();
  for (const account of state.accounts) {
    account.receiverPage = normalizeReceiverPage(account.receiverPage);
  }
  keepLatestMessagePerAccount();
  await saveState();
}

async function loadState() {
  let raw;
  try {
    raw = await fs.readFile(statePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState();
    throw error;
  }

  try {
    const loaded = parseState(raw);
    await fs.copyFile(statePath, backupStatePath).catch((error) => {
      console.warn(`[storage] 备份 state.json 失败：${error.message}`);
    });
    return loaded;
  } catch (error) {
    const corruptPath = path.join(dataDir, `state.corrupt-${Date.now()}.json`);
    await fs.copyFile(statePath, corruptPath);
    console.error(`[storage] state.json 已损坏（${error.message}），原文件已另存为 ${corruptPath}`);
    try {
      const recovered = parseState(await fs.readFile(backupStatePath, 'utf8'));
      console.error('[storage] 已从 state.backup.json 恢复数据');
      return recovered;
    } catch {
      console.error('[storage] 没有可用的备份，将以空数据启动');
      return emptyState();
    }
  }
}

function parseState(raw) {
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.accounts)) {
    throw new Error('缺少 accounts 列表');
  }
  return {
    accounts: parsed.accounts,
    messages: Array.isArray(parsed.messages) ? parsed.messages : []
  };
}

async function loadOrCreateMasterKey() {
  try {
    const key = await fs.readFile(keyPath);
    if (key.length !== 32) {
      throw new Error(`${keyPath} 长度异常（${key.length} 字节），为避免覆盖已停止启动`);
    }
    return key;
  } catch (error) {
    // Only a missing key may be replaced; any other failure must not overwrite it.
    if (error.code !== 'ENOENT') throw error;
  }

  if (state.accounts.length > 0) {
    console.warn('[storage] 找不到 master.key，已有账户的凭据将无法解密，需要重新导入');
  }
  const key = crypto.randomBytes(32);
  await fs.writeFile(keyPath, key, { mode: 0o600, flag: 'wx' });
  return key;
}

let activeWrite = null;
let queuedWrite = null;

// Calls made while a write is in flight share one follow-up write, so every
// caller resolves only after a write that includes its changes.
function saveState() {
  if (queuedWrite) return queuedWrite;
  const previous = activeWrite ?? Promise.resolve();
  queuedWrite = previous
    .catch(() => {})
    .then(() => {
      queuedWrite = null;
      activeWrite = writeStateFile().finally(() => {
        activeWrite = null;
      });
      return activeWrite;
    });
  return queuedWrite;
}

async function writeStateFile() {
  const handle = await fs.open(tempStatePath, 'w', 0o600);
  try {
    await handle.writeFile(JSON.stringify(state, null, 2), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }

  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.rename(tempStatePath, statePath);
      return;
    } catch (error) {
      // On Windows, antivirus or the search indexer can hold the file briefly.
      if (attempt >= 8 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      await delay(50 * attempt);
    }
  }
}

function logSaveError(error) {
  console.error(`[storage] 保存 state.json 失败：${error.message}`);
}

function encryptString(value) {
  if (!value) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: ciphertext.toString('base64')
  };
}

function decryptString(payload) {
  if (!payload) return '';
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    masterKey,
    Buffer.from(payload.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.data, 'base64')),
    decipher.final()
  ]);
  return plaintext.toString('utf8');
}

// ---------------------------------------------------------------------------
// Microsoft identity platform + Graph
// ---------------------------------------------------------------------------

const TOKEN_ERROR_HINTS = new Map([
  ['AADSTS70000', '授权已失效，需要重新获取 refresh token'],
  ['AADSTS70008', '授权已过期，需要重新获取 refresh token'],
  ['AADSTS700082', '授权因长期未使用已过期，需要重新获取 refresh token'],
  ['AADSTS50173', '授权已被撤销（可能改过密码），需要重新获取 refresh token'],
  ['AADSTS700016', 'client_id 无效，找不到对应的应用'],
  ['AADSTS50034', '邮箱账户不存在'],
  ['AADSTS50053', '账户已被锁定'],
  ['AADSTS50057', '账户已被停用'],
  ['AADSTS65001', '应用未获得授权，需要重新同意权限'],
  ['AADSTS70011', '请求的权限范围无效'],
  ['AADSTS9002313', 'refresh token 格式不正确']
]);

async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { error: { message: text.slice(0, 200) } };
    }
    return { response, payload };
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new MailError(`请求超时（${Math.round(REQUEST_TIMEOUT_MS / 1000)} 秒无响应）`);
    }
    throw new MailError('网络请求失败，请检查网络或代理', error.cause?.code || error.message);
  } finally {
    clearTimeout(timer);
  }
}

function describeTokenError(payload) {
  const description = String(payload.error_description || payload.error?.message || '');
  const detail = description.split(/\r?\n|\s*Trace ID:/)[0].trim();
  const code = description.match(/AADSTS\d+/)?.[0];
  let message = code ? TOKEN_ERROR_HINTS.get(code) : undefined;
  if (/service abuse/i.test(description)) message = '账户被微软锁定（service abuse mode）';
  if (!message && payload.error === 'invalid_grant') message = '授权已失效，需要重新获取 refresh token';
  return new MailError(message || detail || '刷新访问令牌失败', detail);
}

function describeGraphError(response, payload) {
  const code = payload.error?.code || '';
  const detail = payload.error?.message || `HTTP ${response.status}`;
  let message;
  if (code === 'ErrorItemNotFound' || code === 'ResourceNotFound') {
    message = '邮件不存在（可能已被删除或移动）';
  } else if (code.startsWith('MailboxNotEnabled') || code.startsWith('MailboxNotSupported')) {
    message = '邮箱不可用（未启用或已被停用）';
  } else if (response.status === 401) {
    message = '访问令牌无效，请稍后重试';
  } else if (response.status === 403) {
    message = '没有读取邮件的权限';
  } else if (response.status === 429) {
    message = '请求太频繁，被微软限流，请稍后再试';
  } else if (response.status >= 500) {
    message = '微软服务暂时不可用，请稍后再试';
  }
  return new MailError(message || detail, detail);
}

const accessTokens = new Map(); // accountId -> { token, expiresAt }
const tokenRequests = new Map(); // accountId -> Promise<string>

function forgetAccountTokens(accountId) {
  accessTokens.delete(accountId);
  tokenRequests.delete(accountId);
}

// Access tokens live ~1 hour; reusing them makes opening a message a single
// Graph request instead of a token exchange plus a Graph request.
function getAccessToken(account) {
  const cached = accessTokens.get(account.id);
  if (cached && cached.expiresAt - 120_000 > Date.now()) return Promise.resolve(cached.token);

  let request = tokenRequests.get(account.id);
  if (!request) {
    request = exchangeRefreshToken(account).finally(() => tokenRequests.delete(account.id));
    tokenRequests.set(account.id, request);
  }
  return request;
}

async function exchangeRefreshToken(account) {
  const credentials = account.refreshTokenEncrypted;
  let clientId;
  let refreshToken;
  try {
    clientId = decryptString(account.clientIdEncrypted);
    refreshToken = decryptString(credentials);
  } catch {
    throw new MailError('无法解密账户凭据（master.key 不匹配），请重新导入该账户');
  }

  const { response, payload } = await requestJson(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: GRAPH_SCOPE
    })
  });

  if (!response.ok || !payload.access_token) {
    throw describeTokenError(payload);
  }

  // Skip bookkeeping if the account was re-imported or deleted meanwhile.
  if (account.refreshTokenEncrypted === credentials && state.accounts.includes(account)) {
    if (payload.refresh_token && payload.refresh_token !== refreshToken) {
      account.refreshTokenEncrypted = encryptString(payload.refresh_token);
      saveState().catch(logSaveError);
    }
    const lifetimeSeconds = Number(payload.expires_in) || 3600;
    accessTokens.set(account.id, {
      token: payload.access_token,
      expiresAt: Date.now() + lifetimeSeconds * 1000
    });
  }

  return payload.access_token;
}

async function graphGet(account, resource, { html = false } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    const token = await getAccessToken(account);
    const { response, payload } = await requestJson(`${GRAPH_ME}${resource}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Prefer: `outlook.body-content-type="${html ? 'html' : 'text'}"`
      }
    });

    if (response.ok) return payload;
    if (response.status === 401 && attempt === 1) {
      accessTokens.delete(account.id);
      continue;
    }
    if ((response.status === 429 || response.status === 503) && attempt <= 2) {
      const retryAfterSeconds = clamp(Number(response.headers.get('retry-after')) || 2, 1, 10);
      await delay(retryAfterSeconds * 1000);
      continue;
    }
    throw describeGraphError(response, payload);
  }
}

function summarizeMessage(item) {
  return {
    providerMessageId: item.id,
    internetMessageId: item.internetMessageId || '',
    subject: item.subject || '',
    fromName: item.from?.emailAddress?.name || '',
    fromAddress: item.from?.emailAddress?.address || '',
    receivedDateTime: item.receivedDateTime || null,
    isRead: Boolean(item.isRead),
    bodyPreview: cleanText(item.bodyPreview || '')
  };
}

async function listFolderMessages(account, folder, limit) {
  const query = new URLSearchParams({
    $select: MESSAGE_FIELDS,
    $orderby: 'receivedDateTime desc',
    $top: String(limit)
  });
  const payload = await graphGet(account, `/mailFolders/${folder}/messages?${query}`);
  return (Array.isArray(payload.value) ? payload.value : [])
    .filter((item) => item.id)
    .map(summarizeMessage);
}

const fullMessageCache = new Map();

async function fetchFullMessage(account, providerMessageId) {
  const cacheKey = `${account.id}:${providerMessageId}`;
  const cached = fullMessageCache.get(cacheKey);
  if (cached) return cached;

  const query = new URLSearchParams({ $select: `${MESSAGE_FIELDS},body,webLink` });
  const payload = await graphGet(
    account,
    `/messages/${encodeURIComponent(providerMessageId)}?${query}`,
    { html: true }
  );

  const content = payload.body?.content || '';
  const isHtml = payload.body?.contentType === 'html';
  const bodyText =
    (isHtml ? htmlToText(content) : cleanText(content)) || cleanText(payload.bodyPreview || '');
  const message = {
    ...summarizeMessage(payload),
    bodyText: bodyText.slice(0, 60_000),
    bodyHtml: isHtml && content.length <= 1_500_000 ? content : null,
    links: extractLinks(isHtml ? content : '', bodyText),
    webLink: normalizeUrl(payload.webLink || '')
  };

  fullMessageCache.set(cacheKey, message);
  if (fullMessageCache.size > FULL_MESSAGE_CACHE_SIZE) {
    fullMessageCache.delete(fullMessageCache.keys().next().value);
  }
  return message;
}

// ---------------------------------------------------------------------------
// Accounts and their latest message
// ---------------------------------------------------------------------------

function normalizeReceiverPage(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1;
}

function findAccount(accountId) {
  return state.accounts.find((account) => account.id === accountId);
}

function parseImportLines(raw) {
  const valid = [];
  const invalidLines = [];

  String(raw || '')
    .split(/\r?\n/)
    .forEach((line, index) => {
      if (!line.trim()) return;
      const parts = line.split('|').map((part) => part.trim());
      const email = parts[0];
      let [refreshToken, clientId] = parts.slice(-2);
      // Some exports put client_id before refresh_token; client IDs are GUIDs.
      if (!GUID_PATTERN.test(clientId ?? '') && GUID_PATTERN.test(refreshToken ?? '')) {
        [refreshToken, clientId] = [clientId, refreshToken];
      }

      if (parts.length < 4 || !EMAIL_PATTERN.test(email) || !refreshToken || !clientId) {
        invalidLines.push(index + 1);
        return;
      }

      // Anything between the email and the two credentials is the password,
      // even if the password itself contains "|".
      valid.push({ email, password: parts.slice(1, -2).join('|'), refreshToken, clientId });
    });

  return { valid, invalidLines };
}

function upsertImportedAccount(input, receiverPage) {
  const stamp = now();
  const credentials = {
    passwordEncrypted: encryptString(input.password),
    refreshTokenEncrypted: encryptString(input.refreshToken),
    clientIdEncrypted: encryptString(input.clientId)
  };
  const existing = state.accounts.find(
    (account) => account.email.toLowerCase() === input.email.toLowerCase()
  );

  if (existing) {
    Object.assign(existing, credentials, {
      receiverPage,
      updatedAt: stamp,
      lastError: null,
      lastErrorDetail: null
    });
    forgetAccountTokens(existing.id);
    return 'updated';
  }

  state.accounts.push({
    id: crypto.randomUUID(),
    email: input.email,
    provider: 'microsoft',
    receiverPage,
    ...credentials,
    createdAt: stamp,
    updatedAt: stamp,
    lastSyncAt: null,
    lastError: null,
    lastErrorDetail: null
  });
  return 'added';
}

function removeAccounts(ids) {
  const before = state.accounts.length;
  state.accounts = state.accounts.filter((account) => !ids.has(account.id));
  state.messages = state.messages.filter((message) => !ids.has(message.accountId));
  for (const id of ids) {
    forgetAccountTokens(id);
  }
  return before - state.accounts.length;
}

function keepLatestMessagePerAccount() {
  const accountIds = new Set(state.accounts.map((account) => account.id));
  const latest = new Map();
  for (const message of state.messages) {
    if (!accountIds.has(message.accountId)) continue;
    const current = latest.get(message.accountId);
    if (!current || timeOf(message.receivedDateTime) > timeOf(current.receivedDateTime)) {
      latest.set(message.accountId, message);
    }
  }
  state.messages = [...latest.values()];
}

// Stores the inbox's newest message as the account's latest message.
// Returns 1 when it is newer than what we had.
function applyLatestMessage(account, latest) {
  if (!state.accounts.includes(account)) return 0;
  const previous = state.messages.find((message) => message.accountId === account.id);

  if (!latest) {
    state.messages = state.messages.filter((message) => message.accountId !== account.id);
    return 0;
  }

  if (previous?.providerMessageId === latest.providerMessageId) {
    Object.assign(previous, latest, { isRead: previous.isRead || latest.isRead });
    return 0;
  }

  state.messages = state.messages.filter((message) => message.accountId !== account.id);
  state.messages.push({
    id: crypto.randomUUID(),
    accountId: account.id,
    ...latest,
    readAt: null,
    firstSeenAt: now()
  });
  return !previous || timeOf(latest.receivedDateTime) > timeOf(previous.receivedDateTime) ? 1 : 0;
}

function publicMessage(message) {
  if (!message) return null;
  return {
    id: message.id,
    providerMessageId: message.providerMessageId,
    subject: message.subject || '',
    fromName: message.fromName || '',
    fromAddress: message.fromAddress || '',
    receivedDateTime: message.receivedDateTime || null,
    isRead: Boolean(message.isRead),
    bodyPreview: message.bodyPreview || ''
  };
}

// ---------------------------------------------------------------------------
// Sync. Each account syncs at most once at a time; "all", "page" and
// "account" jobs share in-flight work instead of returning each other's
// results, and a single-account refresh skips the queue.
// ---------------------------------------------------------------------------

function createLimiter(max) {
  let active = 0;
  const waiting = [];
  const next = () => {
    if (active >= max || waiting.length === 0) return;
    active += 1;
    const { task, resolve, reject } = waiting.shift();
    task()
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        next();
      });
  };
  return (task) =>
    new Promise((resolve, reject) => {
      waiting.push({ task, resolve, reject });
      next();
    });
}

const limitSync = createLimiter(SYNC_CONCURRENCY);
const runningSyncs = new Map(); // accountId -> Promise, while requests are in flight
const queuedSyncs = new Map(); // accountId -> Promise, from queueing until done
const syncJobs = new Map();
let nextSyncJobId = 1;

function syncAccountOnce(account, { immediate = false } = {}) {
  if (runningSyncs.has(account.id)) return runningSyncs.get(account.id);
  if (immediate) return startAccountSync(account);
  if (queuedSyncs.has(account.id)) return queuedSyncs.get(account.id);

  const queued = limitSync(() => startAccountSync(account)).finally(() =>
    queuedSyncs.delete(account.id)
  );
  queuedSyncs.set(account.id, queued);
  return queued;
}

function startAccountSync(account) {
  if (runningSyncs.has(account.id)) return runningSyncs.get(account.id);
  const running = syncAccount(account).finally(() => runningSyncs.delete(account.id));
  runningSyncs.set(account.id, running);
  return running;
}

async function syncAccount(account) {
  if (!state.accounts.includes(account)) {
    return { accountId: account.id, ok: true, inserted: 0 };
  }

  try {
    const [latest] = await listFolderMessages(account, 'inbox', 1);
    const inserted = applyLatestMessage(account, latest ?? null);
    account.lastSyncAt = now();
    account.lastError = null;
    account.lastErrorDetail = null;
    return { accountId: account.id, ok: true, inserted };
  } catch (error) {
    account.lastError = error.message || '读取失败';
    account.lastErrorDetail = error.detail || null;
    return { accountId: account.id, ok: false, inserted: 0, error: account.lastError };
  } finally {
    account.updatedAt = now();
    saveState().catch(logSaveError);
  }
}

function parseSyncScope(body = {}) {
  if (typeof body.accountId === 'string') return { type: 'account', accountId: body.accountId };
  if (body.receiverPage !== undefined && body.receiverPage !== null) {
    return { type: 'page', page: normalizeReceiverPage(body.receiverPage) };
  }
  return { type: 'all' };
}

function accountsForScope(scope) {
  if (scope.type === 'account') {
    return state.accounts.filter((account) => account.id === scope.accountId);
  }
  if (scope.type === 'page') {
    return state.accounts.filter((account) => account.receiverPage === scope.page);
  }
  return [...state.accounts];
}

function sameScope(a, b) {
  return a.type === b.type && a.page === b.page && a.accountId === b.accountId;
}

function summarizeSync(scope, results) {
  const failed = results.filter((result) => !result.ok);
  const inserted = results.reduce((sum, result) => sum + (result.inserted || 0), 0);
  let message;

  if (results.length === 0) {
    message = '没有可读取的邮箱';
  } else if (scope.type === 'account') {
    message = failed.length ? `读取失败：${failed[0].error}` : inserted ? '收到新邮件' : '没有新邮件';
  } else {
    const parts = [inserted ? `${inserted} 个邮箱有新邮件` : '没有新邮件'];
    if (failed.length) parts.push(`${failed.length} 个读取失败`);
    message = `读取完成：${parts.join('，')}`;
  }

  return { ok: failed.length === 0, total: results.length, inserted, failed: failed.length, message };
}

function runSyncJob(scope) {
  for (const job of syncJobs.values()) {
    if (sameScope(job.scope, scope)) return job.promise;
  }

  const accounts = accountsForScope(scope);
  const job = { id: nextSyncJobId++, scope, total: accounts.length, done: 0 };
  job.promise = (async () => {
    try {
      const results = await Promise.all(
        accounts.map(async (account) => {
          const result = await syncAccountOnce(account, { immediate: scope.type === 'account' });
          job.done += 1;
          return result;
        })
      );
      await saveState();
      return summarizeSync(scope, results);
    } finally {
      syncJobs.delete(job.id);
    }
  })();
  syncJobs.set(job.id, job);
  return job.promise;
}

function bootstrapPayload() {
  const latestByAccount = new Map(state.messages.map((message) => [message.accountId, message]));
  const accounts = state.accounts.map((account) => ({
    id: account.id,
    email: account.email,
    receiverPage: account.receiverPage,
    createdAt: account.createdAt || null,
    lastSyncAt: account.lastSyncAt || null,
    lastError: account.lastError || null,
    lastErrorDetail: account.lastErrorDetail || null,
    syncState: runningSyncs.has(account.id)
      ? 'running'
      : queuedSyncs.has(account.id)
        ? 'queued'
        : null,
    latest: publicMessage(latestByAccount.get(account.id))
  }));
  const pages = [...new Set([1, 2, ...accounts.map((account) => account.receiverPage)])].sort(
    (a, b) => a - b
  );

  return {
    accounts,
    pages,
    syncJobs: [...syncJobs.values()].map(({ id, scope, total, done }) => ({ id, scope, total, done }))
  };
}

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------

app.disable('x-powered-by');

// Reject other Host names so a web page can't reach this API via DNS rebinding.
app.use((request, response, next) => {
  if (LOCAL_HOSTNAMES.has(request.hostname)) {
    next();
    return;
  }
  response.status(403).json({ error: '只允许通过本机地址访问' });
});

app.use(express.json({ limit: '10mb' }));

app.get('/api/health', (_request, response) => {
  response.json({
    ok: true,
    accounts: state.accounts.length,
    messages: state.messages.length,
    syncing: syncJobs.size > 0
  });
});

app.get('/api/bootstrap', (_request, response) => {
  response.json(bootstrapPayload());
});

app.post('/api/accounts/import', async (request, response) => {
  const { valid, invalidLines } = parseImportLines(request.body?.raw);
  const receiverPage = normalizeReceiverPage(request.body?.receiverPage);
  if (valid.length === 0) {
    response.status(400).json({ error: '没有识别到有效的账户行', invalidLines });
    return;
  }

  let added = 0;
  let updated = 0;
  for (const input of valid) {
    if (upsertImportedAccount(input, receiverPage) === 'added') {
      added += 1;
    } else {
      updated += 1;
    }
  }

  await saveState();
  response.json({ added, updated, invalidLines, receiverPage });
});

app.post('/api/accounts/delete', async (request, response) => {
  const ids = new Set(Array.isArray(request.body?.ids) ? request.body.ids : []);
  const removed = removeAccounts(ids);
  if (removed) await saveState();
  response.json({ removed });
});

app.delete('/api/accounts/:accountId', async (request, response) => {
  if (!removeAccounts(new Set([request.params.accountId]))) {
    response.status(404).json({ error: '账户不存在' });
    return;
  }
  await saveState();
  response.json({ ok: true });
});

app.get('/api/accounts/:accountId/history', async (request, response) => {
  const account = findAccount(request.params.accountId);
  if (!account) {
    response.status(404).json({ error: '账户不存在' });
    return;
  }

  const folder = HISTORY_FOLDERS.has(request.query.folder) ? request.query.folder : 'inbox';
  const limit = clamp(Math.floor(Number(request.query.limit) || 25), 1, 50);
  const messages = await listFolderMessages(account, folder, limit);
  response.json({ folder, messages });
});

app.get('/api/accounts/:accountId/messages/:providerMessageId', async (request, response) => {
  const account = findAccount(request.params.accountId);
  if (!account) {
    response.status(404).json({ error: '账户不存在' });
    return;
  }
  response.json(await fetchFullMessage(account, request.params.providerMessageId));
});

app.post('/api/sync', async (request, response) => {
  const scope = parseSyncScope(request.body);
  if (scope.type === 'account' && !findAccount(scope.accountId)) {
    response.status(404).json({ error: '账户不存在' });
    return;
  }
  response.json(await runSyncJob(scope));
});

app.post('/api/messages/read-all', async (request, response) => {
  const page =
    request.body?.receiverPage === undefined || request.body?.receiverPage === null
      ? null
      : normalizeReceiverPage(request.body.receiverPage);
  const accountIds = new Set(
    state.accounts
      .filter((account) => page === null || account.receiverPage === page)
      .map((account) => account.id)
  );

  let count = 0;
  const stamp = now();
  for (const message of state.messages) {
    if (!message.isRead && accountIds.has(message.accountId)) {
      message.isRead = true;
      message.readAt = stamp;
      count += 1;
    }
  }

  if (count) await saveState();
  response.json({ ok: true, count });
});

app.post('/api/messages/:messageId/read', async (request, response) => {
  const message = state.messages.find((item) => item.id === request.params.messageId);
  if (!message) {
    response.status(404).json({ error: '邮件不存在' });
    return;
  }

  if (!message.isRead) {
    message.isRead = true;
    message.readAt = now();
    await saveState();
  }
  response.json({ ok: true });
});

app.use('/api', (_request, response) => {
  response.status(404).json({ error: '接口不存在' });
});

app.use((error, _request, response, _next) => {
  if (error.type === 'entity.too.large') {
    response.status(413).json({ error: '内容太大，请分批导入' });
    return;
  }
  if (error.type === 'entity.parse.failed') {
    response.status(400).json({ error: '请求内容不是有效的 JSON' });
    return;
  }
  if (error instanceof MailError) {
    response.status(502).json({ error: error.message, detail: error.detail || null });
    return;
  }
  console.error(error);
  response.status(500).json({ error: error.message || '服务器内部错误' });
});

await ensureStorage();

app.listen(PORT, '127.0.0.1', (error) => {
  if (error) {
    console.error(`[server] 无法监听端口 ${PORT}：${error.message}`);
    process.exit(1);
  }
  console.log(`Mail Collector API listening on http://127.0.0.1:${PORT}`);
  console.log(`Data directory: ${dataDir}`);
});

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await Promise.race([saveState().catch(logSaveError), delay(2000)]);
    process.exit(0);
  });
}
