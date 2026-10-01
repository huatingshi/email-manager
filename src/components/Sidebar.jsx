import { Layers, LoaderCircle, Mail, Upload } from 'lucide-react';
import { cx, formatRelative } from '../format.js';

export function Sidebar({ view, onViewChange, totals, groups, isSyncing, onImport, onShowFailed, now }) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          <Mail size={17} strokeWidth={2.25} />
        </span>
        <span className="brand-text">
          <strong>Mail Collector</strong>
          <span>最新邮件接收器</span>
        </span>
      </div>

      <nav className="nav" aria-label="分组">
        <span className="nav-heading">分组</span>
        <NavItem
          active={view === 'all'}
          icon={<Layers size={16} />}
          label="全部邮箱"
          summary={totals}
          syncing={isSyncing('all')}
          onClick={() => onViewChange('all')}
        />
        {groups.map((group) => (
          <NavItem
            key={group.page}
            active={view === group.page}
            icon={<span className="nav-index">{group.page}</span>}
            label={group.label}
            summary={group}
            syncing={isSyncing(group.page)}
            onClick={() => onViewChange(group.page)}
          />
        ))}
      </nav>

      <button type="button" className="btn btn-outline sidebar-import" onClick={onImport}>
        <Upload size={15} />
        <span>导入账号</span>
      </button>

      <footer className="sidebar-footer">
        <span>
          {totals.accounts} 个邮箱
          {totals.failed ? (
            <>
              {' · '}
              <button type="button" className="link-button is-danger" onClick={onShowFailed}>
                {totals.failed} 个读取失败
              </button>
            </>
          ) : null}
        </span>
        <span>{totals.lastSyncAt ? `${formatRelative(totals.lastSyncAt, now)}读取过` : '还没有读取过'}</span>
      </footer>
    </aside>
  );
}

function NavItem({ active, icon, label, summary, syncing, onClick }) {
  return (
    <button
      type="button"
      className={cx('nav-item', active && 'is-active')}
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
    >
      <span className="nav-icon">{icon}</span>
      <span className="nav-label">{label}</span>
      {syncing ? <LoaderCircle size={13} className="spin nav-syncing" aria-label="正在读取" /> : null}
      {summary.failed ? <span className="nav-failed" title={`${summary.failed} 个读取失败`} /> : null}
      {summary.unread ? (
        <span className="nav-unread" title={`${summary.unread} 封未读`}>
          {summary.unread}
        </span>
      ) : (
        <span className="nav-count">{summary.accounts}</span>
      )}
    </button>
  );
}
