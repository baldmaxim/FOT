import type { FC } from 'react';

import styles from '../../pages/admin/Admin.module.css';

interface IBrigadeOutputAccessTabProps {
  checked: boolean;
  onToggle: () => void;
  loading: boolean;
  error: boolean;
}

/** Вкладка «Выработка» в панели назначений (миграция 342): ввод выработки в «Бригадах» и просмотр «Зарплаты по объектам». */
export const BrigadeOutputAccessTab: FC<IBrigadeOutputAccessTabProps> = ({ checked, onToggle, loading, error }) => {
  if (loading) return <div className={styles.departmentAccessEmpty}>Загрузка...</div>;
  if (error) return <div className={styles.departmentAccessEmpty}>Не удалось загрузить доступ</div>;
  return (
    <div className={styles.assignmentPanelList}>
      <label className={`${styles.departmentAccessItem} ${checked ? styles.departmentAccessItemChecked : ''}`}>
        <input type="checkbox" checked={checked} onChange={onToggle} />
        <span className={styles.departmentAccessItemLabel}>Вносить выработку бригад</span>
      </label>
    </div>
  );
};
