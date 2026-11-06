import type { FC } from 'react';

import styles from '../../pages/admin/Admin.module.css';

interface IStaffTabAccessTabProps {
  label: string;
  checked: boolean;
  onToggle: () => void;
  loading: boolean;
  error: boolean;
}

/** Вкладки «Проживание» и «Удержания» в панели назначений (миграция 351): одна галочка — правка вкладки кадров. */
export const StaffTabAccessTab: FC<IStaffTabAccessTabProps> = ({ label, checked, onToggle, loading, error }) => {
  if (loading) return <div className={styles.departmentAccessEmpty}>Загрузка...</div>;
  if (error) return <div className={styles.departmentAccessEmpty}>Не удалось загрузить доступ</div>;
  return (
    <div className={styles.assignmentPanelList}>
      <label className={`${styles.departmentAccessItem} ${checked ? styles.departmentAccessItemChecked : ''}`}>
        <input type="checkbox" checked={checked} onChange={onToggle} />
        <span className={styles.departmentAccessItemLabel}>{label}</span>
      </label>
    </div>
  );
};
