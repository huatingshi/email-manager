import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';

const app = express();
const PORT = Number(process.env.PORT || 8787);
const MAX_MESSAGES = Number(process.env.MAX_MESSAGES || 100);
const MESSAGES_PER_ACCOUNT = Number(process.env.MESSAGES_PER_ACCOUNT || 1);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 15000);
const SYNC_CONCURRENCY = Number(process.env.SYNC_CONCURRENCY || 8);
const GRAPH_SCOPE = process.env.GRAPH_SCOPE || 'https://graph.microsoft.com/Mail.Read';
const TOKEN_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const GRAPH_MESSAGES_ENDPOINT =
  'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages';
const EMAIL_PATTERN = /^[^\s@|]+@[^\s@|]+\.[^\s@|]+$/;

const rootDir = process.cwd();
const dataDir = path.join(rootDir, '.data');
const keyPath = path.join(dataDir, 'master.key');
const statePath = path.join(dataDir, 'state.json');

const defaultState = {
  accounts: [],
  messages: [],
  runtime: {
    syncing: false,
    syncingPage: null,
    lastPollStartedAt: null,
    lastPollFinishedAt: null
  }
};

let state = structuredClone(defaultState);
let masterKey;
let syncPromise = null;

app.use(express.json({ limit: '2mb' }));

function now() {
  return new Date().toISOString();
}

async function ensureStorage() {
  await fs.mkdir(dataDir, { recursive: true });
  masterKey = await loadOrCreateMasterKey();
  state = await loadState();
  state.runtime.syncing = false;
  state.runtime.syncingPage = null;
  normalizeAccountPages();
  pruneMessagesToLatestPerAccount();
  await saveState();
}

async function loadOrCreateMasterKey() {
  try {
    return await fs.readFile(keyPath);
  } catch {
    const key = crypto.randomBytes(32);
    await fs.writeFile(keyPath, key, { mode: 0o600 });
    return key;
  }
}

async function loadState() {
  try {
    const raw = await fs.readFile(statePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      runtime: {
        ...defaultState.runtime,
        ...(parsed.runtime || {})
      }
    };
  } catch {
    return structuredClone(defaultState);
  }
}

