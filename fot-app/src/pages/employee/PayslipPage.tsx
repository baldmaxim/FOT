import { type FC, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { EmployeePayslip } from '../../components/employee/EmployeePayslip';
import { employeePayslipService } from '../../services/employeePayslipService';
import { formatVacationDays } from '../../utils/employeePayslip';
import { formatDate } from '../../utils/formatMoney';
import { moscowTodayIso } from '../../utils/moscowDate';
import { formatMonthLabel } from '../../utils/timesheetApprovalPeriod';
import styles from './PayslipPage.module.css';

const SUMMARY_KEY = ['my-payslip', 'summary'] as const;

/** Ошибка загрузки с «Повторить». */
const LoadError: FC<{ onRetry: () => void }> = ({ onRetry }) => (
  <div className={styles.error} role="alert">
    <span>Не удалось загрузить расчётный лист</span>
    <button type="button" className={styles.retry} onClick={onRetry}>Повторить</button>
  </div>
);

/** Листок выбранного месяца: готов / ещё не готов / ошибка. */
const MonthPayslip: FC<{ month: string }> = ({ month }) => {
  const query = useQuery({
    queryKey: ['my-payslip', 'month', month] as const,
    queryFn: () => employeePayslipService.getMonth(month),
    staleTime: 5 * 60_000,
  });
  if (query.isPending) return <p className={styles.hint}>Загрузка…</p>;
  if (query.isError) return <LoadError onRetry={() => { void query.refetch(); }} />;
  if (query.data.state === 'not_ready') {
    return <p className={styles.empty}>Расчёт за {formatMonthLabel(month).toLowerCase()} ещё не готов</p>;
  }
  return <EmployeePayslip payslip={query.data} />;
};

/**
 * ЛК «Расчётный лист»: остаток отпуска на сегодня, выбор месяца и листок за месяц. Сотрудник — только свой (сервер
 * берёт его из сессии); видна страница списку employee_payslip_access или всем по настройке (миграция 353).
 */
export const PayslipPage: FC = () => {
  const summary = useQuery({
    queryKey: SUMMARY_KEY,
    queryFn: () => employeePayslipService.getSummary(),
    staleTime: 5 * 60_000,
  });
  const [selected, setSelected] = useState<string | null>(null);

  if (summary.isPending) return <div className={styles.page}><p className={styles.hint}>Загрузка…</p></div>;
  if (summary.isError) {
    return <div className={styles.page}><LoadError onRetry={() => { void summary.refetch(); }} /></div>;
  }

  const { months, vacation } = summary.data;
  const month = selected && months.includes(selected) ? selected : months[0] ?? null;
  const vacationDate = vacation && vacation.until !== moscowTodayIso() ? `на ${formatDate(vacation.until)}` : 'на сегодня';

  return (
    <div className={styles.page}>
      {(month !== null || vacation) && (
        <div className={styles.toolbar}>
          {month !== null && (
            <select
              className={styles.monthSelect}
              aria-label="Месяц"
              value={month}
              onChange={event => setSelected(event.target.value)}
            >
              {months.map(item => <option key={item} value={item}>{formatMonthLabel(item)}</option>)}
            </select>
          )}
          {vacation && (
            <section className={styles.vacation} aria-label="Остаток отпуска">
              <span className={styles.vacationLabel}>Остаток отпуска {vacationDate}</span>
              <span className={styles.vacationValue}>{formatVacationDays(vacation.days)} дн.</span>
            </section>
          )}
        </div>
      )}

      {month === null ? (
        <p className={styles.empty}>Расчётных листов пока нет</p>
      ) : (
        <MonthPayslip month={month} />
      )}
    </div>
  );
};
