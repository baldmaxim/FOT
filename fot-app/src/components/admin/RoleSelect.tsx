import { useEffect, useRef, useState } from 'react';
import type { FC, KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import { useAnchoredPopover } from '../../hooks/useAnchoredPopover';
import styles from '../../pages/admin/Admin.module.css';

export interface IRoleOption {
  code: string;
  name: string;
  is_admin: boolean;
}

interface IRoleSelectProps {
  value: string;
  options: IRoleOption[];
  onChange: (code: string) => void;
  placeholder?: string;
}

export const RoleSelect: FC<IRoleSelectProps> = ({ value, options, onChange, placeholder = 'Выберите роль' }) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelStyle = useAnchoredPopover(open, rootRef);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      // Панель в портале (вне rootRef) — клик по опции не должен закрывать её
      // на mousedown раньше onClick.
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const selected = options.find(o => o.code === value);

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && open) {
      setOpen(false);
      e.stopPropagation();
    }
  };

  return (
    <div ref={rootRef} className={styles.roleSelectWrap} onKeyDown={handleKeyDown}>
      <button
        type="button"
        className={styles.roleSelectTrigger}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(prev => !prev)}
      >
        <span className={selected ? '' : styles.roleSelectPlaceholder}>
          {selected ? selected.name : placeholder}
        </span>
        <ChevronDown size={16} className={open ? styles.roleSelectChevronOpen : styles.roleSelectChevron} />
      </button>

      {open && createPortal(
        <div ref={panelRef} style={panelStyle} className={styles.roleSelectPanel} role="listbox">
          {options.map(opt => {
            const isActive = opt.code === value;
            return (
              <button
                key={opt.code}
                type="button"
                role="option"
                aria-selected={isActive}
                className={`${styles.roleSelectOption} ${isActive ? styles.roleSelectOptionActive : ''}`}
                onClick={() => {
                  onChange(opt.code);
                  setOpen(false);
                }}
              >
                <span>{opt.name}</span>
                {opt.is_admin && <span className={styles.roleSelectAdminBadge}>admin</span>}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
};
