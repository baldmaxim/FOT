import type { FC } from 'react';

import styles from '../../pages/admin/Admin.module.css';

interface IBrigadeOutputAccessTabProps {
  checked: boolean;
  onToggle: () => void;
  /** «Ставить КТУ своим бригадам» (370); нет — сотрудник не начальник участка ни одной бригады. */
  supervisorKtu?: { checked: boolean; onToggle: () => void };
  /**
   * «Видеть зарплату своих сотрудников в табеле» (382); нет — сотрудник не руководитель ни одного отдела. departments —
   * отделы, где он руководитель: подотделы входят сами.
   */
  teamSalary?: { checked: boolean; onToggle: () => void; departments: readonly string[] };
  loading: boolean;
  error: boolean;
}

/**
 * Вкладка «Выработка» в панели назначений: ввод выработки в «Бригадах» и просмотр «Зарплаты по объектам» (342); начальнику
 * участка — «Зарплата по объектам» своих бригад с правкой КТУ (370); руководителю — столбец «Зарплата» своих людей в
 * табеле (382).
 */
export const BrigadeOutputAccessTab: FC<IBrigadeOutputAccessTabProps> = ({
  checked, onToggle, supervisorKtu, teamSalary, loading, error,
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
      {teamSalary && (
        <label
          className={`${styles.departmentAccessItem} ${teamSalary.checked ? styles.departmentAccessItemChecked : ''}`}
        >
          <input type="checkbox" checked={teamSalary.checked} onChange={teamSalary.onToggle} />
          <span className={styles.departmentAccessItemLabel}>
            Видеть зарплату своих сотрудников в табеле
            {teamSalary.departments.length > 0 && (
              <span className={styles.departmentAccessItemNote}>{teamSalary.departments.join(', ')} — с подотделами</span>
            )}
          </span>
        </label>
      )}
    </div>
  );
};
