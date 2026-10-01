import { memo } from 'react';
import {
  Ellipsis,
  Inbox,
  LoaderCircle,
  MailCheck,
  RefreshCw,
  Search,
  Trash2,
  TriangleAlert,
  Upload,
  X
} from 'lucide-react';
import {
  SORT_OPTIONS,
  TIME_RANGES,
  cx,
  formatListTime,
  formatRelative,
  isUnread,
  splitEmail
} from '../format.js';
import { Menu, Segmented } from './ui.jsx';

export function MailboxList({
  title,
  summary,
  accounts,
  loading,
  viewHasAccounts,
  selectedId,
  onSelect,
  showGroup,
  query,
  onQueryChange,
  searchRef,
  filter,
  onFilterChange,
  timeRange,
  onTimeRangeChange,
  sort,
  onSortChange,
  compact,
  onCompactChange,
  sync,
  onSync,
  onMarkAllRead,
  onDeleteFailed,
  onImport,
  onResetFilters,
  now
}) {
  const progress = sync.total ? Math.round((sync.done / sync.total) * 100) : null;
  const menuItems = [
    {
      label: '全部标为已读',
      icon: <MailCheck size={15} />,
      disabled: !summary.unread,
      onSelect: onMarkAllRead
    },
    {
      label: '删除读取失败的邮箱',
      icon: <Trash2 size={15} />,
      hint: summary.failed || undefined,
      danger: true,
      disabled: !summary.failed,
      onSelect: onDeleteFailed
    },
    { type: 'separator' },
    { type: 'label', label: '排序' },
    ...SORT_OPTIONS.map((option) => ({
      label: option.label,
      radio: true,
      checked: sort === option.value,
      onSelect: () => onSortChange(option.value)
    })),
    { type: 'separator' },
    { label: '紧凑列表', checked: compact, onSelect: () => onCompactChange(!compact) }
  ];

  let syncedText = '';
  if (summary.lastSyncAt) syncedText = ` · ${formatRelative(summary.lastSyncAt, now)}读取`;
  else if (summary.accounts) syncedText = ' · 尚未读取';

  return (
    <section className="list-pane" aria-label="邮箱列表">
      <header className="list-header">
        <div className="list-title">
          <div className="list-title-text">
            <h1>{title}</h1>
            <p>
              {summary.accounts} 个邮箱{syncedText}
            </p>
          </div>
          <Menu label="更多操作" icon={<Ellipsis size={17} />} items={menuItems} />
          <button
            type="button"
            className={cx('btn btn-primary', sync.active && 'is-busy')}
            onClick={onSync}
            disabled={sync.active || summary.accounts === 0}
          >
            {sync.active ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}
            <span>{sync.active ? (sync.total ? `读取中 ${sync.done}/${sync.total}` : '读取中') : sync.label}</span>
          </button>
        </div>

        <label className="search-field">
          <Search size={15} aria-hidden="true" />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="搜索邮箱、发件人、主题或内容"
            aria-label="搜索邮箱"
            autoComplete="off"
            spellCheck={false}
          />
          {query ? (
            <button
              type="button"
              className="icon-btn icon-btn-xs"
              onClick={() => {
                onQueryChange('');
                searchRef.current?.focus();
              }}
              aria-label="清除搜索"
            >
              <X size={13} />
            </button>
          ) : (
            <kbd aria-hidden="true">/</kbd>
          )}
        </label>

        <div className="list-filters">
          <Segmented
            value={filter}
            onChange={onFilterChange}
            label="筛选"
            options={[
              { value: 'all', label: '全部', count: summary.accounts },
              { value: 'unread', label: '未读', count: summary.unread },
              { value: 'failed', label: '失败', count: summary.failed }
            ]}
          />
          <select
            className="select"
            value={timeRange}
            onChange={(event) => onTimeRangeChange(event.target.value)}
            aria-label="收件时间"
          >
            {TIME_RANGES.map((range) => (
              <option key={range.value} value={range.value}>
                {range.label}
              </option>
            ))}
          </select>
        </div>

        {sync.active ? (
          <div
            className={cx('progress', progress === null && 'is-indeterminate')}
            role="progressbar"
            aria-label="读取进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress ?? undefined}
          >
            <span style={progress === null ? undefined : { width: `${progress}%` }} />
          </div>
        ) : null}
      </header>

      <div className={cx('list-scroll', compact && 'is-compact')}>
        {loading ? (
          <ListSkeleton />
        ) : !viewHasAccounts ? (
          <EmptyState
            icon={<Inbox size={22} />}
            title="这里还没有邮箱"
            text="导入后，每个邮箱的最新邮件会显示在这里。"
            action={
              <button type="button" className="btn btn-primary" onClick={onImport}>
                <Upload size={15} />
                <span>导入账号</span>
              </button>
            }
          />
        ) : accounts.length === 0 ? (
          <EmptyState
            icon={<Search size={20} />}
            title="没有符合条件的邮箱"
            text="换个关键词或筛选条件试试。"
            action={
              <button type="button" className="btn btn-outline" onClick={onResetFilters}>
                清除筛选
              </button>
            }
          />
        ) : (
          accounts.map((account) => (
            <MailboxRow
              key={account.id}
              account={account}
              selected={account.id === selectedId}
              showGroup={showGroup}
              onSelect={onSelect}
              now={now}
            />
          ))
        )}
      </div>
    </section>
  );
}

