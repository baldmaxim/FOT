import type { FC } from 'react';
import { useQuery } from '@tanstack/react-query';

import { payrollService, VACATION_STATUS_LABELS, type IVacationPeriod } from '../../services/payrollService';
import { formatDate } from '../../utils/formatMoney';
import styles from './EmployeeVacationSection.module.css';

interface IEmployeeVacationSectionProps {
  employeeId: number;
}

const formatPeriod = (period: IVacationPeriod): string => (
  period.start_date === period.end_date
    ? formatDate(period.start_date)
    : `${formatDate(period.start_date)} – ${formatDate(period.end_date)}`
);

/** Праздничные дни важны только ежегодному отпуску: в его дни они не входят (ст. 120 ТК). */
const formatDays = (period: IVacationPeriod): string => (
  period.status === 'vacation' && period.holiday_days > 0
    ? `${period.calendar_days} дн., из них праздничных ${period.holiday_days}`
    : `${period.calendar_days} дн.`
);

const formatSource = (period: IVacationPeriod): string => {
  if (period.source === 'timesheet') return 'Отметка в табеле';
  return period.reviewer_name ? `Заявление, согласовал ${period.reviewer_name}` : 'Заявление';
};

/**
 * Отпуск в карточке сотрудника: сколько отгулено в текущем году и история по табелю.
 * Свой запрос и своя ошибка: сбой здесь не мешает править условия оплаты.
 */
export const EmployeeVacationSection: FC<IEmployeeVacationSectionProps> = ({ employeeId }) => {
  const vacationQuery = useQuery({
    queryKey: ['payroll-vacation', employeeId],
    queryFn: ({ signal }) => payrollService.getVacation(employeeId, signal),
    staleTime: 30_000,
  });
  const { data } = vacationQuery;

  return (
    <section className={styles.section}>
      <h3 className={styles.title}>Отпуск</h3>

      {vacationQuery.isPending && <p className={styles.state}>Загрузка…</p>}
      {vacationQuery.isError && (
        <div className={styles.stateError}>
          <span>Не удалось загрузить отпуска</span>
          <button type="button" className={styles.retryButton} onClick={() => { void vacationQuery.refetch(); }}>
            Повторить
          </button>
        </div>
      )}

      {data && (
        <>
          <div className={styles.stats}>
            <div className={styles.stat}>
              <span className={styles.statValue}>{data.summary.used_days}</span>
              <span className={styles.statLabel}>дн. отгулено в {data.summary.year}</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statValue}>{data.summary.planned_days}</span>
              <span className={styles.statLabel}>дн. запланировано</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statValue}>{data.summary.unpaid_days}</span>
              <span className={styles.statLabel}>дн. без сохранения ЗП в {data.summary.year}</span>
            </div>
          </div>
          <p className={styles.hint}>
            По табелю. Ежегодный отпуск — в календарных днях без нерабочих праздничных (ст. 120 ТК).
          </p>

          {data.history.length === 0 ? (
            <p className={styles.state}>Отпусков в табеле нет</p>
          ) : (
            <ul className={styles.list}>
              {data.history.map(period => (
                <li
                  key={`${period.start_date}|${period.status}|${period.leave_request_id ?? period.source}`}
                  className={styles.item}
                >
                  <div className={styles.itemHead}>
                    <span className={styles.period}>{formatPeriod(period)}</span>
                    <span className={styles.days}>{formatDays(period)}</span>
                  </div>
                  <div className={styles.itemMeta}>
                    {VACATION_STATUS_LABELS[period.status]} · {formatSource(period)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
};
