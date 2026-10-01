import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { WifiOff } from 'lucide-react';
import { api } from './api.js';
import {
  SORT_OPTIONS,
  TIME_RANGES,
  cx,
  isUnread,
  matchesQuery,
  sortAccounts,
  summarize,
  toTime
} from './format.js';
import { useNow, usePageVisible, usePersistentState } from './hooks.js';
import { ConfirmDialog, ImportDialog } from './components/Dialogs.jsx';
import { MailboxList } from './components/MailboxList.jsx';
import { ReadingPane } from './components/ReadingPane.jsx';
import { Sidebar } from './components/Sidebar.jsx';
import { Toasts, useToasts } from './components/Toasts.jsx';

const IDLE_POLL_MS = 15_000;
const BUSY_POLL_MS = 1_000;
const MARK_READ_DELAY_MS = 600;

function scopeKey(scope) {
  if (scope.accountId) return `account:${scope.accountId}`;
  if (scope.receiverPage) return `page:${scope.receiverPage}`;
  return 'all';
}

function scopeForView(view) {
  return view === 'all' ? {} : { receiverPage: view };
}

function withMessagesRead(snapshot, shouldMark) {
  if (!snapshot) return snapshot;
  return {
    ...snapshot,
    accounts: snapshot.accounts.map((account) =>
      isUnread(account) && shouldMark(account)
        ? { ...account, latest: { ...account.latest, isRead: true } }
        : account
    )
  };
}

