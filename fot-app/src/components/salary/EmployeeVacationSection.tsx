import type { FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';

import {
  payrollService,
  VACATION_STATUS_LABELS,
  type IVacationBalance,
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

const fractionFormatter = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** «7.21» → «7,21», «-2.05» → «−2,05». */
const formatFraction = (value: string): string => {
  const numeric = Number(value);
  return `${numeric < 0 ? '−' : ''}${fractionFormatter.format(Math.abs(numeric))}`;
};

/** Сводка видна и в свёрнутом блоке: год, использовано, запланировано, без сохранения ЗП, остаток. */
const formatSummary = (summary: IVacationSummary, balance: IVacationBalance | null): string => (
  `${summary.year}: использовано ${days(summary.used_days)} · запланировано ${days(summary.planned_days)}`
  + ` · без сохранения ЗП ${days(summary.unpaid_days)}`
  + (balance ? ` · остаток ${formatFraction(balance.current_days)} дн.` : '')
);

/** Расшифровка остатка одной строкой: откуда начальный, сколько начислено и отгулено. */
const formatBalance = (balance: IVacationBalance): string => {
  const accrued = `${formatFraction(balance.accrued_days)} за ${balance.accrued_months} мес.`;
  const parts = balance.source === '1c'
    ? `${formatFraction(balance.opening_days)} по 1С на ${formatDate(balance.as_of)} + ${accrued}`
      + ` − ${balance.used_days} отгулено после ${formatDate(balance.as_of)}`
    : `${accrued} с приёма ${formatDate(balance.as_of)} − ${balance.used_days} отгулено`;
  const unpaid = balance.unpaid_excess_days > 0
    ? `; без сохранения сверх 14 дн. в году — ${balance.unpaid_excess_days} дн. не в стаже (ст. 121 ТК)`
    : '';
  return `Остаток на ${formatDate(balance.until)}: ${formatFraction(balance.current_days)} дн. = ${parts}${unpaid}.`;
};

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
 * «Отпуска» — раскрываемый блок, свёрнут по умолчанию, сводка с остатком видна всегда. В раскрытии —
 * расшифровка остатка, пояснение и все периоды с основанием и согласованием.
 * Свой запрос: сбой не мешает форме.
 */
export const EmployeeVacationSection: FC<IEmployeeVacationSectionProps> = ({ employeeId }) => {
  const vacationQuery = useQuery({
    queryKey: ['payroll-vacation', employeeId],
    queryFn: ({ signal }) => payrollService.getVacation(employeeId, signal),
    staleTime: 30_000,
  });
  const { data } = vacationQuery;

  let meta: string;
  if (data) meta = formatSummary(data.summary, data.balance);
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
            {data.balance && <p className={styles.hint}>{formatBalance(data.balance)}</p>}
            <p className={styles.hint}>
              По табелю. Ежегодный отпуск — в календарных днях: выходные между днями отпуска входят,
              нерабочие праздничные — нет (ст. 120 ТК).
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
