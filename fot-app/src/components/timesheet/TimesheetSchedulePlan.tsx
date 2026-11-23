import { useMemo, useState, type CSSProperties, type FC, type ReactNode } from 'react';
import type { ISchedulePlanDay, ISchedulePlanMonth } from '../../types/timesheet';
import { isSchedulePlanMissing, useEmployeeSchedulePlan } from '../../hooks/useEmployeeSchedulePlan';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useSyncedScrollLeft } from '../../hooks/useSyncedScrollLeft';
import { useTimesheetGridGeometry, type ITimesheetGridGeometry } from '../../hooks/useTimesheetGridGeometry';
import { cx } from '../../utils/motion';
import {
  MONTH_NAMES_RU,
  PLAN_MAX_DAY,
  daysInPlanMonth,
  formatPlanDayTooltip,
  formatPlanHours,
  formatPlanMinutes,
  formatPlanPeriods,
  formatPlanWeekendQuota,
  schedulePlanDayNumbers,
} from '../../utils/schedulePlan';
import styles from './TimesheetSchedulePlan.module.css';

interface ITimesheetSchedulePlanProps {
  employeeId: number;
  /** Месяц табеля YYYY-MM: год блока и подсвеченная строка. */
  month: string;
  /** Дни сетки табеля («1–15», «16–конец», «Весь месяц»): на компьютере график показывает те же, день под днём. */
  visibleDays: readonly number[];
  /** Прокрутка сетки табеля: график прокручивается вместе с ней. */
  syncScrollWith?: HTMLElement | null;
}

/** Сетка табеля таблицей — шире 768px (useIsMobile(768) в TimesheetPage); уже — карточки, ровнять не с чем. */
const MOBILE_BREAKPOINT = 768;

const ALL_DAYS = Array.from({ length: PLAN_MAX_DAY }, (_, index) => index + 1);
/** Итог графика, когда у сетки табеля их не три (вид «По объектам» — один «Σ»): как min-width «Дни / Часы / Откл.». */
const TOTAL_WIDTH = 64;
const PLAN_TOTAL_COUNT = 3;

interface IPlanLayout {
  /** Ширины <col> по порядку: месяц, дни, итоги. */
  columns: number[];
  /** Отступы справа закреплённых итогов: второго и первого. */
  style: CSSProperties;
}

/**
 * Сетка графика по сетке табеля: «Месяц» — как «Сотрудник», день — как тот же день табеля (дней 29–31 у короткого
 * месяца нет — как последний), три итога — как «Дни / Часы / Откл.».
 */
const planLayout = (geometry: ITimesheetGridGeometry, dayNumbers: readonly number[]): IPlanLayout => {
  const gridDays = [...geometry.days.values()];
  const lastDay = gridDays[gridDays.length - 1];
  const totals = geometry.totals.length === PLAN_TOTAL_COUNT
    ? [...geometry.totals]
    : Array.from({ length: PLAN_TOTAL_COUNT }, () => TOTAL_WIDTH);
  return {
    columns: [geometry.first, ...dayNumbers.map(day => geometry.days.get(day) ?? lastDay), ...totals],
    style: {
      '--plan-stick1': `${totals[2]}px`,
      '--plan-stick2': `${totals[1] + totals[2]}px`,
    } as CSSProperties,
  };
};

const DAY_KIND_CLASS: Record<ISchedulePlanDay['kind'], string> = {
  work: styles.dayWork,
  off: styles.dayOff,
  holiday: styles.dayOff,
  pre_holiday: styles.dayPre,
};

interface IPlanTotal {
  key: string;
  label: string;
  tooltip?: string;
  value: (plan: ISchedulePlanMonth) => ReactNode;
}

const TOTAL_DAYS: IPlanTotal = {
  key: 'days',
  label: 'Дней',
  value: plan => (plan.employed && plan.norm_days != null ? plan.norm_days : '—'),
};
const TOTAL_HOURS: IPlanTotal = {
  key: 'hours',
  label: 'Часов',
  value: plan => (plan.employed && plan.norm_minutes != null ? formatPlanMinutes(plan.norm_minutes) : '—'),
};
const TOTAL_SATURDAYS: IPlanTotal = {
  key: 'saturdays',
  label: 'Сб',
  tooltip: 'Обязательные субботы по графику, любые в месяце',
  value: plan => (plan.employed && plan.saturdays > 0 ? plan.saturdays : ''),
};
const TOTAL_SUNDAYS: IPlanTotal = {
  key: 'sundays',
  label: 'Вс',
  tooltip: 'Обязательные воскресенья по графику, любые в месяце',
  value: plan => (plan.employed && plan.sundays > 0 ? plan.sundays : ''),
};
/** На компьютере итогов всегда три — напротив «Дни / Часы / Откл.» табеля: субботы и воскресенья — одним столбцом. */
const TOTAL_WEEKENDS: IPlanTotal = {
  key: 'weekends',
  label: 'Сб / Вс',
  tooltip: 'Обязательные субботы / воскресенья по графику, любые в месяце',
  value: plan => (plan.employed ? formatPlanWeekendQuota(plan.saturdays, plan.sundays) : ''),
};

