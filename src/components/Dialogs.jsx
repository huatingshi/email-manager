import { useEffect, useId, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { CircleAlert, LoaderCircle, TriangleAlert, Upload, X } from 'lucide-react';
import { cx } from '../format.js';
import { Segmented } from './ui.jsx';

const EMAIL_PATTERN = /^[^\s@|]+@[^\s@|]+\.[^\s@|]+$/;

function Modal({ title, description, size = 'md', busy = false, onClose, footer, children }) {
  const titleId = useId();

  useEffect(() => {
    const closeOnEscape = (event) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [busy, onClose]);

  return createPortal(
    <div className="modal-backdrop">
      <div className={cx('modal', `modal-${size}`)} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="modal-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description ? <p>{description}</p> : null}
          </div>
          <button type="button" className="icon-btn" onClick={onClose} disabled={busy} aria-label="关闭">
            <X size={16} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-footer">{footer}</footer> : null}
      </div>
    </div>,
    document.body
  );
}

// Mirrors the server's rules closely enough for a live "N 行" preview.
function countLines(raw) {
  let total = 0;
  let valid = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    total += 1;
    const parts = line.split('|').map((part) => part.trim());
    if (parts.length >= 4 && EMAIL_PATTERN.test(parts[0]) && parts.at(-1) && parts.at(-2)) valid += 1;
  }
  return { total, valid };
}

function describeLines(numbers) {
  const shown = numbers.slice(0, 8).join('、');
  return numbers.length > 8 ? `${shown} 等 ${numbers.length} 行` : shown;
}

export function ImportDialog({ pages, initialPage, draft, onDraftChange, onImport, onClose }) {
  const [page, setPage] = useState(initialPage);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const counts = useMemo(() => countLines(draft), [draft]);
  const newPage = Math.max(...pages) + 1;
  const groupOptions = [
    ...pages.map((value) => ({ value, label: `接收器 ${value}` })),
    { value: newPage, label: '+ 新分组' }
  ];

  async function submit() {
    if (!counts.valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await onImport(draft, page);
      if (result.invalidLines.length) {
        // Keep only the rejected lines so they can be fixed and re-imported.
        const lines = draft.split(/\r?\n/);
        onDraftChange(result.invalidLines.map((number) => lines[number - 1]).join('\n'));
        setError(`第 ${describeLines(result.invalidLines)} 行格式不正确，已保留在输入框里，改好后可以再次导入。`);
        setBusy(false);
      } else {
        onDraftChange('');
        onClose();
      }
    } catch (requestError) {
      const invalid = requestError.payload?.invalidLines;
      setError(invalid?.length ? `${requestError.message}（第 ${describeLines(invalid)} 行）` : requestError.message);
      setBusy(false);
    }
  }

  const invalidCount = counts.total - counts.valid;

  return (
    <Modal
      title="导入账号"
      description="每行一个账号，格式：邮箱 | 密码 | refresh_token | client_id"
      size="lg"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <span className={cx('import-summary', invalidCount > 0 && 'is-warning')}>
            {counts.total
              ? `识别到 ${counts.total} 行${invalidCount ? `，其中 ${invalidCount} 行格式不对` : ''}`
              : '粘贴后会自动识别行数'}
          </span>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={busy || !counts.valid}>
            {busy ? <LoaderCircle size={15} className="spin" /> : <Upload size={15} />}
            <span>{counts.valid ? `导入 ${counts.valid} 个` : '导入'}</span>
          </button>
        </>
      }
    >
      <div className="field">
        <span className="field-label">导入到</span>
        <Segmented value={page} options={groupOptions} onChange={setPage} label="导入到哪个分组" />
        {page === newPage ? <span className="field-hint">将新建「接收器 {newPage}」</span> : null}
      </div>
      <textarea
        className="import-textarea"
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            submit();
          }
        }}
        placeholder="邮箱 | 密码 | refresh_token | client_id"
        aria-label="账号列表"
        spellCheck={false}
        autoComplete="off"
        wrap="off"
        autoFocus
      />
      {error ? (
        <div className="alert alert-warning">
          <TriangleAlert size={16} />
          <span>{error}</span>
        </div>
      ) : (
        <p className="field-hint">已存在的邮箱会更新凭据并移到所选分组。按 Ctrl + Enter 直接导入。</p>
      )}
    </Modal>
  );
}

export function ConfirmDialog({ title, message, items, confirmLabel = '确定', danger = false, onConfirm, onClose }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (requestError) {
      setError(requestError.message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={title}
      size="sm"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          {/* Focus starts on 取消 so Enter never deletes by accident. */}
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy} autoFocus>
            取消
          </button>
          <button type="button" className={cx('btn', danger ? 'btn-danger' : 'btn-primary')} onClick={confirm} disabled={busy}>
            {busy ? <LoaderCircle size={15} className="spin" /> : null}
            <span>{confirmLabel}</span>
          </button>
        </>
      }
    >
      <p className="confirm-message">{message}</p>
      {items?.length ? (
        <ul className="confirm-items">
          {items.slice(0, 6).map((item) => (
            <li key={item}>{item}</li>
          ))}
          {items.length > 6 ? <li className="confirm-more">…以及另外 {items.length - 6} 个</li> : null}
        </ul>
      ) : null}
      {error ? (
        <div className="alert alert-danger">
          <CircleAlert size={16} />
          <span>{error}</span>
        </div>
      ) : null}
    </Modal>
  );
}
