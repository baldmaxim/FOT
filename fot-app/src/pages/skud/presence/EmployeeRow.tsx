import { type FC } from 'react';
import { MapPinIcon } from '../../../components/ui/Icons';
import type { IPresenceObjectEmployee } from '../../../types';
import styles from './SkudPresencePage.module.css';

const formatTime = (value: string | null): string => {
  if (!value) return '—';
  return value.slice(0, 5);
};

export const EmployeeRow: FC<{ emp: IPresenceObjectEmployee }> = ({ emp }) => (
  <li className={styles.employeeRow}>
    <div className={styles.employeeName}>
      <span className={styles.employeeNameText}>{emp.full_name}</span>
      {emp.is_unsynced && (
        <span
          className={styles.unsyncedBadge}
          title="Сотрудник не в нашем whitelist — данные получены напрямую из Sigur"
        >
          Sigur
        </span>
      )}
    </div>
    {emp.department_name && (
      <div className={styles.employeeDepartment}>{emp.department_name}</div>
    )}
    {emp.position_name && (
      <div className={styles.employeePosition}>{emp.position_name}</div>
    )}
    <div className={styles.employeeFooter}>
      {emp.last_access_point && (
        <span className={styles.employeeAp} title={emp.last_access_point}>
          <MapPinIcon className={styles.tinyIcon} />
          <span className={styles.employeeApText}>{emp.last_access_point}</span>
        </span>
      )}
      <span className={styles.employeeTime}>с {formatTime(emp.first_entry)}</span>
    </div>
  </li>
);