/** Закреплённые справа итоги компьютера: отступ от правого края по позиции (как «Дни / Часы / Откл.»). */
const DESKTOP_TOTAL_CLASSES = [cx(styles.stick2, styles.totalEdge), styles.stick1, styles.stick0];

interface IPlanRowProps {
  year: number;
  plan: ISchedulePlanMonth;
  selected: boolean;
  dayNumbers: readonly number[];
  totals: readonly IPlanTotal[];
  totalClasses: readonly (string | undefined)[];
  /** Телефон: итоги слева, сразу после месяца. */
  totalsFirst: boolean;
}

const PlanRow: FC<IPlanRowProps> = ({ year, plan, selected, dayNumbers, totals, totalClasses, totalsFirst }) => {
  const monthDays = daysInPlanMonth(year, plan.month);
  const byDay = new Map(plan.days.map(day => [day.day, day]));
  const totalCells = totals.map((total, index) => (
    <td key={total.key} className={cx(styles.totalCell, totalClasses[index])}>{total.value(plan)}</td>
  ));
  return (
    <tr className={selected ? styles.rowSelected : undefined} aria-current={selected ? 'true' : undefined}>
      <th scope="row" className={styles.monthCell}>{MONTH_NAMES_RU[plan.month - 1]}</th>
      {totalsFirst && totalCells}
      {dayNumbers.map(dayNumber => {
        if (dayNumber > monthDays) return <td key={dayNumber} className={styles.dayMissing} />;
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
      {!totalsFirst && totalCells}
    </tr>
  );
};

/**
 * Блок «График работы» под табелем «По сотруднику»: год по графику, как форма графика в 1С. Дни и часы месяца — норма
 * графика (то же правило, что у зарплаты по часам), «Сб» — квота обязательных суббот: к датам она не привязана.
 * На компьютере геометрия как у сетки табеля (первый столбец 184px, день 42px, три итога справа) и общая прокрутка —
 * день графика стоит под тем же днём табеля; на телефоне — прежний вид: 1–31, итоги слева.
 */
export const TimesheetSchedulePlan: FC<ITimesheetSchedulePlanProps> = ({
  employeeId, month, visibleDays, syncScrollWith = null,
}) => {
  const { data, isLoading, isError, error, refetch, isFetching } = useEmployeeSchedulePlan(employeeId, month, true);
  const compact = useIsMobile(MOBILE_BREAKPOINT);
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  useSyncedScrollLeft(compact ? null : syncScrollWith, compact ? null : scrollElement);
  const geometry = useTimesheetGridGeometry(compact ? null : syncScrollWith);
  const selectedYear = Number(month.slice(0, 4));
  const selectedMonth = Number(month.slice(5, 7));
  const showSundays = useMemo(() => Boolean(data?.months.some(item => item.sundays > 0)), [data]);
  const dayNumbers = useMemo(
    () => (compact ? ALL_DAYS : schedulePlanDayNumbers(visibleDays, daysInPlanMonth(selectedYear, selectedMonth))),
    [compact, visibleDays, selectedYear, selectedMonth],
  );
  const totals = useMemo((): IPlanTotal[] => {
    if (!compact) return [TOTAL_DAYS, TOTAL_HOURS, showSundays ? TOTAL_WEEKENDS : TOTAL_SATURDAYS];
    return showSundays ? [TOTAL_DAYS, TOTAL_HOURS, TOTAL_SATURDAYS, TOTAL_SUNDAYS] : [TOTAL_DAYS, TOTAL_HOURS, TOTAL_SATURDAYS];
  }, [compact, showSundays]);
  const totalClasses = compact ? [] : DESKTOP_TOTAL_CLASSES;
  const layout = useMemo(() => (geometry ? planLayout(geometry, dayNumbers) : null), [geometry, dayNumbers]);

  if (isError && isSchedulePlanMissing(error)) return null;

  const totalHeads = totals.map((total, index) => (
    <th key={total.key} scope="col" className={cx(styles.totalCell, totalClasses[index])} data-tooltip={total.tooltip}>
      {total.label}
    </th>
  ));

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
        <div className={styles.scroll} ref={setScrollElement}>
          <table className={cx(styles.table, layout && styles.tableAligned)} style={layout?.style}>
            {layout && (
              <colgroup>
                {layout.columns.map((width, index) => (
                  // Порядок столбцов постоянный: месяц, дни, итоги — ключ по позиции.
                  <col key={index} style={{ width: `${width}px` }} />
                ))}
              </colgroup>
            )}
            <thead>
              <tr>
                <th scope="col" className={styles.monthCell}>Месяц</th>
                {compact && totalHeads}
                {dayNumbers.map(dayNumber => (
                  <th key={dayNumber} scope="col" className={styles.dayHead}>{dayNumber}</th>
                ))}
                {!compact && totalHeads}
              </tr>
            </thead>
            <tbody>
              {data.months.map(item => (
                <PlanRow
                  key={item.month}
                  year={data.year}
                  plan={item}
                  selected={item.month === selectedMonth}
                  dayNumbers={dayNumbers}
                  totals={totals}
                  totalClasses={totalClasses}
                  totalsFirst={compact}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};
