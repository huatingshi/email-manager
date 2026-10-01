import { useCallback, useRef, useState } from 'react';
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react';

const ICONS = { success: CircleCheck, error: CircleAlert, warning: TriangleAlert, info: Info };

export function useToasts() {
  const [toasts, setToasts] = useState([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (text, tone = 'info', duration) => {
      const id = nextId.current++;
      setToasts((current) => [...current.slice(-3), { id, text, tone }]);
      window.setTimeout(() => dismiss(id), duration ?? (tone === 'error' ? 7000 : 3500));
    },
    [dismiss]
  );

  return { toasts, push, dismiss };
}

export function Toasts({ toasts, onDismiss }) {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => {
        const Icon = ICONS[toast.tone] ?? Info;
        return (
          <div
            key={toast.id}
            className={`toast toast-${toast.tone}`}
            role={toast.tone === 'error' ? 'alert' : 'status'}
          >
            <Icon size={16} className="toast-icon" />
            <span className="toast-text">{toast.text}</span>
            <button
              type="button"
              className="toast-close"
              onClick={() => onDismiss(toast.id)}
              aria-label="关闭提示"
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
