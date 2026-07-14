import type { FC } from 'react';
import type { Employee } from '../../types';
import type { IResolvedSchedule } from '../../types/schedule';
import { formatRhythmShort } from '../../utils/scheduleRhythm';
import { fmtPhone } from '../../pages/mts-business/mtsBusinessFormat';
import styles from '../../pages/employee/EmployeeDashboard.module.css';

interface IEmployeeInfoCardProps {
  loading: boolean;
  employee: Employee | null;
  importedPosition: string | undefined;
  schedule: IResolvedSchedule | undefined;
  /** Корпоративные номера МТС сотрудника (обычно один); пусто/undefined → «—». */
  phones?: string[];
}

interface ISecurityCardProps {
  email: string | undefined;
  isTwoFactorEnabled: boolean;
  onSetup2FA: () => void;
  onDisable2FA: () => void;
}

const formatDateRu = (d: string) =>
  new Date(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });

const pluralize = (n: number, one: string, few: string, many: string): string => {
  const lastTwo = n % 100;
  const lastDigit = n % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return `${n} ${many}`;
  if (lastDigit === 1) return `${n} ${one}`;
  if (lastDigit >= 2 && lastDigit <= 4) return `${n} ${few}`;
  return `${n} ${many}`;
};

const calcExperience = (from: string): string => {
  const start = new Date(from);
  const now = new Date();

  let years = now.getFullYear() - start.getFullYear();
  let months = now.getMonth() - start.getMonth();
  if (now.getDate() < start.getDate()) months--;
  if (months < 0) { years--; months += 12; }

  if (years <= 0 && months <= 0) return 'менее месяца';

  const parts: string[] = [];
  if (years > 0) parts.push(pluralize(years, 'год', 'года', 'лет'));
  if (months > 0) parts.push(pluralize(months, 'месяц', 'месяца', 'месяцев'));
  return parts.join(' ');
};

export const EmployeeInfoCard: FC<IEmployeeInfoCardProps> = ({
  loading,
  employee,
  importedPosition,
  schedule,
  phones,
}) => (
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
          <span className={styles.vacationDetailLabel}>График работы</span>
          <span className={styles.vacationDetailValue}>{schedule ? formatRhythmShort(schedule) : '—'}</span>
        </div>
        <div className={styles.vacationDetail}>
          <span className={styles.vacationDetailLabel}>Дата приёма</span>
          <span className={styles.vacationDetailValue}>{employee.hire_date ? formatDateRu(employee.hire_date) : '—'}</span>
        </div>
        <div className={styles.vacationDetail}>
          <span className={styles.vacationDetailLabel}>Стаж</span>
          <span className={styles.vacationDetailValue}>{employee.hire_date ? calcExperience(employee.hire_date) : '—'}</span>
        </div>
        <div className={styles.vacationDetail}>
          <span className={styles.vacationDetailLabel}>Таб. номер</span>
          <span className={styles.vacationDetailValue}>{employee.tab_number || '—'}</span>
        </div>
        <div className={styles.vacationDetail}>
          <span className={styles.vacationDetailLabel}>Телефон</span>
          <span className={styles.vacationDetailValue}>
            {phones && phones.length > 0 ? phones.map(p => fmtPhone(p)).join(', ') : '—'}
          </span>
        </div>
      </div>
    ) : (
      <div className={styles.emptyState}>Данные не найдены</div>
    )}
  </div>
);

export const SecurityCard: FC<ISecurityCardProps> = ({
  email,
  isTwoFactorEnabled,
  onSetup2FA,
  onDisable2FA,
}) => (
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
        <span className={`${styles.vacationDetailValue} ${styles.twoFARow}`}>
          {isTwoFactorEnabled ? (
            <><span className={styles.statusOn}>Включена</span><button className={`${styles.twoFABtn} ${styles.twoFABtnDisable}`} onClick={onDisable2FA}>Отключить</button></>
          ) : (
            <><span className={styles.statusOff}>Отключена</span><button className={`${styles.twoFABtn} ${styles.twoFABtnEnable}`} onClick={onSetup2FA}>Включить</button></>
          )}
        </span>
      </div>
    </div>
  </div>
);
