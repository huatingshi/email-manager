const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export const TIME_RANGES = [
  { value: 'any', label: '全部时间', ms: null },
  { value: '1h', label: '1 小时内', ms: HOUR },
  { value: '24h', label: '24 小时内', ms: DAY },
  { value: '7d', label: '7 天内', ms: 7 * DAY }
];

export const SORT_OPTIONS = [
  { value: 'recent', label: '最新邮件在前' },
  { value: 'email', label: '按邮箱地址' },
  { value: 'imported', label: '按导入顺序' }
];

export function cx(...names) {
  return names.filter(Boolean).join(' ');
}

export function toTime(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

const pad = (value) => String(value).padStart(2, '0');
const clock = (date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;

function startOfDay(time) {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

// Compact timestamp for list rows: 刚刚 / 5 分钟前 / 14:02 / 昨天 09:15 / 周三 / 9月3日
export function formatListTime(value, now) {
  const time = toTime(value);
  if (time === null) return '';
  const elapsed = now - time;
  if (elapsed < MINUTE) return '刚刚';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} 分钟前`;

  const date = new Date(time);
  const today = startOfDay(now);
  if (time >= today) return clock(date);
  if (time >= today - DAY) return `昨天 ${clock(date)}`;
  if (time >= today - 6 * DAY) return WEEKDAYS[date.getDay()];
  if (date.getFullYear() === new Date(now).getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

// 刚刚 / 5 分钟前 / 3 小时前 / 2 天前; empty once it's more than 30 days old.
export function formatAgo(value, now) {
  const time = toTime(value);
  if (time === null) return '';
  const elapsed = now - time;
  if (elapsed < MINUTE) return '刚刚';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} 分钟前`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} 小时前`;
  if (elapsed < 30 * DAY) return `${Math.floor(elapsed / DAY)} 天前`;
  return '';
}

export function formatRelative(value, now) {
  return formatAgo(value, now) || formatListTime(value, now);
}

export function formatFullTime(value) {
  const time = toTime(value);
  if (time === null) return '时间未知';
  const date = new Date(time);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${WEEKDAYS[date.getDay()]} ${clock(date)}`;
}

export function splitEmail(email = '') {
  const at = email.lastIndexOf('@');
  return at > 0 ? [email.slice(0, at), email.slice(at)] : [email, ''];
}

export function hueFor(text = '') {
  let hash = 0;
  for (const char of text.toLowerCase()) {
    hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  }
  return hash % 360;
}

export function initialFor(text = '') {
  const first = [...text.trim()][0];
  return first ? first.toUpperCase() : '?';
}

export function isUnread(account) {
  return Boolean(account.latest && !account.latest.isRead);
}

export function summarize(accounts) {
  let unread = 0;
  let failed = 0;
  let lastSyncAt = 0;
  for (const account of accounts) {
    if (isUnread(account)) unread += 1;
    if (account.lastError) failed += 1;
    lastSyncAt = Math.max(lastSyncAt, toTime(account.lastSyncAt) ?? 0);
  }
  return { accounts: accounts.length, unread, failed, lastSyncAt: lastSyncAt || null };
}

export function matchesQuery(account, needle) {
  if (!needle) return true;
  const { latest } = account;
  return [account.email, latest?.fromName, latest?.fromAddress, latest?.subject, latest?.bodyPreview].some(
    (value) => value && value.toLowerCase().includes(needle)
  );
}

export function sortAccounts(accounts, sort, importOrder) {
  const byImport = (a, b) => importOrder.get(a.id) - importOrder.get(b.id);
  const sorted = [...accounts];
  if (sort === 'email') {
    sorted.sort((a, b) => a.email.localeCompare(b.email) || byImport(a, b));
  } else if (sort === 'imported') {
    sorted.sort(byImport);
  } else {
    // Newest mail first; mailboxes without mail sink to the bottom in import order.
    const received = (account) => toTime(account.latest?.receivedDateTime) ?? -1;
    sorted.sort((a, b) => received(b) - received(a) || byImport(a, b));
  }
  return sorted;
}
