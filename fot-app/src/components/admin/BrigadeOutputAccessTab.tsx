import type { FC } from 'react';

import styles from '../../pages/admin/Admin.module.css';

interface IBrigadeOutputAccessTabProps {
  checked: boolean;
  onToggle: () => void;
  /** «Ставить КТУ своим бригадам» (370); нет — сотрудник не начальник участка ни одной бригады. */
  supervisorKtu?: { checked: boolean; onToggle: () => void };
  loading: boolean;
  error: boolean;
}

/**
 * Вкладка «Выработка» в панели назначений: ввод выработки в «Бригадах» и просмотр «Зарплаты по объектам» (342); начальнику
 * участка — «Зарплата по объектам» своих бригад с правкой КТУ (370).
 */
export const BrigadeOutputAccessTab: FC<IBrigadeOutputAccessTabProps> = ({
  checked, onToggle, supervisorKtu, loading, error,
}) => {
  if (loading) return <div className={styles.departmentAccessEmpty}>Загрузка...</div>;
  if (error) return <div className={styles.departmentAccessEmpty}>Не удалось загрузить доступ</div>;
  return (
    <div className={styles.assignmentPanelList}>
      <label className={`${styles.departmentAccessItem} ${checked ? styles.departmentAccessItemChecked : ''}`}>
        <input type="checkbox" checked={checked} onChange={onToggle} />
        <span className={styles.departmentAccessItemLabel}>Вносить выработку бригад</span>
      </label>
      {supervisorKtu && (
        <label
          className={`${styles.departmentAccessItem} ${supervisorKtu.checked ? styles.departmentAccessItemChecked : ''}`}
        >
          <input type="checkbox" checked={supervisorKtu.checked} onChange={supervisorKtu.onToggle} />
          <span className={styles.departmentAccessItemLabel}>Ставить КТУ своим бригадам</span>
        </label>
      )}
    </div>
  );
};