const MailboxRow = memo(function MailboxRow({ account, selected, showGroup, onSelect, now }) {
  const { latest } = account;
  const [local, domain] = splitEmail(account.email);
  let placeholder = '尚未读取';
  if (account.lastError) placeholder = '读取失败';
  else if (account.lastSyncAt) placeholder = '收件箱为空';

  let time = formatListTime(latest?.receivedDateTime, now);
  if (account.syncState === 'running') {
    time = <LoaderCircle size={13} className="spin" aria-label="正在读取" />;
  } else if (account.syncState === 'queued') {
    time = <span className="row-queued">排队中</span>;
  }

  return (
    <button
      type="button"
      data-account-id={account.id}
      className={cx('row', selected && 'is-selected', isUnread(account) && 'is-unread')}
      onClick={() => onSelect(account.id)}
      aria-current={selected ? 'true' : undefined}
    >
      <span className="row-dot" aria-hidden="true" />
      <span className="row-head">
        <span className="row-email" title={account.email}>
          <span className="row-email-local">{local}</span>
          <span className="row-email-domain">{domain}</span>
        </span>
        {showGroup ? (
          <span className="row-group" title={`接收器 ${account.receiverPage}`}>
            {account.receiverPage}
          </span>
        ) : null}
        {account.lastError ? <TriangleAlert size={13} className="row-alert" aria-label="读取失败" /> : null}
        <span className="row-time">{time}</span>
      </span>
      {latest ? (
        <span className="row-subject">
          <span className="row-sender">{latest.fromName || latest.fromAddress || '未知发件人'}</span>
          <span className="row-sep" aria-hidden="true">
            ·
          </span>
          {latest.subject || '(无主题)'}
        </span>
      ) : (
        <span className="row-subject is-placeholder">{placeholder}</span>
      )}
      {account.lastError ? (
        <span className="row-preview is-error">{account.lastError}</span>
      ) : latest?.bodyPreview ? (
        <span className="row-preview">{latest.bodyPreview}</span>
      ) : null}
    </button>
  );
});

function EmptyState({ icon, title, text, action }) {
  return (
    <div className="empty-state">
      <span className="empty-icon">{icon}</span>
      <strong>{title}</strong>
      <span>{text}</span>
      {action}
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="list-skeleton" aria-label="正在加载">
      {Array.from({ length: 7 }, (_, index) => (
        <div key={index} className="skeleton-row">
          <span className="skeleton" style={{ width: `${48 + ((index * 17) % 30)}%` }} />
          <span className="skeleton" style={{ width: `${66 + ((index * 7) % 28)}%` }} />
          <span className="skeleton" style={{ width: `${38 + ((index * 11) % 36)}%` }} />
        </div>
      ))}
    </div>
  );
}
