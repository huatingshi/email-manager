import { useEffect, useMemo, useState } from 'react';
import {
  BookOpen,
  CircleAlert,
  CircleCheckBig,
  ExternalLink,
  Inbox,
  LoaderCircle,
  Mail,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  Upload
} from 'lucide-react';

const emptySnapshot = {
  accounts: [],
  messages: [],
  pages: [
    { page: 1, label: '接收器 1', accounts: 0, unread: 0, totalMessages: 0, syncing: false },
    { page: 2, label: '接收器 2', accounts: 0, unread: 0, totalMessages: 0, syncing: false }
  ],
  stats: {
    accounts: 0,
    unread: 0,
    totalMessages: 0,
    syncing: false,
    syncingPage: null,
    pollIntervalMs: null
  }
};

const TIME_RANGES = [
  { key: 'hour', label: '最近一小时', hours: 1 },
  { key: 'day', label: '最近一天', hours: 24 },
  { key: 'week', label: '最近七天', hours: 24 * 7 },
  { key: 'forever', label: '永久', hours: null }
];

function formatDate(value) {
  if (!value) return '尚未读取';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

function isMessageInsideRange(message, rangeKey) {
  const range = TIME_RANGES.find((item) => item.key === rangeKey) ?? TIME_RANGES.at(-1);
  if (!range.hours) return true;
  if (!message.receivedDateTime) return false;
  const receivedAt = new Date(message.receivedDateTime).getTime();
  if (!Number.isFinite(receivedAt)) return false;
  return Date.now() - receivedAt <= range.hours * 60 * 60 * 1000;
}

function toneForAccount(account) {
  if (account.lastError) return 'danger';
  if (account.lastSyncAt) return 'success';
  return 'muted';
}

function AppHeader({ stats, onSyncAll, syncing }) {
  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark">
          <BookOpen size={23} />
        </div>
        <div>
          <h1>Mail Collector</h1>
          <p>双页并行接收器</p>
        </div>
      </div>

      <div className="top-actions">
        <div className="stat-pill">
          <ShieldCheck size={16} />
          <span>{stats.accounts} 个邮箱</span>
        </div>
        <div className="stat-pill">
          <Mail size={16} />
          <span>{stats.totalMessages} 封最新邮件</span>
        </div>
        <div className="stat-pill unread">
          <CircleAlert size={16} />
          <span>{stats.unread} 未读</span>
        </div>
        <button className="primary-button" onClick={onSyncAll} disabled={syncing}>
          {syncing ? <LoaderCircle size={17} className="spin" /> : <RefreshCw size={17} />}
          <span>{syncing ? '读取中' : '读取全部'}</span>
        </button>
      </div>
    </header>
  );
}

function MiniImporter({ page, importing, onImport, notice }) {
  const [rawLines, setRawLines] = useState('');

  async function submit(event) {
    event.preventDefault();
    if (!rawLines.trim()) return;
    const success = await onImport(rawLines, page);
    if (success) setRawLines('');
  }

  return (
    <form className="page-importer" onSubmit={submit}>
      <label htmlFor={`credential-input-${page}`}>
        导入到第 {page} 页
      </label>
      <textarea
        id={`credential-input-${page}`}
        value={rawLines}
        onChange={(event) => setRawLines(event.target.value)}
        placeholder="邮箱 | 密码 | Refresh_token | Client_id"
        spellCheck="false"
      />
      <button className="ghost-button full-width" type="submit" disabled={importing}>
        {importing ? <LoaderCircle size={16} className="spin" /> : <Upload size={16} />}
        <span>{importing ? '导入中' : '导入本页'}</span>
      </button>
      {notice ? <div className={`notice ${notice.type}`}>{notice.text}</div> : null}
    </form>
  );
}

function AccountStack({ accounts, onDelete }) {
  if (accounts.length === 0) {
    return <div className="empty-compact">本页还没有邮箱</div>;
  }

  return (
    <div className="account-stack">
      {accounts.map((account) => (
        <article className="account-row compact" key={account.id}>
          <div className="account-main">
            <span className={`status-dot ${toneForAccount(account)}`} />
            <div>
              <strong>{account.email}</strong>
              <span>{account.lastError ? '读取失败' : account.lastSyncAt ? '已读取' : '待读取'}</span>
            </div>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={() => onDelete(account.id)}
            aria-label={`删除 ${account.email}`}
            title="删除账户"
          >
            <Trash2 size={15} />
          </button>
        </article>
      ))}
    </div>
  );
}