async function saveState() {
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
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

function normalizeReceiverPage(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1;
}

function normalizeAccountPages() {
  for (const account of state.accounts) {
    account.receiverPage = normalizeReceiverPage(account.receiverPage);
  }
}

function pruneMessagesToLatestPerAccount() {
  const latestByAccount = new Map();

  for (const message of state.messages) {
    const current = latestByAccount.get(message.accountId);
    const currentTime = new Date(current?.receivedDateTime || 0).getTime();
    const nextTime = new Date(message.receivedDateTime || 0).getTime();
    if (!current || nextTime > currentTime) {
      latestByAccount.set(message.accountId, message);
    }
  }

  state.messages = [...latestByAccount.values()].sort(
    (a, b) => new Date(b.receivedDateTime || 0) - new Date(a.receivedDateTime || 0)
  );
}

async function fetchJsonWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    const payload = await response.json();
    return { response, payload };
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`请求超时，超过 ${Math.round(REQUEST_TIMEOUT_MS / 1000)} 秒无响应`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function parseImportLines(raw) {
  const lines = String(raw || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const valid = [];
  let invalidLines = 0;

  for (const line of lines) {
    const parts = line.split('|').map((part) => part.trim());
    if (parts.length < 4) {
      invalidLines += 1;
      continue;
    }

    const [email, password, refreshToken, clientId] = parts;
    if (!EMAIL_PATTERN.test(email) || !refreshToken || !clientId) {
      invalidLines += 1;
      continue;
    }

    valid.push({
      email,
      password,
      refreshToken,
      clientId
    });
  }

  return { valid, invalidLines };
}

function publicAccount(account) {
  return {
    id: account.id,
    email: account.email,
    provider: account.provider,
    receiverPage: normalizeReceiverPage(account.receiverPage),
    providerLabel: 'Microsoft / Outlook OAuth',
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    lastSyncAt: account.lastSyncAt,
    lastError: account.lastError || null,
    fetchedCount: account.fetchedCount || 0
  };
}

function publicMessage(message, accountMap) {
  const account = accountMap.get(message.accountId);
  return {
    ...message,
    providerLabel: 'Microsoft Graph',
    accountEmail: account?.email || '未知邮箱',
    receiverPage: normalizeReceiverPage(account?.receiverPage)
  };
}

function bootstrapPayload() {
  const accounts = state.accounts.map(publicAccount);
  const accountMap = new Map(state.accounts.map((account) => [account.id, account]));
  const messages = state.messages
    .map((message) => publicMessage(message, accountMap))
    .sort((a, b) => new Date(b.receivedDateTime || 0) - new Date(a.receivedDateTime || 0));

  const pageNumbers = new Set([
    1,
    2,
    ...accounts.map((account) => normalizeReceiverPage(account.receiverPage))
  ]);
  const pages = [...pageNumbers].sort((a, b) => a - b).map((page) => {
    const pageAccounts = accounts.filter((account) => account.receiverPage === page);
    const pageMessages = messages.filter((message) => message.receiverPage === page);
    return {
      page,
      label: `接收器 ${page}`,
      accounts: pageAccounts.length,
      unread: pageMessages.filter((message) => !message.isRead).length,
      totalMessages: pageMessages.length,
      syncing: Boolean(state.runtime.syncing && state.runtime.syncingPage === page)
    };
  });

  return {
    accounts,
    messages,
    pages,
    stats: {
      accounts: accounts.length,
      unread: messages.filter((message) => !message.isRead).length,
      totalMessages: messages.length,
      syncing: Boolean(state.runtime.syncing),
      syncingPage: state.runtime.syncingPage,
      pollIntervalMs: null
    }
  };
}

function upsertImportedAccount(input) {
  const receiverPage = normalizeReceiverPage(input.receiverPage);
  const existing = state.accounts.find(
    (account) =>
      account.email.toLowerCase() === input.email.toLowerCase() &&
      decryptString(account.clientIdEncrypted) === input.clientId
  );

  const stamp = now();
  if (existing) {
    existing.passwordEncrypted = encryptString(input.password);
    existing.refreshTokenEncrypted = encryptString(input.refreshToken);
    existing.clientIdEncrypted = encryptString(input.clientId);
    existing.receiverPage = receiverPage;
    existing.updatedAt = stamp;
    existing.lastError = null;
    return existing;
  }

  const account = {
    id: crypto.randomUUID(),
    email: input.email,
    provider: 'microsoft',
    receiverPage,
    passwordEncrypted: encryptString(input.password),
    refreshTokenEncrypted: encryptString(input.refreshToken),
    clientIdEncrypted: encryptString(input.clientId),
    createdAt: stamp,
    updatedAt: stamp,
    lastSyncAt: null,
    lastError: null,
    fetchedCount: 0
  };

  state.accounts.push(account);
  return account;
}

async function exchangeRefreshToken(account) {
  const clientId = decryptString(account.clientIdEncrypted);
  const refreshToken = decryptString(account.refreshTokenEncrypted);
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: GRAPH_SCOPE
  });

  const { response, payload } = await fetchJsonWithTimeout(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });

  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || '刷新访问令牌失败');
  }

  if (payload.refresh_token) {
    account.refreshTokenEncrypted = encryptString(payload.refresh_token);
  }

  return payload.access_token;
}

async function fetchInboxMessages(accessToken) {
  const params = new URLSearchParams({
    '$select': 'id,subject,from,receivedDateTime,isRead,bodyPreview,internetMessageId',
    '$orderby': 'receivedDateTime desc',
    '$top': String(MESSAGES_PER_ACCOUNT)
  });

  const { response, payload } = await fetchJsonWithTimeout(
    `${GRAPH_MESSAGES_ENDPOINT}?${params.toString()}`,
    {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Prefer: 'outlook.body-content-type="text"'
    }
    }
  );

  if (!response.ok) {
    throw new Error(payload.error?.message || '读取收件箱失败');
  }

  return Array.isArray(payload.value) ? payload.value : [];
}

