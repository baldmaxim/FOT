import { type FC, useMemo, useState } from 'react';
import { useEmployeeTimesheetMonth } from '../../hooks/useEmployeeTimesheet';
import { useAuth } from '../../contexts/AuthContext';
import { getFullDayThresholdHoursForDay, isScheduleDayOff } from '../../utils/scheduleUtils';
import { getDayStatus, type DayStatus } from '../../utils/dayStatus';
import type { TimesheetEntry } from '../../types';
import styles from './MyMonthTimesheet.module.css';

const WEEKDAY_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

// DayStatus → CSS-класс ячейки этого виджета (зеркалит STATUS_TO_GRID_CLASS
// из dayStatus.ts, но на классы MyMonthTimesheet.module.css).
const STATUS_TO_CSS: Record<DayStatus, string> = {
  present: 'cellWork',
  underwork: 'cellUnderwork',
  absent: 'cellAbsent',
  incomplete_skud: 'cellAbsent',
  sick: 'cellSick',
  vacation: 'cellVacation',
  remote: 'cellRemote',
  unpaid: 'cellAbsent',
  educational_leave: 'cellVacation',
  weekend: 'cellWeekend',
  future: 'cellEmpty',
  empty: 'cellEmpty',
};

// Подписи статусов для tooltip. Сохраняем привычное слово «Неявка»
// (в общем STATUS_LABEL_RU — «Прогул»), терминологию виджета не меняем.
const STATUS_LABEL: Record<DayStatus, string> = {
  present: 'Работа',
  underwork: 'Недоработка',
  absent: 'Неявка',
  incomplete_skud: 'СКУД без часов',
  sick: 'Больничный',
  vacation: 'Отпуск',
  remote: 'Удалёнка',
  unpaid: 'За свой счёт',
  educational_leave: 'Учебный отпуск',
  weekend: 'Выходной',
  future: 'Будущий день',
  empty: '—',
};

const pad = (n: number) => String(n).padStart(2, '0');

const buildIsoDate = (year: number, month: number, day: number) =>
  `${year}-${pad(month)}-${pad(day)}`;

interface IMyMonthTimesheetProps {
  employeeId: number | null;
  activeDayIso?: string | null;
  onDayActivate?: (date: string) => void;
  noCard?: boolean;
}