function MessageToolbar({ query, setQuery, unreadOnly, setUnreadOnly, total, shown }) {
  return (
    <div className="message-toolbar">
      <label className="search-box">
        <Search size={16} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索主题、发件人、邮箱"
        />
      </label>
      <button
        type="button"
        className={`toggle-button ${unreadOnly ? 'active' : ''}`}
        onClick={() => setUnreadOnly((value) => !value)}
      >
        <span>{unreadOnly ? '未读' : '全部'}</span>
      </button>
      <div className="toolbar-count">{shown} / {total}</div>
    </div>
  );
}

function TimeRangePicker({ value, onChange }) {
  return (
    <div className="time-filter" role="group" aria-label="邮件时间范围">
      {TIME_RANGES.map((range) => (
        <button
          key={range.key}
          type="button"
          className={`time-filter-button ${value === range.key ? 'active' : ''}`}
          onClick={() => onChange(range.key)}
        >
          {range.label}
        </button>
      ))}
    </div>
  );
}

function MessageList({ messages, selectedId, onSelect }) {
  if (messages.length === 0) {
    return (
      <div className="empty-state receiver-empty">
        <Inbox size={26} />
        <strong>暂无最新邮件</strong>
        <span>点击本页读取后，会显示每个邮箱最新一封。</span>
      </div>
    );
  }

  return (
    <div className="message-list receiver-message-list">
      {messages.map((message) => (
        <button
          className={`message-row ${selectedId === message.id ? 'selected' : ''}`}
          type="button"
          key={message.id}
          onClick={() => onSelect(message.id)}
        >
          <div className="message-topline">
            <strong>{message.subject || '(无主题)'}</strong>
            {!message.isRead ? <span className="unread-badge">未读</span> : null}
          </div>
          <div className="message-meta">
            <span>{message.fromName || message.fromAddress || '未知发件人'}</span>
            <span>{formatDate(message.receivedDateTime)}</span>
          </div>
          <p>{message.bodyPreview || '暂无正文预览'}</p>
          <small>{message.accountEmail}</small>
        </button>
      ))}
    </div>
  );
}

function MessagePreview({ message, fullMessage, fullLoading }) {
  if (!message) {
    return (
      <div className="receiver-preview blank">
        <Inbox size={22} />
        <span>选择邮件查看预览</span>
      </div>
    );
  }

  const previewText = fullMessage?.bodyText || message.bodyPreview || '当前邮件没有可用的正文预览。';
  const links = fullMessage?.links || [];

  return (
    <div className="receiver-preview">
      <div className="preview-head compact-preview-head">
        <div>
          <span className="eyeline">{message.accountEmail}</span>
          <h2>{message.subject || '(无主题)'}</h2>
        </div>
        {!message.isRead ? <span className="preview-unread">未读</span> : null}
      </div>
      <div className="preview-meta-grid compact-preview-meta">
        <div>
          <label>发件人</label>
          <strong>{message.fromName || '未知发件人'}</strong>
          <span>{message.fromAddress || '-'}</span>
        </div>
        <div>
          <label>时间</label>
          <strong>{formatDate(message.receivedDateTime)}</strong>
          <span>{message.providerLabel}</span>
        </div>
      </div>
      <div className="message-links">
        <div className="message-links-head">
          <strong>邮件链接</strong>
          {fullLoading ? <span>正在读取完整邮件...</span> : <span>{links.length} 个链接</span>}
        </div>
        {fullLoading ? (
          <div className="link-empty">正在提取邮件里的可点击链接</div>
        ) : links.length > 0 ? (
          <div className="link-list">
            {links.map((link) => (
              <a key={link.url} href={link.url} target="_blank" rel="noreferrer">
                <span>{link.label}</span>
                <ExternalLink size={14} />
              </a>
            ))}
          </div>
        ) : (
          <div className="link-empty">点开邮件后，如果完整正文里有链接，会显示在这里。</div>
        )}
      </div>
      <div className="preview-body compact-preview-body">
        {previewText}
      </div>
    </div>
  );
}

