import { type FC } from 'react';

import type { PayrollAccessLevel } from '../../services/payrollAccessService';
import styles from '../../pages/admin/Admin.module.css';

interface IPayrollAccessTabProps {
  value: PayrollAccessLevel;
  onChange: (level: PayrollAccessLevel) => void;
  loading: boolean;
  error: boolean;
  disabled?: boolean;
}

const OPTIONS: ReadonlyArray<{ key: string; value: PayrollAccessLevel; label: string }> = [
  { key: 'none', value: null, label: 'Нет доступа' },
  { key: 'view', value: 'view', label: 'Просмотр' },
  { key: 'edit', value: 'edit', label: 'Редактирование' },
];

/** Вкладка «Зарплата» панели назначений: персональный доступ к разделу «Зарплата». */
export const PayrollAccessTab: FC<IPayrollAccessTabProps> = ({ value, onChange, loading, error, disabled = false }) => {
  if (loading) {
    return <div className={styles.departmentAccessEmpty}>Загрузка...</div>;
  }
  if (error) {
    return <div className={styles.departmentAccessEmpty}>Не удалось загрузить доступ</div>;
  }

  return (
    <div className={styles.assignmentPanelList} role="radiogroup" aria-label="Доступ к разделу «Зарплата»">
      {OPTIONS.map(option => {
        const checked = value === option.value;
        return (
          <label
            key={option.key}
            className={`${styles.departmentAccessItem} ${checked ? styles.departmentAccessItemChecked : ''}`}
          >
            <input
              type="radio"
              name="payroll-access-level"
              checked={checked}
              disabled={disabled}
              onChange={() => onChange(option.value)}
            />
            <span className={styles.departmentAccessItemLabel}>{option.label}</span>
          </label>
        );
      })}
    </div>
  );
};
