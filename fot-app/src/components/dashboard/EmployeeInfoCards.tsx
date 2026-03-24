import type { FC } from 'react';
import type { Employee } from '../../types';
import styles from '../../pages/employee/EmployeeDashboard.module.css';

interface IEmployeeInfoCardsProps {
  loading: boolean;
  employee: Employee | null;
  importedPosition: string | undefined;
  email: string | undefined;
  isTwoFactorEnabled: boolean;
  onSetup2FA: () => void;
  onDisable2FA: () => void;
}

const formatDateRu = (d: string) =>
  new Date(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });

const calcYears = (from: string): string => {
  const diff = Date.now() - new Date(from).getTime();
  const years = Math.floor(diff / (365.25 * 24 * 60 * 60 * 1000));
  if (years === 0) return 'менее года';
  const lastDigit = years % 10;
  const lastTwo = years % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return `${years} лет`;
  if (lastDigit === 1) return `${years} год`;
  if (lastDigit >= 2 && lastDigit <= 4) return `${years} года`;
  return `${years} лет`;
};

export const EmployeeInfoCards: FC<IEmployeeInfoCardsProps> = ({
  loading,
  employee,
  importedPosition,
  email,
  isTwoFactorEnabled,
  onSetup2FA,
  onDisable2FA,
}) => (
  <div className={styles.infoCards}>
    {/* Employee Info */}
    <div className={styles.infoCard}>
      <div className={styles.infoCardHeader}>
        <div className={`${styles.infoCardIcon} ${styles.vacation}`}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
            <circle cx="12" cy="7" r="4"/>
          </svg>
        </div>
        <div className={styles.infoCardTitle}>Информация</div>
      </div>
      {loading ? (
        <div className={styles.emptyState}>Загрузка...</div>
      ) : employee ? (
        <div className={styles.vacationDetails}>
          <div className={styles.vacationDetail}>
            <span className={styles.vacationDetailLabel}>Отдел</span>
            <span className={styles.vacationDetailValue}>{employee.department || '—'}</span>
          </div>
          <div className={styles.vacationDetail}>
            <span className={styles.vacationDetailLabel}>Должность</span>
            <span className={styles.vacationDetailValue}>{employee.position_name || importedPosition || '—'}</span>
          </div>
          <div className={styles.vacationDetail}>
            <span className={styles.vacationDetailLabel}>Дата приёма</span>
            <span className={styles.vacationDetailValue}>{employee.hire_date ? formatDateRu(employee.hire_date) : '—'}</span>
          </div>
          <div className={styles.vacationDetail}>
            <span className={styles.vacationDetailLabel}>Стаж</span>
            <span className={styles.vacationDetailValue}>{employee.hire_date ? calcYears(employee.hire_date) : '—'}</span>
          </div>
          <div className={styles.vacationDetail}>
            <span className={styles.vacationDetailLabel}>Таб. номер</span>
            <span className={styles.vacationDetailValue}>{employee.tab_number || '—'}</span>
          </div>
        </div>
      ) : (
        <div className={styles.emptyState}>Данные не найдены</div>
      )}
    </div>

    {/* Profile & Security */}
    <div className={styles.infoCard}>
      <div className={styles.infoCardHeader}>
        <div className={`${styles.infoCardIcon} ${styles.schedule}`}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
        </div>
        <div className={styles.infoCardTitle}>Безопасность</div>
      </div>
      <div className={styles.vacationDetails}>
        <div className={styles.vacationDetail}>
          <span className={styles.vacationDetailLabel}>Email</span>
          <span className={styles.vacationDetailValue}>{email || '—'}</span>
        </div>
        <div className={styles.vacationDetail}>
          <span className={styles.vacationDetailLabel}>2FA</span>
          <span className={styles.vacationDetailValue}>
            {isTwoFactorEnabled ? (
              <><span className={styles.statusOn}>Включена</span><button className={styles.link2FA} onClick={onDisable2FA}>Отключить</button></>
            ) : (
              <><span className={styles.statusOff}>Отключена</span><button className={styles.link2FA} onClick={onSetup2FA}>Включить</button></>
            )}
          </span>
        </div>
      </div>
    </div>
  </div>
);