function ReceiverPage({
  page,
  pageStats,
  accounts,
  messages,
  selectedId,
  onOpenMessage,
  fullMessages,
  loadingFull,
  onSyncPage,
  onImport,
  onDelete,
  importing,
  notice
}) {
  const [query, setQuery] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [timeRange, setTimeRange] = useState('forever');

  const filteredMessages = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return messages.filter((message) => {
      const matchesUnread = unreadOnly ? !message.isRead : true;
      const matchesTime = isMessageInsideRange(message, timeRange);
      const haystack = [
        message.subject,
        message.fromName,
        message.fromAddress,
        message.accountEmail,
        message.bodyPreview
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      const matchesQuery = normalized ? haystack.includes(normalized) : true;
      return matchesUnread && matchesQuery && matchesTime;
    });
  }, [messages, query, timeRange, unreadOnly]);

  const selectedMessage =
    filteredMessages.find((message) => message.id === selectedId) ??
    filteredMessages[0] ??
    null;

  return (
    <section className={`book-page book-page-${page}`}>
      <div className="page-top">
        <div>
          <span className="page-number">Page {page}</span>
          <h2>{page === 1 ? '第一页接收器' : '第二页接收器'}</h2>
          <p>{accounts.length} 个邮箱，{messages.length} 封最新邮件</p>
        </div>
        <button
          className="primary-button"
          type="button"
          onClick={() => onSyncPage(page)}
          disabled={pageStats?.syncing}
        >
          {pageStats?.syncing ? <LoaderCircle size={17} className="spin" /> : <RefreshCw size={17} />}
          <span>{pageStats?.syncing ? '读取中' : '读取本页'}</span>
        </button>
      </div>

      <div className="page-metrics">
        <div>
          <strong>{accounts.length}</strong>
          <span>邮箱</span>
        </div>
        <div>
          <strong>{messages.length}</strong>
          <span>最新邮件</span>
        </div>
        <div className="danger-metric">
          <strong>{pageStats?.unread || 0}</strong>
          <span>未读</span>
        </div>
      </div>

      <MiniImporter
        page={page}
        importing={importing}
        onImport={onImport}
        notice={notice}
      />

      <div className="receiver-columns">
        <div className="receiver-left">
          <div className="mini-heading">
            <h3>本页邮箱</h3>
            <span>{accounts.length}</span>
          </div>
          <AccountStack accounts={accounts} onDelete={onDelete} />
        </div>

        <div className="receiver-right">
          <TimeRangePicker value={timeRange} onChange={setTimeRange} />
          <MessageToolbar
            query={query}
            setQuery={setQuery}
            unreadOnly={unreadOnly}
            setUnreadOnly={setUnreadOnly}
            total={messages.length}
            shown={filteredMessages.length}
          />
          <MessageList
            messages={filteredMessages}
            selectedId={selectedMessage?.id ?? null}
            onSelect={onOpenMessage}
          />
        </div>
      </div>

      <MessagePreview
        message={selectedMessage}
        fullMessage={selectedMessage ? fullMessages[selectedMessage.id] : null}
        fullLoading={selectedMessage ? Boolean(loadingFull[selectedMessage.id]) : false}
      />
    </section>
  );
}

