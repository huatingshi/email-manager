import { useEffect, useId, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { cx, hueFor, initialFor } from '../format.js';

export function Segmented({ value, options, onChange, label, size }) {
  return (
    <div className={cx('segmented', size === 'sm' && 'segmented-sm')} role="radiogroup" aria-label={label}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            className={cx('segmented-item', active && 'is-active')}
            onClick={() => onChange(option.value)}
          >
            <span>{option.label}</span>
            {option.count !== undefined ? <span className="segmented-count">{option.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export function Avatar({ seed, name }) {
  return (
    <span className="avatar" style={{ '--hue': hueFor(seed) }} aria-hidden="true">
      {initialFor(name)}
    </span>
  );
}

// Icon button with a dropdown. Items: { label, icon?, hint?, danger?, disabled?,
// checked?, radio?, onSelect } | { type: 'separator' } | { type: 'label', label }.
export function Menu({ label, icon, items }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutsideClick = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      rootRef.current?.querySelector('button')?.focus();
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  return (
    <div className="menu" ref={rootRef}>
      <button
        type="button"
        className={cx('icon-btn', open && 'is-pressed')}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        {icon}
      </button>
      {open ? (
        <div className="menu-popover" role="menu" id={menuId}>
          {items.map((item, index) => {
            if (item.type === 'separator') {
              return <div key={index} className="menu-separator" role="separator" />;
            }
            if (item.type === 'label') {
              return (
                <div key={index} className="menu-label">
                  {item.label}
                </div>
              );
            }
            const checkable = item.checked !== undefined;
            return (
              <button
                key={index}
                type="button"
                role={item.radio ? 'menuitemradio' : checkable ? 'menuitemcheckbox' : 'menuitem'}
                aria-checked={checkable ? item.checked : undefined}
                className={cx('menu-item', item.danger && 'is-danger')}
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                <span className="menu-item-icon">
                  {checkable ? item.checked ? <Check size={14} /> : null : item.icon}
                </span>
                <span className="menu-item-label">{item.label}</span>
                {item.hint ? <span className="menu-item-hint">{item.hint}</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
