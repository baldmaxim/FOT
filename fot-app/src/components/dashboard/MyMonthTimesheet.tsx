import { type FC, useMemo, useState } from 'react';
import { useEmployeeTimesheetMonth } from '../../hooks/useEmployeeTimesheet';
import type { TimesheetEntry, TimesheetStatus } from '../../types';
import styles from './MyMonthTimesheet.module.css';

const WEEKDAY_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

const STATUS_LABELS: Record<string, string> = {
  work: 'Работа',
  manual: 'Работа',
  remote: 'Удалёнка',
  sick: 'Больничный',
  vacation: 'Отпуск',
  dayoff: 'Выходной',
  absent: 'Неявка',
  business_trip: 'Командировка',
  unpaid: 'Без содержания',
};

const STATUS_CSS: Record<string, string> = {
  work: 'cellWork',
  manual: 'cellWork',
  remote: 'cellRemote',
  sick: 'cellSick',
  vacation: 'cellVacation',
  dayoff: 'cellWeekend',
  absent: 'cellAbsent',
  business_trip: 'cellTrip',
  unpaid: 'cellAbsent',
};

const pad = (n: number) => String(n).padStart(2, '0');

const buildIsoDate = (year: number, month: number, day: number) =>
  `${year}-${pad(month)}-${pad(day)}`;

interface IMyMonthTimesheetProps {
  employeeId: number | null;
  onSubmitRequest: (selectedDates: string[]) => void;
}

export const MyMonthTimesheet: FC<IMyMonthTimesheetProps> = ({ employeeId, onSubmitRequest }) => {
  const today = useMemo(() => new Date(), []);
  const currentYear = today.getFullYear();
  const currentMonth = today.getMonth() + 1;
  const todayIso = useMemo(() => buildIsoDate(currentYear, currentMonth, today.getDate()), [currentYear, currentMonth, today]);

  const [monthOffset, setMonthOffset] = useState<0 | -1>(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const { year, month } = useMemo(() => {
    const d = new Date(currentYear, currentMonth - 1 + monthOffset, 1);
    return { year: d.getFullYear(), month: d.getMonth() + 1 };
  }, [currentYear, currentMonth, monthOffset]);

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

  const daysInMonth = new Date(year, month, 0).getDate();
  const firstDow = (() => {
    const d = new Date(year, month - 1, 1).getDay();
    return d === 0 ? 6 : d - 1;
  })();

  const cells: Array<{ day: number; iso: string; isFuture: boolean; isToday: boolean; isWeekend: boolean; entry: TimesheetEntry | null } | null> = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) {
    const iso = buildIsoDate(year, month, day);
    const dow = new Date(year, month - 1, day).getDay();
    const isWeekend = dow === 0 || dow === 6;
    cells.push({
      day,
      iso,
      isFuture: iso > todayIso,
      isToday: iso === todayIso,
      isWeekend,
      entry: entriesByDay.get(day) || null,
    });
  }

  const toggleDay = (iso: string, disabled: boolean) => {
    if (disabled) return;
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(iso)) next.delete(iso);
      else next.add(iso);
      return next;
    });
  };

  const handleSubmit = () => {
    if (selected.size === 0) return;
    const dates = Array.from(selected).sort();
    onSubmitRequest(dates);
    setSelected(new Set());
  };

  const monthLabel = new Date(year, month - 1, 1)
    .toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });

  const getCellStatus = (entry: TimesheetEntry | null, status: TimesheetStatus | null): string => {
    if (!entry || !status) return '';
    return STATUS_CSS[status] || '';
  };

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <h2 className={styles.title}>Мой табель — {monthLabel}</h2>
        <div className={styles.monthSwitch}>
          <button
            className={`${styles.monthBtn} ${monthOffset === -1 ? styles.monthBtnActive : ''}`}
            onClick={() => setMonthOffset(-1)}
          >
            Прошлый
          </button>
          <button
            className={`${styles.monthBtn} ${monthOffset === 0 ? styles.monthBtnActive : ''}`}
            onClick={() => setMonthOffset(0)}
          >
            Текущий
          </button>
        </div>
      </div>

      <div className={styles.weekdays}>
        {WEEKDAY_SHORT.map(d => <div key={d} className={styles.weekday}>{d}</div>)}
      </div>

      <div className={styles.grid}>
        {cells.map((cell, idx) => {
          if (!cell) return <div key={`pad-${idx}`} className={styles.padCell} />;
          const status = cell.entry?.status ?? null;
          const isSelected = selected.has(cell.iso);
          const cellCls = [
            styles.cell,
            cell.isToday ? styles.cellToday : '',
            cell.isWeekend && !cell.entry ? styles.cellWeekend : '',
            cell.entry ? styles[getCellStatus(cell.entry, status)] : '',
            cell.isFuture && !cell.entry ? styles.cellEmpty : '',
            isSelected ? styles.cellSelected : '',
            cell.entry?.is_correction ? styles.cellCorrection : '',
          ].filter(Boolean).join(' ');

          const title = cell.entry
            ? `${cell.day}: ${STATUS_LABELS[status as string] || status || '—'}${cell.entry.hours_worked ? ` (${cell.entry.hours_worked}ч)` : ''}${cell.entry.is_correction ? ' • корр.' : ''}`
            : `${cell.day}${cell.isWeekend ? ' (выходной)' : ''}`;

          return (
            <button
              key={cell.iso}
              type="button"
              className={cellCls}
              onClick={() => toggleDay(cell.iso, false)}
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
        <span><i className={`${styles.dot} ${styles.cellRemote}`}/>Удалёнка</span>
        <span><i className={`${styles.dot} ${styles.cellSick}`}/>Больничный</span>
        <span><i className={`${styles.dot} ${styles.cellVacation}`}/>Отпуск</span>
        <span><i className={`${styles.dot} ${styles.cellAbsent}`}/>Неявка</span>
      </div>

      {selected.size > 0 && (
        <div className={styles.actionBar}>
          <span className={styles.selectedInfo}>Выбрано дней: <b>{selected.size}</b></span>
          <button className={styles.clearBtn} onClick={() => setSelected(new Set())}>
            Очистить
          </button>
          <button className={styles.submitBtn} onClick={handleSubmit}>
            Подать заявку на выбранные дни
          </button>
        </div>
      )}
    </div>
  );
};