export function App() {
  const [snapshot, setSnapshot] = useState(emptySnapshot);
  const [selectedByPage, setSelectedByPage] = useState({});
  const [syncingAll, setSyncingAll] = useState(false);
  const [importingPage, setImportingPage] = useState(null);
  const [notices, setNotices] = useState({});
  const [fullMessages, setFullMessages] = useState({});
  const [loadingFull, setLoadingFull] = useState({});

  async function refreshSnapshot() {
    const response = await fetch('/api/bootstrap');
    if (!response.ok) throw new Error('无法读取应用数据');
    const data = await response.json();
    setSnapshot(data);
    setSelectedByPage((current) => {
      const next = { ...current };
      for (const page of [1, 2]) {
        const pageMessages = data.messages.filter((message) => message.receiverPage === page);
        if (!pageMessages.some((message) => message.id === next[page])) {
          next[page] = pageMessages[0]?.id ?? null;
        }
      }
      return next;
    });
  }

  useEffect(() => {
    refreshSnapshot().catch((error) => {
      setNotices({ 1: { type: 'danger', text: error.message } });
    });

    const timer = window.setInterval(() => {
      refreshSnapshot().catch(() => {});
    }, 12000);

    return () => window.clearInterval(timer);
  }, []);

  async function syncPage(receiverPage) {
    setNotices((current) => ({ ...current, [receiverPage]: null }));
    try {
      const response = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ receiverPage })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '读取失败');
      setNotices((current) => ({
        ...current,
        [receiverPage]: { type: payload.ok ? 'success' : 'warning', text: payload.message }
      }));
      await refreshSnapshot();
    } catch (error) {
      setNotices((current) => ({
        ...current,
        [receiverPage]: { type: 'danger', text: error.message }
      }));
    }
  }

  async function syncAll() {
    setSyncingAll(true);
    setNotices({});
    try {
      const response = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '读取失败');
      setNotices({
        1: { type: payload.ok ? 'success' : 'warning', text: payload.message }
      });
      await refreshSnapshot();
    } catch (error) {
      setNotices({ 1: { type: 'danger', text: error.message } });
    } finally {
      setSyncingAll(false);
    }
  }

  async function importAccounts(raw, receiverPage) {
    setImportingPage(receiverPage);
    setNotices((current) => ({ ...current, [receiverPage]: null }));
    try {
      const response = await fetch('/api/accounts/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw, receiverPage })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '导入失败');
      setNotices((current) => ({
        ...current,
        [receiverPage]: {
          type: payload.invalidLines ? 'warning' : 'success',
          text: `已导入 ${payload.upserted} 个到第 ${receiverPage} 页${
            payload.invalidLines ? `，${payload.invalidLines} 行无效` : ''
          }`
        }
      }));
      await refreshSnapshot();
      return true;
    } catch (error) {
      setNotices((current) => ({
        ...current,
        [receiverPage]: { type: 'danger', text: error.message }
      }));
      return false;
    } finally {
      setImportingPage(null);
    }
  }

  async function deleteAccount(accountId) {
    try {
      const response = await fetch(`/api/accounts/${accountId}`, { method: 'DELETE' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '删除失败');
      await refreshSnapshot();
    } catch (error) {
      setNotices((current) => ({
        ...current,
        1: { type: 'danger', text: error.message }
      }));
    }
  }

  async function loadFullMessage(receiverPage, messageId) {
    if (fullMessages[messageId] || loadingFull[messageId]) return;
    setLoadingFull((current) => ({ ...current, [messageId]: true }));
    try {
      const response = await fetch(`/api/messages/${messageId}/full`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '完整邮件读取失败');
      setFullMessages((current) => ({ ...current, [messageId]: payload }));
    } catch (error) {
      setNotices((current) => ({
        ...current,
        [receiverPage]: { type: 'danger', text: error.message }
      }));
    } finally {
      setLoadingFull((current) => ({ ...current, [messageId]: false }));
    }
  }

  async function openMessage(receiverPage, messageId) {
    setSelectedByPage((current) => ({ ...current, [receiverPage]: messageId }));

    const message = snapshot.messages.find((item) => item.id === messageId);
    if (!message) return;

    if (!message.isRead) {
      setSnapshot((current) => ({
        ...current,
        messages: current.messages.map((item) =>
          item.id === messageId ? { ...item, isRead: true, readAt: new Date().toISOString() } : item
        )
      }));

      try {
        const response = await fetch(`/api/messages/${messageId}/read`, { method: 'POST' });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || '标记已读失败');
        setSnapshot(payload);
      } catch (error) {
        setNotices((current) => ({
          ...current,
          [receiverPage]: { type: 'danger', text: error.message }
        }));
        await refreshSnapshot();
      }
    }

    await loadFullMessage(receiverPage, messageId);
  }

  const pages = [1, 2].map((page) => {
    const accounts = snapshot.accounts.filter((account) => account.receiverPage === page);
    const messages = snapshot.messages.filter((message) => message.receiverPage === page);
    const pageStats =
      snapshot.pages.find((item) => item.page === page) ??
      emptySnapshot.pages.find((item) => item.page === page);
    return { page, accounts, messages, pageStats };
  });

  return (
    <main className="app-shell">
      <AppHeader
        stats={snapshot.stats}
        onSyncAll={syncAll}
        syncing={syncingAll || snapshot.stats.syncing}
      />

      <section className="book-spread">
        <div className="book-fold" />
        {pages.map(({ page, accounts, messages, pageStats }) => (
          <ReceiverPage
            key={page}
            page={page}
            pageStats={pageStats}
            accounts={accounts}
            messages={messages}
            selectedId={selectedByPage[page]}
            onOpenMessage={(messageId) => openMessage(page, messageId)}
            fullMessages={fullMessages}
            loadingFull={loadingFull}
            onSyncPage={syncPage}
            onImport={importAccounts}
            onDelete={deleteAccount}
            importing={importingPage === page}
            notice={notices[page]}
          />
        ))}
      </section>

      <footer className="footer-note">
        <CircleCheckBig size={16} />
        <span>手动读取模式。左右两页互相独立，每个邮箱只保留最新一封邮件。</span>
      </footer>
    </main>
  );
}
