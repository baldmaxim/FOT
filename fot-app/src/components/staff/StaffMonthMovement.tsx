import { memo, type FC } from 'react';
import type { IStaffMonthMovement, StaffPeriod } from '../../services/employeeService';

interface IStaffMonthMovementProps {
  data: IStaffMonthMovement | undefined;
  isError: boolean;
  period: StaffPeriod | null;
  onToggle: (period: StaffPeriod) => void;
}

const MONTHS_GENITIVE = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

/** «С 1 сентября 2026» — месяц и год из month_start сервера (текущий месяц по Москве). */
const monthLabel = (monthStart: string): string =>
  `С 1 ${MONTHS_GENITIVE[Number(monthStart.slice(5, 7)) - 1] ?? ''} ${monthStart.slice(0, 4)}`;

/** Чипы «Устроены +N / Уволены −N» с начала месяца; клик показывает этих сотрудников. */
export const StaffMonthMovement: FC<IStaffMonthMovementProps> = memo(({ data, isError, period, onToggle }) => {
  if (isError) return <span className="sc-movement sc-muted" title="Не удалось посчитать">С начала месяца: —</span>;
  const hired = data?.hired;
  const fired = data?.fired;
  return (
    <div className="sc-movement" role="group" aria-label="Движение сотрудников с начала месяца">
      <span className="sc-movement-label">{data ? monthLabel(data.month_start) : 'С начала месяца'}:</span>
      <button
        type="button"
        className={`sc-movement-chip sc-movement-chip--hired${period === 'hired_month' ? ' is-active' : ''}`}
        aria-pressed={period === 'hired_month'}
        onClick={() => onToggle('hired_month')}
        disabled={!data}
        title={period === 'hired_month' ? 'Показать всех действующих' : 'Показать устроенных с начала месяца'}
      >
        Устроены <strong>+{hired ?? '…'}</strong>
      </button>
      <button
        type="button"
        className={`sc-movement-chip sc-movement-chip--fired${period === 'fired_month' ? ' is-active' : ''}`}
        aria-pressed={period === 'fired_month'}
        onClick={() => onToggle('fired_month')}
        disabled={!data}
        title={period === 'fired_month' ? 'Показать всех уволенных' : 'Показать уволенных с начала месяца'}
      >
        Уволены <strong>−{fired ?? '…'}</strong>
      </button>
    </div>
  );
});