export function App() {
  const [snapshot, setSnapshot] = useState(null);
  const [connectionLost, setConnectionLost] = useState(false);
  const [storedView, setStoredView] = usePersistentState('mail-collector:view', 'all');
  const [storedTimeRange, setTimeRange] = usePersistentState('mail-collector:time-range', 'any');
  const [storedSort, setSort] = usePersistentState('mail-collector:sort', 'recent');
  const [compact, setCompact] = usePersistentState('mail-collector:compact', false);
  const [bodyMode, setBodyMode] = usePersistentState('mail-collector:body-mode', 'text');
  const [selectedId, setSelectedId] = useState(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [pendingSyncs, setPendingSyncs] = useState([]);
  const [fullMessages, setFullMessages] = useState({});
  const [histories, setHistories] = useState({});
  const [historyMessage, setHistoryMessage] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [importDraft, setImportDraft] = useState('');
  const { toasts, push: notify, dismiss: dismissToast } = useToasts();
  const now = useNow(30_000);
  const pageVisible = usePageVisible();
  const searchRef = useRef(null);
  const refreshSeq = useRef(0);
  const kickPoll = useRef(() => {});
  const busyRef = useRef(false);
  const fullMessagesRef = useRef(fullMessages);

  // ---- server state -------------------------------------------------------

  // Only the newest request may apply its response, so a slow poll can't
  // overwrite an optimistic update made after it started.
  const refresh = useCallback(async () => {
    const seq = ++refreshSeq.current;
    try {
      const data = await api('/bootstrap');
      if (seq !== refreshSeq.current) return;
      setSnapshot(data);
      setConnectionLost(false);
    } catch {
      if (seq === refreshSeq.current) setConnectionLost(true);
    }
  }, []);

  const busy = pendingSyncs.length > 0 || Boolean(snapshot?.syncJobs?.length);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    fullMessagesRef.current = fullMessages;
  }, [fullMessages]);

  // Poll quickly while a sync runs so rows update live, slowly otherwise.
  useEffect(() => {
    let cancelled = false;
    let timer;
    const tick = async () => {
      window.clearTimeout(timer);
      if (!document.hidden) await refresh();
      if (cancelled) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(tick, busyRef.current ? BUSY_POLL_MS : IDLE_POLL_MS);
    };
    kickPoll.current = (delayMs = 0) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(tick, delayMs);
    };
    const refreshWhenShown = () => {
      if (!document.hidden) kickPoll.current(0);
    };
    tick();
    document.addEventListener('visibilitychange', refreshWhenShown);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', refreshWhenShown);
    };
  }, [refresh]);

  // ---- derived data -------------------------------------------------------

  const accounts = useMemo(() => snapshot?.accounts ?? [], [snapshot]);
  const pages = useMemo(() => snapshot?.pages ?? [1, 2], [snapshot]);
  const jobs = useMemo(() => snapshot?.syncJobs ?? [], [snapshot]);
  const view = storedView === 'all' || pages.includes(storedView) ? storedView : 'all';
  const timeRange = TIME_RANGES.some((range) => range.value === storedTimeRange) ? storedTimeRange : 'any';
  const sort = SORT_OPTIONS.some((option) => option.value === storedSort) ? storedSort : 'recent';

  const importOrder = useMemo(() => new Map(accounts.map((account, index) => [account.id, index])), [accounts]);
  const totals = useMemo(() => summarize(accounts), [accounts]);
  const groups = useMemo(
    () =>
      pages.map((page) => ({
        page,
        label: `接收器 ${page}`,
        ...summarize(accounts.filter((account) => account.receiverPage === page))
      })),
    [accounts, pages]
  );
  const viewAccounts = useMemo(
    () => (view === 'all' ? accounts : accounts.filter((account) => account.receiverPage === view)),
    [accounts, view]
  );
  const viewSummary = useMemo(() => summarize(viewAccounts), [viewAccounts]);

  const visibleAccounts = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const windowMs = TIME_RANGES.find((range) => range.value === timeRange)?.ms;
    const matches = viewAccounts.filter((account) => {
      if (!matchesQuery(account, needle)) return false;
      // The open mailbox stays put when it stops matching, e.g. after it was read.
      if (account.id === selectedId) return true;
      if (filter === 'unread' && !isUnread(account)) return false;
      if (filter === 'failed' && !account.lastError) return false;
      if (windowMs) {
        const received = toTime(account.latest?.receivedDateTime);
        if (received === null || now - received > windowMs) return false;
      }
      return true;
    });
    return sortAccounts(matches, sort, importOrder);
  }, [viewAccounts, query, filter, timeRange, sort, selectedId, now, importOrder]);

  const selectedAccount = useMemo(
    () => accounts.find((account) => account.id === selectedId) ?? null,
    [accounts, selectedId]
  );
  const viewingHistory = historyMessage?.accountId === selectedId ? historyMessage.message : null;
  const displayedMessage = viewingHistory ?? selectedAccount?.latest ?? null;
  const displayedKey =
    selectedAccount && displayedMessage ? `${selectedAccount.id}:${displayedMessage.providerMessageId}` : null;

  // Sync state for the current view and for each sidebar entry.
  const coversView = (job, target) =>
    job.scope.type === 'all' || (target !== 'all' && job.scope.type === 'page' && job.scope.page === target);
  const isSyncing = useCallback(
    (target) =>
      pendingSyncs.includes('all') ||
      (target !== 'all' && pendingSyncs.includes(`page:${target}`)) ||
      jobs.some((job) => coversView(job, target)),
    [pendingSyncs, jobs]
  );
  const viewJob =
    jobs.find((job) =>
      view === 'all' ? job.scope.type === 'all' : job.scope.type === 'page' && job.scope.page === view
    ) ?? jobs.find((job) => job.scope.type === 'all');
  const viewSyncing = isSyncing(view);
  const sync = {
    active: viewSyncing,
    done: viewSyncing ? viewJob?.done ?? 0 : 0,
    total: viewSyncing ? viewJob?.total ?? 0 : 0,
    label: view === 'all' ? '读取全部' : '读取本组'
  };
  const refreshingSelected = Boolean(
    selectedAccount &&
      (selectedAccount.syncState === 'running' || pendingSyncs.includes(`account:${selectedAccount.id}`))
  );

  // ---- actions ------------------------------------------------------------

  const markRead = useCallback(
    async (messageId) => {
      refreshSeq.current += 1;
      setSnapshot((current) => withMessagesRead(current, (account) => account.latest.id === messageId));
      try {
        await api(`/messages/${messageId}/read`, { method: 'POST' });
      } catch (error) {
        notify(error.message, 'error');
      }
      refresh();
    },
    [notify, refresh]
  );

  const loadFullMessage = useCallback(async (accountId, providerMessageId, { force = false } = {}) => {
    const key = `${accountId}:${providerMessageId}`;
    const current = fullMessagesRef.current[key];
    if (!force && current && current.status !== 'error') return;

    const setEntry = (entry) => {
      fullMessagesRef.current = { ...fullMessagesRef.current, [key]: entry };
      setFullMessages((all) => ({ ...all, [key]: entry }));
    };
    setEntry({ status: 'loading' });
    try {
      const data = await api(`/accounts/${accountId}/messages/${encodeURIComponent(providerMessageId)}`);
      setEntry({ status: 'loaded', data });
    } catch (error) {
      setEntry({ status: 'error', error: error.message });
    }
  }, []);

  const loadHistory = useCallback(async (accountId, folder) => {
    const key = `${accountId}:${folder}`;
    setHistories((all) => ({ ...all, [key]: { ...all[key], status: 'loading' } }));
    try {
      const result = await api(`/accounts/${accountId}/history?folder=${folder}&limit=30`);
      setHistories((all) => ({ ...all, [key]: { status: 'loaded', messages: result.messages } }));
    } catch (error) {
      setHistories((all) => ({ ...all, [key]: { ...all[key], status: 'error', error: error.message } }));
    }
  }, []);

  const startSync = useCallback(
    async (scope, label) => {
      const key = scopeKey(scope);
      setPendingSyncs((current) => [...current, key]);
      kickPoll.current(250);
      try {
        const result = await api('/sync', { method: 'POST', body: scope });
        const tone = result.failed ? 'warning' : result.inserted ? 'success' : 'info';
        notify(label ? `${label}：${result.message}` : result.message, tone);
      } catch (error) {
        notify(error.message, 'error');
      } finally {
        setPendingSyncs((current) => {
          const index = current.indexOf(key);
          return index === -1 ? current : [...current.slice(0, index), ...current.slice(index + 1)];
        });
        refresh();
      }
    },
    [notify, refresh]
  );

  const refreshAccount = useCallback(
    (account) => {
      // Its history may have changed too; drop the cached lists.
      setHistories((all) =>
        Object.fromEntries(Object.entries(all).filter(([key]) => !key.startsWith(`${account.id}:`)))
      );
      startSync({ accountId: account.id }, account.email);
    },
    [startSync]
  );

  const selectAccount = useCallback((accountId) => {
    setSelectedId(accountId);
    setHistoryMessage(null);
  }, []);

  const changeView = useCallback(
    (nextView) => {
      setStoredView(nextView);
      if (nextView === 'all') return;
      setSelectedId((current) => {
        const account = accounts.find((item) => item.id === current);
        return account?.receiverPage === nextView ? current : null;
      });
    },
    [accounts, setStoredView]
  );

  const moveSelection = useCallback(
    (delta) => {
      if (!visibleAccounts.length) return;
      const index = visibleAccounts.findIndex((account) => account.id === selectedId);
      const next =
        index === -1
          ? delta > 0
            ? 0
            : visibleAccounts.length - 1
          : Math.min(Math.max(index + delta, 0), visibleAccounts.length - 1);
      selectAccount(visibleAccounts[next].id);
    },
    [visibleAccounts, selectedId, selectAccount]
  );

  const copyText = useCallback(
    async (text, successMessage) => {
      try {
        await navigator.clipboard.writeText(text);
        notify(successMessage, 'success', 1600);
      } catch {
        notify('复制失败，请手动选择文字复制', 'error');
      }
    },
    [notify]
  );

  const openHistoryMessage = useCallback(
    (message) => {
      if (!selectedAccount) return;
      const isLatest = message.providerMessageId === selectedAccount.latest?.providerMessageId;
      setHistoryMessage(isLatest ? null : { accountId: selectedAccount.id, message });
      document.querySelector('.reader-scroll')?.scrollTo({ top: 0, behavior: 'smooth' });
    },
    [selectedAccount]
  );

  const importAccounts = useCallback(
    async (raw, receiverPage) => {
      const result = await api('/accounts/import', { method: 'POST', body: { raw, receiverPage } });
      const parts = [];
      if (result.added) parts.push(`新增 ${result.added} 个`);
      if (result.updated) parts.push(`更新 ${result.updated} 个`);
      notify(`已导入到接收器 ${result.receiverPage}：${parts.join('，')}`, 'success');
      setStoredView(result.receiverPage);
      setSelectedId(null);
      await refresh();
      return result;
    },
    [notify, refresh, setStoredView]
  );

  const requestDelete = useCallback(
    (account) => {
      const index = visibleAccounts.findIndex((item) => item.id === account.id);
      const neighbor = visibleAccounts[index + 1] ?? visibleAccounts[index - 1] ?? null;
      setDialog({
        type: 'confirm',
        title: '删除这个邮箱？',
        message: `${account.email} 的凭据和本地记录都会被删除，之后需要重新导入才能恢复。`,
        confirmLabel: '删除',
        danger: true,
        onConfirm: async () => {
          await api(`/accounts/${account.id}`, { method: 'DELETE' });
          notify(`已删除 ${account.email}`, 'success');
          setSelectedId((current) => (current === account.id ? neighbor?.id ?? null : current));
          setHistoryMessage(null);
          await refresh();
        }
      });
    },
    [visibleAccounts, notify, refresh]
  );

  const requestDeleteFailed = useCallback(() => {
    const failed = viewAccounts.filter((account) => account.lastError);
    if (!failed.length) return;
    setDialog({
      type: 'confirm',
      title: `删除 ${failed.length} 个读取失败的邮箱？`,
      message: '这些邮箱最近一次读取失败（例如授权已失效）。删除后需要重新导入才能恢复。',
      items: failed.map((account) => account.email),
      confirmLabel: `删除 ${failed.length} 个`,
      danger: true,
      onConfirm: async () => {
        const result = await api('/accounts/delete', {
          method: 'POST',
          body: { ids: failed.map((account) => account.id) }
        });
        notify(`已删除 ${result.removed} 个邮箱`, 'success');
        await refresh();
      }
    });
  }, [viewAccounts, notify, refresh]);

  const markAllRead = useCallback(async () => {
    const unreadIds = new Set(viewAccounts.filter(isUnread).map((account) => account.id));
    if (!unreadIds.size) return;
    refreshSeq.current += 1;
    setSnapshot((current) => withMessagesRead(current, (account) => unreadIds.has(account.id)));
    try {
      const result = await api('/messages/read-all', { method: 'POST', body: scopeForView(view) });
      notify(`已将 ${result.count} 封邮件标为已读`, 'success');
    } catch (error) {
      notify(error.message, 'error');
    }
    refresh();
  }, [viewAccounts, view, notify, refresh]);

  const resetFilters = useCallback(() => {
    setQuery('');
    setFilter('all');
    setTimeRange('any');
  }, [setTimeRange]);

  const showFailed = useCallback(() => {
    changeView('all');
    setQuery('');
    setFilter('failed');
  }, [changeView]);

  const openImport = useCallback(() => setDialog({ type: 'import' }), []);
  const closeDialog = useCallback(() => setDialog(null), []);

  // ---- effects tied to the open message -----------------------------------

  useEffect(() => {
    if (snapshot && selectedId && !selectedAccount) setSelectedId(null);
  }, [snapshot, selectedId, selectedAccount]);

  // The latest message counts as read once it has been on screen briefly, so
  // arrowing quickly past a mailbox doesn't mark it read.
  const latestId = selectedAccount?.latest?.id;
  const latestIsRead = selectedAccount?.latest?.isRead;
  useEffect(() => {
    if (!latestId || latestIsRead || viewingHistory || !pageVisible) return undefined;
    const timer = window.setTimeout(() => markRead(latestId), MARK_READ_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [latestId, latestIsRead, viewingHistory, pageVisible, markRead]);

  useEffect(() => {
    if (!displayedKey) return undefined;
    const separator = displayedKey.indexOf(':');
    const accountId = displayedKey.slice(0, separator);
    const providerMessageId = displayedKey.slice(separator + 1);
    const timer = window.setTimeout(() => loadFullMessage(accountId, providerMessageId), 120);
    return () => window.clearTimeout(timer);
  }, [displayedKey, loadFullMessage]);

  useEffect(() => {
    if (!selectedId) return;
    document
      .querySelector(`[data-account-id="${CSS.escape(selectedId)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  useEffect(() => {
    document.title = totals.unread ? `(${totals.unread}) Mail Collector` : 'Mail Collector';
  }, [totals.unread]);

  // Keyboard: ↑/↓ (or j/k) move through the list, / or Ctrl+K search, Esc leaves search.
  useEffect(() => {
    const onKeyDown = (event) => {
      if (dialog || event.defaultPrevented) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      const inSearch = target === searchRef.current;
      const editing =
        Boolean(target) && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

      if ((event.key === '/' && !editing) || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k')) {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (inSearch && event.key === 'Escape') {
        if (query) setQuery('');
        else searchRef.current.blur();
        return;
      }
      if ((editing && !inSearch) || target?.closest('.menu') || event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }
      if (event.key === 'ArrowDown' || (!editing && event.key === 'j')) {
        event.preventDefault();
        moveSelection(1);
      } else if (event.key === 'ArrowUp' || (!editing && event.key === 'k')) {
        event.preventDefault();
        moveSelection(-1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dialog, query, moveSelection]);

  // ---- render -------------------------------------------------------------

  return (
    <div className={cx('app', selectedAccount && 'has-selection')}>
      <Sidebar
        view={view}
        onViewChange={changeView}
        totals={totals}
        groups={groups}
        isSyncing={isSyncing}
        onImport={openImport}
        onShowFailed={showFailed}
        now={now}
      />

      <MailboxList
        title={view === 'all' ? '全部邮箱' : `接收器 ${view}`}
        summary={viewSummary}
        accounts={visibleAccounts}
        loading={!snapshot}
        viewHasAccounts={viewAccounts.length > 0}
        selectedId={selectedId}
        onSelect={selectAccount}
        showGroup={view === 'all'}
        query={query}
        onQueryChange={setQuery}
        searchRef={searchRef}
        filter={filter}
        onFilterChange={setFilter}
        timeRange={timeRange}
        onTimeRangeChange={setTimeRange}
        sort={sort}
        onSortChange={setSort}
        compact={compact}
        onCompactChange={setCompact}
        sync={sync}
        onSync={() => startSync(scopeForView(view))}
        onMarkAllRead={markAllRead}
        onDeleteFailed={requestDeleteFailed}
        onImport={openImport}
        onResetFilters={resetFilters}
        now={now}
      />

      <ReadingPane
        account={selectedAccount}
        loading={!snapshot}
        hasAccounts={accounts.length > 0}
        message={displayedMessage}
        isHistory={Boolean(viewingHistory)}
        full={displayedKey ? fullMessages[displayedKey] : null}
        onRetryFull={() =>
          selectedAccount &&
          displayedMessage &&
          loadFullMessage(selectedAccount.id, displayedMessage.providerMessageId, { force: true })
        }
        onBackToLatest={() => setHistoryMessage(null)}
        onClose={() => setSelectedId(null)}
        refreshing={refreshingSelected}
        onRefresh={() => selectedAccount && refreshAccount(selectedAccount)}
        onCopy={copyText}
        onDelete={() => selectedAccount && requestDelete(selectedAccount)}
        onImport={openImport}
        bodyMode={bodyMode}
        onBodyModeChange={setBodyMode}
        histories={histories}
        onLoadHistory={loadHistory}
        onOpenHistory={openHistoryMessage}
        now={now}
      />

      {dialog?.type === 'import' ? (
        <ImportDialog
          pages={pages}
          initialPage={view === 'all' ? pages[0] : view}
          draft={importDraft}
          onDraftChange={setImportDraft}
          onImport={importAccounts}
          onClose={closeDialog}
        />
      ) : null}
      {dialog?.type === 'confirm' ? (
        <ConfirmDialog
          title={dialog.title}
          message={dialog.message}
          items={dialog.items}
          confirmLabel={dialog.confirmLabel}
          danger={dialog.danger}
          onConfirm={dialog.onConfirm}
          onClose={closeDialog}
        />
      ) : null}

      {connectionLost ? (
        <div className="connection-banner" role="alert">
          <WifiOff size={15} />
          与本地服务的连接断开了，正在重试…
        </div>
      ) : null}
      <Toasts toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
