import type { FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';

import {
  payrollService,
  VACATION_STATUS_LABELS,
  type IVacationPeriod,
  type IVacationSummary,
} from '../../services/payrollService';
import { pluralDays } from '../../utils/dateCompact';
import { formatDate } from '../../utils/formatMoney';
import styles from './PayrollDisclosure.module.css';

interface IEmployeeVacationSectionProps {
  employeeId: number;
}

const days = (count: number): string => `${count} ${pluralDays(count)}`;

/** Сводка видна и в свёрнутом блоке: год, использовано, запланировано, без сохранения ЗП. */
const formatSummary = (summary: IVacationSummary): string => (
  `${summary.year}: использовано ${days(summary.used_days)} · запланировано ${days(summary.planned_days)}`
  + ` · без сохранения ЗП ${days(summary.unpaid_days)}`
);

const formatPeriod = (period: IVacationPeriod): string => (
  period.start_date === period.end_date
    ? formatDate(period.start_date)
    : `${formatDate(period.start_date)} – ${formatDate(period.end_date)}`
);

/** Праздничные дни важны только ежегодному отпуску: в его дни они не входят (ст. 120 ТК). */
const formatDays = (period: IVacationPeriod): string => (
  period.status === 'vacation' && period.holiday_days > 0
    ? `${days(period.calendar_days)}, из них праздничных ${period.holiday_days}`
    : days(period.calendar_days)
);

const formatSource = (period: IVacationPeriod): string => {
  if (period.source === 'timesheet') return 'Отметка в табеле';
  return period.reviewer_name ? `Заявление, согласовал ${period.reviewer_name}` : 'Заявление';
};

/**
 * «Отпуска» — раскрываемый блок, свёрнут по умолчанию, сводка видна всегда. В раскрытии —
 * пояснение и все периоды с основанием и согласованием. Свой запрос: сбой не мешает форме.
 */
export const EmployeeVacationSection: FC<IEmployeeVacationSectionProps> = ({ employeeId }) => {
  const vacationQuery = useQuery({
    queryKey: ['payroll-vacation', employeeId],
    queryFn: ({ signal }) => payrollService.getVacation(employeeId, signal),
    staleTime: 30_000,
  });
  const { data } = vacationQuery;

  let meta: string;
  if (data) meta = formatSummary(data.summary);
  else if (vacationQuery.isError) meta = 'не удалось загрузить';
  else meta = 'загрузка…';

  return (
    <details className={styles.disclosure}>
      <summary className={styles.summary}>
        <span className={styles.summaryHead}>
          <ChevronRight size={16} className={styles.chevron} aria-hidden="true" />
          <span className={styles.summaryTitle}>Отпуска</span>
        </span>
        <span className={vacationQuery.isError ? `${styles.summaryMeta} ${styles.summaryMetaError}` : styles.summaryMeta}>
          {meta}
        </span>
      </summary>

      <div className={styles.content}>
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
            <p className={styles.hint}>
              По табелю. Ежегодный отпуск — в календарных днях без нерабочих праздничных (ст. 120 ТК).
            </p>
            {data.history.length === 0 ? (
              <p className={styles.state}>Отпусков в табеле нет.</p>
            ) : (
              <ul className={styles.list}>
                {data.history.map(period => (
                  <li
                    key={`${period.start_date}|${period.status}|${period.leave_request_id ?? period.source}`}
                    className={styles.item}
                  >
                    <div className={styles.itemHead}>
                      <span className={styles.itemPrimary}>{formatPeriod(period)}</span>
                      <span className={styles.itemSecondary}>{formatDays(period)}</span>
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
      </div>
    </details>
  );
};
