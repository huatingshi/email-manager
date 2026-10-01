import { useEffect, useState } from 'react';
import { ChevronDown, History, RefreshCw } from 'lucide-react';
import { cx, formatListTime } from '../format.js';
import { Segmented } from './ui.jsx';

const FOLDERS = [
  { value: 'inbox', label: '收件箱' },
  { value: 'junkemail', label: '垃圾邮件' }
];

// Older mail is fetched from Outlook on demand; only the latest message is stored locally.
export function HistoryPanel({ account, histories, onLoad, onOpen, activeId, now }) {
  const [open, setOpen] = useState(false);
  const [folder, setFolder] = useState('inbox');
  const entry = histories[`${account.id}:${folder}`];
  const loading = entry?.status === 'loading';

  useEffect(() => {
    if (open && !entry) onLoad(account.id, folder);
  }, [open, entry, account.id, folder, onLoad]);

  return (
    <section className="card history">
      <button
        type="button"
        className="history-toggle"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        <History size={15} />
        <span>历史邮件</span>
        {open ? null : <span className="history-toggle-hint">查看收件箱和垃圾邮件里更早的邮件</span>}
        <ChevronDown size={16} className={cx('chevron', open && 'is-open')} />
      </button>

      {open ? (
        <div className="history-body">
          <div className="history-toolbar">
            <Segmented size="sm" value={folder} onChange={setFolder} options={FOLDERS} label="文件夹" />
            <button
              type="button"
              className="icon-btn icon-btn-sm"
              onClick={() => onLoad(account.id, folder)}
              disabled={loading}
              title="重新读取"
              aria-label="重新读取"
            >
              <RefreshCw size={13} className={loading ? 'spin' : undefined} />
            </button>
          </div>

          {entry?.status === 'error' ? <p className="history-note is-error">{entry.error}</p> : null}

          {entry?.messages ? (
            entry.messages.length === 0 ? (
              <p className="history-note">{folder === 'inbox' ? '收件箱是空的' : '垃圾邮件是空的'}</p>
            ) : (
              <ul className="history-list">
                {entry.messages.map((item) => (
                  <li key={item.providerMessageId}>
                    <button
                      type="button"
                      className={cx('history-item', item.providerMessageId === activeId && 'is-active')}
                      onClick={() => onOpen(item)}
                    >
                      <span className="history-subject">{item.subject || '(无主题)'}</span>
                      <span className="history-time">{formatListTime(item.receivedDateTime, now)}</span>
                      <span className="history-from">
                        {item.fromName || item.fromAddress || '未知发件人'}
                        {item.bodyPreview ? ` — ${item.bodyPreview}` : ''}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : entry?.status === 'error' ? null : (
            <div className="history-skeleton">
              {[72, 54, 64].map((width) => (
                <span key={width} className="skeleton" style={{ width: `${width}%` }} />
              ))}
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
