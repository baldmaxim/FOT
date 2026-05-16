import { type FC } from 'react';
import { MapPinIcon } from '../../../components/ui/Icons';
import type { IPresenceObjectEmployee } from '../../../types';
import styles from './SkudPresencePage.module.css';

const formatTime = (value: string | null): string => {
  if (!value) return '—';
  return value.slice(0, 5);
};

const computeDuration = (firstEntry: string | null): string | null => {
  if (!firstEntry) return null;
  const parts = firstEntry.split(':').map(Number);
  if (parts.length < 2 || parts.some(p => Number.isNaN(p))) return null;
  const [h, m, s = 0] = parts;
  const now = new Date();
  const entry = new Date();
  entry.setHours(h, m, s, 0);
  const diffMs = now.getTime() - entry.getTime();
  // first_entry — сегодня, но если оно в будущем (часы сдвинуты) — игнор.
  if (diffMs < 0) return null;
  const totalMin = Math.floor(diffMs / 60_000);
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  if (hours === 0) return `${minutes} мин`;
  return `${hours} ч ${String(minutes).padStart(2, '0')} мин`;
};

interface IEmployeeRowProps {
  emp: IPresenceObjectEmployee;
  /** Скрыть строку с department_name — когда сотрудник уже сгруппирован под заголовком отдела. */
  hideDepartment?: boolean;
}

export const EmployeeRow: FC<IEmployeeRowProps> = ({ emp, hideDepartment = false }) => {
  const duration = computeDuration(emp.first_entry);
  return (
    <li className={styles.employeeRow}>
      <div className={styles.employeeTopRow}>
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
        {emp.last_access_point && (
          <span className={styles.employeeAp} title={emp.last_access_point}>
            <MapPinIcon className={styles.tinyIcon} />
            <span className={styles.employeeApText}>{emp.last_access_point}</span>
          </span>
        )}
      </div>
      {!hideDepartment && emp.department_name && (
        <div className={styles.employeeDepartment}>{emp.department_name}</div>
      )}
      {emp.position_name && (
        <div className={styles.employeePosition}>{emp.position_name}</div>
      )}
      <div className={styles.employeeTimeRow}>
        <span className={styles.employeeTimeBig}>с {formatTime(emp.first_entry)}</span>
        {duration && (
          <span className={styles.employeeDuration} title="Время на объекте">
            · {duration}
          </span>
        )}
      </div>
    </li>
  );
};
