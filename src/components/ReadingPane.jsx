import {
  ArrowLeft,
  Copy,
  ExternalLink,
  Inbox,
  LoaderCircle,
  MailOpen,
  RefreshCw,
  Trash2,
  TriangleAlert,
  Upload
} from 'lucide-react';
import { formatRelative } from '../format.js';
import { HistoryPanel } from './HistoryPanel.jsx';
import { MessageView } from './MessageView.jsx';

// Errors that re-importing the account's credentials would fix.
const CREDENTIAL_ERROR = /授权|refresh token|凭据|client_id|锁定|停用|账户不存在/i;

export function ReadingPane({
  account,
  loading,
  hasAccounts,
  message,
  isHistory,
  full,
  onRetryFull,
  onBackToLatest,
  onClose,
  refreshing,
  onRefresh,
  onCopy,
  onDelete,
  onImport,
  bodyMode,
  onBodyModeChange,
  histories,
  onLoadHistory,
  onOpenHistory,
  now
}) {
  if (!account) {
    return (
      <section className="reader" aria-label="邮件内容">
        {loading ? null : <Welcome hasAccounts={hasAccounts} onImport={onImport} />}
      </section>
    );
  }

  const webLink = full?.status === 'loaded' ? full.data.webLink : null;

  return (
    <section className="reader" aria-label="邮件内容">
      <header className="reader-bar">
        <button type="button" className="icon-btn reader-back" onClick={onClose} aria-label="返回列表">
          <ArrowLeft size={18} />
        </button>
        <div className="reader-account">
          <div className="reader-email-row">
            <h2 className="reader-email" title={account.email}>
              {account.email}
            </h2>
            <button
              type="button"
              className="icon-btn icon-btn-sm"
              onClick={() => onCopy(account.email, '已复制邮箱地址')}
              title="复制邮箱地址"
              aria-label="复制邮箱地址"
            >
              <Copy size={14} />
            </button>
          </div>
          <p className="reader-meta">
            接收器 {account.receiverPage}
            <span aria-hidden="true"> · </span>
            {account.lastSyncAt ? `${formatRelative(account.lastSyncAt, now)}读取` : '尚未读取'}
          </p>
        </div>
        <div className="reader-actions">
          <button
            type="button"
            className="btn btn-outline"
            onClick={onRefresh}
            disabled={refreshing}
            title="只读取这个邮箱的最新邮件"
          >
            {refreshing ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}
            <span>刷新</span>
          </button>
          {webLink ? (
            <a
              className="btn btn-ghost"
              href={webLink}
              target="_blank"
              rel="noreferrer"
              title="在 Outlook 网页版中打开这封邮件"
            >
              <ExternalLink size={15} />
              <span>Outlook</span>
            </a>
          ) : null}
          <button
            type="button"
            className="icon-btn is-danger"
            onClick={onDelete}
            title="删除这个邮箱"
            aria-label="删除这个邮箱"
          >
            <Trash2 size={16} />
          </button>
        </div>
      </header>

      <div className="reader-scroll">
        <div className="reader-content">
          {account.lastError ? (
            <div className="alert alert-danger" role="alert">
              <TriangleAlert size={16} />
              <div>
                <strong>最近一次读取失败：{account.lastError}</strong>
                {account.lastErrorDetail && account.lastErrorDetail !== account.lastError ? (
                  <p className="alert-detail">{account.lastErrorDetail}</p>
                ) : null}
                {CREDENTIAL_ERROR.test(account.lastError) ? (
                  <p className="alert-hint">拿到新的 refresh token 后，重新导入这一行即可覆盖更新。</p>
                ) : null}
              </div>
            </div>
          ) : null}

          {isHistory ? (
            <div className="history-banner">
              <button type="button" className="link-button" onClick={onBackToLatest}>
                <ArrowLeft size={14} />
                返回最新邮件
              </button>
              <span>正在查看历史邮件</span>
            </div>
          ) : null}

          {message ? (
            <MessageView
              key={message.providerMessageId}
              message={message}
              full={full}
              accountError={account.lastError}
              onRetry={onRetryFull}
              bodyMode={bodyMode}
              onBodyModeChange={onBodyModeChange}
              onCopy={onCopy}
              now={now}
            />
          ) : (
            <NoMessage account={account} refreshing={refreshing} onRefresh={onRefresh} />
          )}

          <HistoryPanel
            key={account.id}
            account={account}
            histories={histories}
            onLoad={onLoadHistory}
            onOpen={onOpenHistory}
            activeId={message?.providerMessageId}
            now={now}
          />
        </div>
      </div>
    </section>
  );
}

function NoMessage({ account, refreshing, onRefresh }) {
  const synced = Boolean(account.lastSyncAt);
  return (
    <div className="card empty-state">
      <span className="empty-icon">
        <Inbox size={22} />
      </span>
      <strong>{synced ? '收件箱里还没有邮件' : '还没有读取这个邮箱'}</strong>
      <span>{synced ? '收到邮件后点“刷新”就能看到。' : '点“刷新”读取它最新的一封邮件。'}</span>
      <button type="button" className="btn btn-primary" onClick={onRefresh} disabled={refreshing}>
        {refreshing ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}
        <span>刷新</span>
      </button>
    </div>
  );
}

function Welcome({ hasAccounts, onImport }) {
  return (
    <div className="welcome">
      <span className="welcome-icon">
        <MailOpen size={26} />
      </span>
      <h2>{hasAccounts ? '选择一个邮箱，查看它的最新邮件' : '先导入几个邮箱吧'}</h2>
      <p>
        {hasAccounts
          ? '左侧每一行是一个邮箱，以及它收到的最新一封邮件。'
          : '导入后点“读取”，每个邮箱最新的一封邮件都会显示出来。'}
      </p>
      {hasAccounts ? (
        <ul className="shortcuts">
          <li>
            <kbd>↑</kbd>
            <kbd>↓</kbd>
            <span>切换邮箱</span>
          </li>
          <li>
            <kbd>/</kbd>
            <span>搜索</span>
          </li>
          <li>
            <kbd>Esc</kbd>
            <span>退出搜索</span>
          </li>
        </ul>
      ) : (
        <button type="button" className="btn btn-primary" onClick={onImport}>
          <Upload size={15} />
          <span>导入账号</span>
        </button>
      )}
    </div>
  );
}
