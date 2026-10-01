import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Copy, LoaderCircle, RefreshCw, TriangleAlert } from 'lucide-react';
import { cx, formatAgo, formatFullTime } from '../format.js';
import { Avatar, Segmented } from './ui.jsx';

const URL_IN_TEXT = /https?:\/\/[^\s<>"'，。；、）】」』]+/g;
const COLLAPSED_LINKS = 4;
const BODY_MODES = [
  { value: 'text', label: '纯文本' },
  { value: 'html', label: '原始样式' }
];

export function MessageView({ message, full, accountError, onRetry, bodyMode, onBodyModeChange, onCopy, now }) {
  const data = full?.status === 'loaded' ? full.data : null;
  const loading = !full || full.status === 'loading';
  const sender = message.fromName || message.fromAddress || '未知发件人';
  const relative = formatAgo(message.receivedDateTime, now);
  // The account-level alert above already shows this error.
  const loadError = full?.status === 'error' && full.error !== accountError ? full.error : null;
  const mode = bodyMode === 'html' && data?.bodyHtml ? 'html' : 'text';

  return (
    <article className="card message">
      <header className="message-head">
        <h1 className="message-subject">{message.subject || '(无主题)'}</h1>
        <div className="message-from">
          <Avatar seed={message.fromAddress || sender} name={sender} />
          <div className="message-from-text">
            <div className="message-sender">
              <strong>{sender}</strong>
              {message.fromName && message.fromAddress ? <span>{message.fromAddress}</span> : null}
            </div>
            <time dateTime={message.receivedDateTime ?? undefined}>
              {formatFullTime(message.receivedDateTime)}
              {relative ? `（${relative}）` : ''}
            </time>
          </div>
        </div>
      </header>

      {data?.links.length ? <LinkList links={data.links} onCopy={onCopy} /> : null}

      <section className="message-body" aria-label="正文">
        <div className="message-body-bar">
          <span className="section-label">正文</span>
          {data?.bodyHtml ? (
            <Segmented size="sm" value={mode} onChange={onBodyModeChange} options={BODY_MODES} label="正文显示方式" />
          ) : null}
        </div>

        {loadError ? (
          <div className="alert alert-warning">
            <TriangleAlert size={16} />
            <span>完整内容加载失败：{loadError}</span>
            <button type="button" className="link-button alert-action" onClick={onRetry}>
              <RefreshCw size={13} />
              重试
            </button>
          </div>
        ) : null}

        {mode === 'html' ? (
          <EmailFrame html={data.bodyHtml} />
        ) : (
          <div className={cx('message-text', loading && 'is-partial')}>
            <LinkifiedText text={data?.bodyText || message.bodyPreview || '（没有正文）'} />
          </div>
        )}

        {loading ? (
          <p className="message-loading">
            <LoaderCircle size={13} className="spin" />
            正在加载完整内容…
          </p>
        ) : null}
      </section>
    </article>
  );
}

function LinkList({ links, onCopy }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? links : links.slice(0, COLLAPSED_LINKS);

  return (
    <section className="links" aria-label="邮件中的链接">
      <div className="section-label">
        链接
        <span className="section-count">{links.length}</span>
      </div>
      <ul className="link-list">
        {shown.map((link) => (
          <li key={link.url} className="link-item">
            <a className="link-open" href={link.url} target="_blank" rel="noreferrer" title={link.url}>
              <span className="link-label">{link.label && link.label !== link.url ? link.label : shortenUrl(link.url)}</span>
              <span className="link-host">{link.host}</span>
            </a>
            <button
              type="button"
              className="icon-btn icon-btn-sm"
              onClick={() => onCopy(link.url, '已复制链接')}
              title="复制链接"
              aria-label="复制链接"
            >
              <Copy size={13} />
            </button>
          </li>
        ))}
      </ul>
      {links.length > COLLAPSED_LINKS ? (
        <button type="button" className="link-button links-toggle" onClick={() => setExpanded((current) => !current)}>
          {expanded ? '收起' : `显示全部 ${links.length} 个链接`}
        </button>
      ) : null}
    </section>
  );
}

function shortenUrl(url) {
  try {
    const { hostname, pathname } = new URL(url);
    const path = pathname === '/' ? '' : pathname;
    return `${hostname.replace(/^www\./, '')}${path.length > 40 ? `${path.slice(0, 40)}…` : path}`;
  } catch {
    return url;
  }
}

function LinkifiedText({ text }) {
  return useMemo(() => {
    const parts = [];
    let cursor = 0;
    for (const match of text.matchAll(URL_IN_TEXT)) {
      const url = match[0].replace(/[).,;:!?]+$/, '');
      if (match.index > cursor) parts.push(text.slice(cursor, match.index));
      parts.push(
        <a key={match.index} href={url} target="_blank" rel="noreferrer">
          {url}
        </a>
      );
      cursor = match.index + url.length;
    }
    if (cursor < text.length) parts.push(text.slice(cursor));
    return parts;
  }, [text]);
}

// Scripts, forms and top-level navigation stay blocked by the sandbox; links
// open in a new tab. Remote images do load in this view.
const FRAME_POLICY =
  "default-src 'none'; img-src data: cid: http: https:; style-src 'unsafe-inline' http: https:; font-src data: http: https:";

function buildEmailDocument(html) {
  const withoutRedirects = html.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi, '');
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_POLICY}"><base target="_blank"><style>html{overflow-y:hidden}html,body{height:auto!important;min-height:0!important}body{margin:0;padding:20px;background:#fff;color:#1f2937;font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei UI",sans-serif;overflow-wrap:break-word}img{max-width:100%;height:auto}</style></head><body>${withoutRedirects}</body></html>`;
}

function EmailFrame({ html }) {
  const frameRef = useRef(null);
  const observerRef = useRef(null);
  const [height, setHeight] = useState(320);
  const srcDoc = useMemo(() => buildEmailDocument(html), [html]);

  // Size the frame to its content so the reading pane is the only scroller.
  const measure = useCallback(() => {
    const frame = frameRef.current;
    const root = frame?.contentDocument?.documentElement;
    if (!root) return;
    const border = frame.offsetHeight - frame.clientHeight;
    // +1 absorbs sub-pixel content heights that scrollHeight rounds down.
    const next = Math.min(Math.max(root.scrollHeight + border + 1, 120), 20_000);
    setHeight((current) => (Math.abs(current - next) > 4 ? next : current));
  }, []);

  const handleLoad = useCallback(() => {
    measure();
    observerRef.current?.disconnect();
    const body = frameRef.current?.contentDocument?.body;
    if (body) {
      observerRef.current = new ResizeObserver(measure);
      observerRef.current.observe(body);
    }
  }, [measure]);

  useEffect(() => () => observerRef.current?.disconnect(), []);

  return (
    <iframe
      ref={frameRef}
      className="email-frame"
      title="邮件原始样式"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      onLoad={handleLoad}
      style={{ height }}
    />
  );
}
