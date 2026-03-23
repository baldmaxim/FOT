import { type FC, useState, useRef, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import type { EmployeePositionType } from '../../types';
import styles from './DevRoleSwitcher.module.css';

const ROLE_OPTIONS: Array<{ value: EmployeePositionType; label: string }> = [
  { value: 'super_admin', label: 'Супер-админ' },
  { value: 'admin', label: 'Администратор' },
  { value: 'header', label: 'Руководитель' },
  { value: 'worker', label: 'Сотрудник' },
];

export const DevRoleSwitcher: FC = () => {
  const { positionType, devOverride, setDevOverride } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const currentLabel = ROLE_OPTIONS.find(r => r.value === positionType)?.label || 'Не задана';

  if (devOverride == null && positionType !== 'super_admin') return null;

  return (
    <div className={styles.container} ref={containerRef}>
      {isOpen && (
        <div className={styles.dropdown}>
          <div className={styles.dropdownTitle}>Переключить роль</div>
          {ROLE_OPTIONS.map(opt => (
            <button
              key={opt.value}
              className={`${styles.option} ${positionType === opt.value ? styles.active : ''}`}
              onClick={() => {
                setDevOverride(opt.value);
                setIsOpen(false);
              }}
            >
              {opt.label}
              {positionType === opt.value && <span className={styles.checkmark}>✓</span>}
            </button>
          ))}
          {devOverride && (
            <button
              className={styles.reset}
              onClick={() => {
                setDevOverride(null);
                setIsOpen(false);
              }}
            >
              Сбросить override
            </button>
          )}
        </div>
      )}
      <button className={styles.trigger} onClick={() => setIsOpen(!isOpen)}>
        <span className={styles.badge}>DEV</span>
        <span className={styles.roleName}>{currentLabel}</span>
      </button>
    </div>
  );
};