async function fetchAccountHistory(account, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 1000);
  const accessToken = await exchangeRefreshToken(account);

  const pageSize = Math.min(50, limit);
  const params = new URLSearchParams({
    '$select': 'id,subject,from,receivedDateTime,isRead,bodyPreview,internetMessageId',
    '$orderby': 'receivedDateTime desc',
    '$top': String(pageSize)
  });

  let url = `${GRAPH_MESSAGES_ENDPOINT}?${params.toString()}`;
  const collected = [];

  while (url && collected.length < limit) {
    const { response, payload } = await fetchJsonWithTimeout(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Prefer: 'outlook.body-content-type="text"'
      }
    });

    if (!response.ok) {
      throw new Error(payload.error?.message || '读取历史邮件失败');
    }

    const items = Array.isArray(payload.value) ? payload.value : [];
    collected.push(...items);

    if (items.length === 0) break;
    url = payload['@odata.nextLink'] || null;
  }

  return collected.slice(0, limit).map((item) => ({
    id: item.id,
    providerMessageId: item.id,
    accountId: account.id,
    accountEmail: account.email,
    internetMessageId: item.internetMessageId || '',
    subject: item.subject || '',
    fromName: item.from?.emailAddress?.name || '',
    fromAddress: item.from?.emailAddress?.address || '',
    receivedDateTime: item.receivedDateTime || null,
    isRead: Boolean(item.isRead),
    bodyPreview: item.bodyPreview || '',
    providerLabel: 'Microsoft Graph'
  }));
}

function mergeMessages(account, graphMessages) {
  const previousMessages = state.messages.filter((message) => message.accountId === account.id);
  const previousIds = new Set(previousMessages.map((message) => message.providerMessageId));
  const nextMessages = [];
  let inserted = 0;

  for (const item of graphMessages.slice(0, MESSAGES_PER_ACCOUNT)) {
    const providerMessageId = item.id;
    if (!providerMessageId) continue;
    if (!previousIds.has(providerMessageId)) inserted += 1;

    const previous = previousMessages.find(
      (message) => message.providerMessageId === providerMessageId
    );

    nextMessages.push({
      id: previous?.id || crypto.randomUUID(),
      accountId: account.id,
      providerMessageId,
      internetMessageId: item.internetMessageId || '',
      subject: item.subject || '',
      fromName: item.from?.emailAddress?.name || '',
      fromAddress: item.from?.emailAddress?.address || '',
      receivedDateTime: item.receivedDateTime || null,
      isRead: Boolean(previous?.isRead || item.isRead),
      readAt: previous?.readAt || null,
      bodyPreview: item.bodyPreview || '',
      firstSeenAt: previous?.firstSeenAt || now()
    });
  }

  state.messages = state.messages.filter((message) => message.accountId !== account.id);
  state.messages.push(...nextMessages);
  state.messages.sort(
    (a, b) => new Date(b.receivedDateTime || 0) - new Date(a.receivedDateTime || 0)
  );
  state.messages = state.messages.slice(0, MAX_MESSAGES);
  return inserted;
}

async function syncAccount(account) {
  try {
    const accessToken = await exchangeRefreshToken(account);
    const messages = await fetchInboxMessages(accessToken);
    const inserted = mergeMessages(account, messages);
    account.lastSyncAt = now();
    account.updatedAt = account.lastSyncAt;
    account.lastError = null;
    account.fetchedCount = (account.fetchedCount || 0) + inserted;
    return { accountId: account.id, inserted, ok: true };
  } catch (error) {
    account.lastError = error.message;
    account.updatedAt = now();
    return { accountId: account.id, inserted: 0, ok: false, error: error.message };
  }
}

