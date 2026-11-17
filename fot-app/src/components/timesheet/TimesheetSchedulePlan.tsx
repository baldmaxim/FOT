import { useMemo, type FC } from 'react';
import type { ISchedulePlanDay, ISchedulePlanMonth } from '../../types/timesheet';
import { isSchedulePlanMissing, useEmployeeSchedulePlan } from '../../hooks/useEmployeeSchedulePlan';
import {
  MONTH_NAMES_RU,
  daysInPlanMonth,
  formatPlanDayTooltip,
  formatPlanHours,
  formatPlanMinutes,
  formatPlanPeriods,
} from '../../utils/schedulePlan';
import styles from './TimesheetSchedulePlan.module.css';

interface ITimesheetSchedulePlanProps {
  employeeId: number;
  /** Месяц табеля YYYY-MM: год блока и подсвеченная строка. */
  month: string;
}

const DAY_NUMBERS = Array.from({ length: 31 }, (_, index) => index + 1);

const DAY_KIND_CLASS: Record<ISchedulePlanDay['kind'], string> = {
  work: styles.dayWork,
  off: styles.dayOff,
  holiday: styles.dayOff,
  pre_holiday: styles.dayPre,
};

interface IPlanRowProps {
  year: number;
  plan: ISchedulePlanMonth;
  selected: boolean;
  showSundays: boolean;
}

const PlanRow: FC<IPlanRowProps> = ({ year, plan, selected, showSundays }) => {
  const total = daysInPlanMonth(year, plan.month);
  const byDay = new Map(plan.days.map(day => [day.day, day]));
  return (
    <tr className={selected ? styles.rowSelected : undefined} aria-current={selected ? 'true' : undefined}>
      <th scope="row" className={styles.monthCell}>{MONTH_NAMES_RU[plan.month - 1]}</th>
      <td className={styles.totalCell}>{plan.employed && plan.norm_days != null ? plan.norm_days : '—'}</td>
      <td className={styles.totalCell}>
        {plan.employed && plan.norm_minutes != null ? formatPlanMinutes(plan.norm_minutes) : '—'}
      </td>
      <td className={styles.totalCell}>{plan.employed && plan.saturdays > 0 ? plan.saturdays : ''}</td>
      {showSundays && <td className={styles.totalCell}>{plan.employed && plan.sundays > 0 ? plan.sundays : ''}</td>}
      {DAY_NUMBERS.map(dayNumber => {
        if (dayNumber > total) return <td key={dayNumber} className={styles.dayMissing} />;
        const day = byDay.get(dayNumber);
        if (!plan.employed || !day) return <td key={dayNumber} className={styles.dayNone} />;
        return (
          <td
            key={dayNumber}
            className={DAY_KIND_CLASS[day.kind]}
            data-tooltip={formatPlanDayTooltip(year, plan.month, day)}
          >
            {day.hours > 0 ? formatPlanHours(day.hours) : ''}
          </td>
        );
      })}
    </tr>
  );
};

/**
 * Блок «График работы» под табелем «По сотруднику»: год по графику, как форма графика в 1С. Дни и часы месяца — норма
 * графика (то же правило, что у зарплаты по часам), «Сб» — квота обязательных суббот: к датам она не привязана.
 */
export const TimesheetSchedulePlan: FC<ITimesheetSchedulePlanProps> = ({ employeeId, month }) => {
  const { data, isLoading, isError, error, refetch, isFetching } = useEmployeeSchedulePlan(employeeId, month, true);
  const selectedMonth = Number(month.slice(5, 7));
  const showSundays = useMemo(() => Boolean(data?.months.some(item => item.sundays > 0)), [data]);

  if (isError && isSchedulePlanMissing(error)) return null;

  return (
    <section className={styles.card} aria-label="График работы">
      <header className={styles.head}>
        <h3 className={styles.title}>График работы</h3>
        {data && <span className={styles.name}>{formatPlanPeriods(data.periods)}</span>}
        {data && <span className={styles.year}>{data.year}</span>}
      </header>
      {isLoading ? (
        <div className={styles.state}>Загрузка графика…</div>
      ) : isError || !data ? (
        <div className={styles.state}>
          <span>Не удалось загрузить график</span>
          <button type="button" className={styles.retry} onClick={() => { void refetch(); }} disabled={isFetching}>
            Повторить
          </button>
        </div>
      ) : (
        <div className={styles.scroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col" className={styles.monthCell}>Месяц</th>
                <th scope="col" className={styles.totalCell}>Дней</th>
                <th scope="col" className={styles.totalCell}>Часов</th>
                <th scope="col" className={styles.totalCell} data-tooltip="Обязательные субботы по графику, любые в месяце">
                  Сб
                </th>
                {showSundays && (
                  <th scope="col" className={styles.totalCell} data-tooltip="Обязательные воскресенья по графику, любые в месяце">
                    Вс
                  </th>
                )}
                {DAY_NUMBERS.map(dayNumber => (
                  <th key={dayNumber} scope="col" className={styles.dayHead}>{dayNumber}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.months.map(item => (
                <PlanRow
                  key={item.month}
                  year={data.year}
                  plan={item}
                  selected={item.month === selectedMonth}
                  showSundays={showSundays}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};