export const MyMonthTimesheet: FC<IMyMonthTimesheetProps> = ({ employeeId, activeDayIso, onDayActivate, noCard }) => {
  const { showActualHours, timesheetMonthsBack, timesheetMonthsForward } = useAuth();
  const today = useMemo(() => new Date(), []);
  const currentYear = today.getFullYear();
  const currentMonth = today.getMonth() + 1;
  const todayIso = useMemo(() => buildIsoDate(currentYear, currentMonth, today.getDate()), [currentYear, currentMonth, today]);

  // Окно доступных месяцев берётся из роли (system_roles.timesheet_months_back /
  // timesheet_months_forward, миграция 094). offset клампится в [minOffset, maxOffset]
  // на случай сужения окна после смены роли.
  const minOffset = -timesheetMonthsBack;
  const maxOffset = timesheetMonthsForward;
  const [monthOffset, setMonthOffset] = useState<number>(0);
  const offset = Math.min(maxOffset, Math.max(minOffset, monthOffset));

  const { year, month } = useMemo(() => {
    const d = new Date(currentYear, currentMonth - 1 + offset, 1);
    return { year: d.getFullYear(), month: d.getMonth() + 1 };
  }, [currentYear, currentMonth, offset]);

  const monthKey = `${year}-${pad(month)}`;
  const timesheetQuery = useEmployeeTimesheetMonth(employeeId, monthKey, !!employeeId);

  const entriesByDay = useMemo(() => {
    const map = new Map<number, TimesheetEntry>();
    const entries = timesheetQuery.data?.entries || [];
    for (const e of entries) {
      if (e.employee_id !== employeeId) continue;
      const d = new Date(e.work_date + 'T00:00:00');
      map.set(d.getDate(), e);
    }
    return map;
  }, [timesheetQuery.data, employeeId]);

  const employeeSchedule = employeeId ? timesheetQuery.data?.schedules?.[employeeId] : undefined;
  const calendar = timesheetQuery.data?.calendar ?? null;

  const daysInMonth = new Date(year, month, 0).getDate();
  const firstDow = (() => {
    const d = new Date(year, month - 1, 1).getDay();
    return d === 0 ? 6 : d - 1;
  })();

  const cells: Array<{ day: number; iso: string; isToday: boolean; entry: TimesheetEntry | null; ds: DayStatus } | null> = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) {
    const iso = buildIsoDate(year, month, day);
    const entry = entriesByDay.get(day) || null;
    const isScheduledDayOff = isScheduleDayOff(employeeSchedule, calendar, year, month, day);
    const fullDayThresholdHours = getFullDayThresholdHoursForDay(employeeSchedule, calendar, year, month, day);
    const ds = getDayStatus(entry, {
      showActualHours,
      fullDayThresholdHours,
      isScheduledDayOff,
      isFuture: iso > todayIso,
    });
    cells.push({ day, iso, isToday: iso === todayIso, entry, ds });
  }

  const monthLabel = new Date(year, month - 1, 1)
    .toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });

  return (
    <div className={`${styles.root}${noCard ? ` ${styles.rootNoCard}` : ''}`}>
      <div className={styles.header}>
        <button
          type="button"
          className={styles.monthBtn}
          onClick={() => setMonthOffset(o => Math.max(minOffset, Math.min(maxOffset, o) - 1))}
          disabled={offset <= minOffset}
          aria-label="Предыдущий месяц"
        >
          ◀
        </button>
        <h2 className={styles.title}>{monthLabel}</h2>
        <button
          type="button"
          className={styles.monthBtn}
          onClick={() => setMonthOffset(o => Math.min(maxOffset, Math.max(minOffset, o) + 1))}
          disabled={offset >= maxOffset}
          aria-label="Следующий месяц"
        >
          ▶
        </button>
      </div>

      <div className={styles.weekdays}>
        {WEEKDAY_SHORT.map(d => <div key={d} className={styles.weekday}>{d}</div>)}
      </div>

      <div className={styles.grid}>
        {cells.map((cell, idx) => {
          if (!cell) return <div key={`pad-${idx}`} className={styles.padCell} />;
          const isActive = cell.iso === activeDayIso;
          const cellCls = [
            styles.cell,
            cell.isToday ? styles.cellToday : '',
            styles[STATUS_TO_CSS[cell.ds]] || '',
            isActive ? styles.cellActive : '',
            cell.entry?.is_correction ? styles.cellCorrection : '',
          ].filter(Boolean).join(' ');

          const label = STATUS_LABEL[cell.ds];
          const title = cell.entry
            ? `${cell.day}: ${label}${cell.entry.hours_worked ? ` (${cell.entry.hours_worked}ч)` : ''}${cell.entry.is_correction ? ' • корр.' : ''}`
            : `${cell.day}${cell.ds === 'weekend' ? ' (выходной)' : ''}`;

          return (
            <button
              key={cell.iso}
              type="button"
              className={cellCls}
              onClick={() => onDayActivate?.(cell.iso)}
              title={title}
            >
              <span className={styles.cellDay}>{cell.day}</span>
              {cell.entry?.hours_worked ? (
                <span className={styles.cellHours}>{cell.entry.hours_worked}ч</span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div className={styles.legend}>
        <span><i className={`${styles.dot} ${styles.cellWork}`}/>Работа</span>
        <span><i className={`${styles.dot} ${styles.cellUnderwork}`}/>Недоработка</span>
        <span><i className={`${styles.dot} ${styles.cellRemote}`}/>Удалёнка</span>
        <span><i className={`${styles.dot} ${styles.cellSick}`}/>Больничный</span>
        <span><i className={`${styles.dot} ${styles.cellVacation}`}/>Отпуск</span>
        <span><i className={`${styles.dot} ${styles.cellWeekend}`}/>Выходной</span>
        <span><i className={`${styles.dot} ${styles.cellAbsent}`}/>Неявка</span>
      </div>
    </div>
  );
};