async function runSyncCycle(options = {}) {
  if (syncPromise) return syncPromise;
  const requestedPage =
    options.receiverPage === undefined ? null : normalizeReceiverPage(options.receiverPage);
  const accountsToSync =
    requestedPage === null
      ? state.accounts
      : state.accounts.filter(
          (account) => normalizeReceiverPage(account.receiverPage) === requestedPage
        );

  syncPromise = (async () => {
    state.runtime.syncing = true;
    state.runtime.syncingPage = requestedPage;
    state.runtime.lastPollStartedAt = now();
    await saveState();

    const results = [];
    for (let index = 0; index < accountsToSync.length; index += SYNC_CONCURRENCY) {
      const batch = accountsToSync.slice(index, index + SYNC_CONCURRENCY);
      results.push(...(await Promise.all(batch.map((account) => syncAccount(account)))));
      await saveState();
    }

    state.runtime.syncing = false;
    state.runtime.syncingPage = null;
    state.runtime.lastPollFinishedAt = now();
    await saveState();
    return results;
  })();

  try {
    return await syncPromise;
  } finally {
    syncPromise = null;
  }
}

app.get('/api/health', (_request, response) => {
  response.json({
    ok: true,
    accounts: state.accounts.length,
    messages: state.messages.length,
    syncing: Boolean(state.runtime.syncing)
  });
});

app.get('/api/bootstrap', (_request, response) => {
  response.json(bootstrapPayload());
});

app.post('/api/accounts/import', async (request, response) => {
  const { valid, invalidLines } = parseImportLines(request.body?.raw);
  const receiverPage = normalizeReceiverPage(request.body?.receiverPage);
  if (valid.length === 0) {
    response.status(400).json({ error: '没有可导入的有效账户行' });
    return;
  }

  for (const account of valid) {
    upsertImportedAccount({ ...account, receiverPage });
  }

  await saveState();
  response.json({
    upserted: valid.length,
    invalidLines,
    receiverPage
  });
});

app.delete('/api/accounts/:accountId', async (request, response) => {
  const { accountId } = request.params;
  const before = state.accounts.length;
  state.accounts = state.accounts.filter((account) => account.id !== accountId);
  state.messages = state.messages.filter((message) => message.accountId !== accountId);

  if (state.accounts.length === before) {
    response.status(404).json({ error: '账户不存在' });
    return;
  }

  await saveState();
  response.json({ ok: true });
});

app.post('/api/sync', async (request, response) => {
  const results = await runSyncCycle({ receiverPage: request.body?.receiverPage });
  const successful = results.filter((result) => result.ok);
  const inserted = successful.reduce((sum, result) => sum + result.inserted, 0);
  const failed = results.length - successful.length;

  response.json({
    ok: failed === 0,
    message:
      results.length === 0
        ? '当前还没有可同步的账户'
        : failed
          ? `同步完成，新增 ${inserted} 封，${failed} 个账户失败`
          : `同步完成，新增 ${inserted} 封邮件`
  });
});

app.post('/api/messages/:messageId/read', async (request, response) => {
  const { messageId } = request.params;
  const message = state.messages.find((item) => item.id === messageId);

  if (!message) {
    response.status(404).json({ error: '邮件不存在' });
    return;
  }

  message.isRead = true;
  message.readAt = message.readAt || now();
  await saveState();
  response.json(bootstrapPayload());
});

app.get('/api/accounts/:accountId/history', async (request, response) => {
  const { accountId } = request.params;
  const account = state.accounts.find((item) => item.id === accountId);
  if (!account) {
    response.status(404).json({ error: '账户不存在' });
    return;
  }

  const limit = Number(request.query.limit) || 100;

  try {
    const messages = await fetchAccountHistory(account, { limit });
    await saveState();
    response.json({
      accountId,
      accountEmail: account.email,
      count: messages.length,
      messages
    });
  } catch (error) {
    response.status(502).json({ error: error.message || '历史邮件读取失败' });
  }
});

await ensureStorage();

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Mail Collector API listening on http://127.0.0.1:${PORT}`);
});
