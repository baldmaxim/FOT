/**
 * Меню "•••" (overflow / kebab) для списка действий с автозакрытием.
 *
 * Извлечено из pages/StaffControlPage.tsx (Волна 3 декомпозиции).
 * Самостоятельный компонент с локальным state (open) и хук'ами для
 * закрытия по клику снаружи + Escape. Принимает массив items с label,
 * icon, callback и опциональным divideBefore-разделителем.
 */
import { Fragment, useEffect, useRef, useState, type FC, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';

export interface IOverflowMenuItem {
  label: string;
  onClick: () => void;
  icon?: ReactNode;
  disabled?: boolean;
  divideBefore?: boolean;
}

export interface IOverflowMenuProps {
  items: IOverflowMenuItem[];
  ariaLabel?: string;
}

export const OverflowMenu: FC<IOverflowMenuProps> = ({ items, ariaLabel = 'Дополнительные действия' }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  return (
    <div className="sc-overflow" ref={ref}>
      <button
        type="button"
        className="sc-overflow-trigger"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(prev => !prev)}
      >
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <div className="sc-overflow-menu" role="menu">
          {items.map((item, idx) => (
            <Fragment key={`${item.label}-${idx}`}>
              {item.divideBefore && idx > 0 && <div className="sc-overflow-divider" />}
              <button
                type="button"
                role="menuitem"
                className="sc-overflow-item"
                disabled={item.disabled}
                onClick={() => {
                  if (item.disabled) return;
                  setOpen(false);
                  item.onClick();
                }}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
};
