import { type FC, useMemo } from 'react';
import { getDaysInMonth, isToday, isWeekend, toISODate } from '../../utils/calendarUtils';
import styles from './ProductionCalendarPage.module.css';

const WEEKDAY_HEADERS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

export type CalendarMode = 'holiday' | 'mandatory' | 'pre_holiday';

interface IMonthCalendarProps {
  year: number;
  month: number;
  holidays: string[];
  mandatoryHolidays: string[];
  preHolidays: string[];
  mode: CalendarMode;
  onToggleDay: (iso: string) => void;
}

interface ICell {
  iso: string | null;
  day: number | null;
  inMonth: boolean;
}

const buildGrid = (year: number, month: number): ICell[] => {
  const daysInMonth = getDaysInMonth(year, month);
  const firstDow = new Date(year, month - 1, 1).getDay();
  const leading = firstDow === 0 ? 6 : firstDow - 1;

  const cells: ICell[] = [];
  for (let i = 0; i < leading; i++) {
    cells.push({ iso: null, day: null, inMonth: false });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ iso: toISODate(year, month, d), day: d, inMonth: true });
  }
  while (cells.length % 7 !== 0) {
    cells.push({ iso: null, day: null, inMonth: false });
  }
  return cells;
};

export const MonthCalendar: FC<IMonthCalendarProps> = ({
  year,
  month,
  holidays,
  mandatoryHolidays,
  preHolidays,
  mode,
  onToggleDay,
}) => {
  const cells = useMemo(() => buildGrid(year, month), [year, month]);
  const holidaySet = useMemo(() => new Set(holidays), [holidays]);
  const mandatorySet = useMemo(() => new Set(mandatoryHolidays), [mandatoryHolidays]);
  const preSet = useMemo(() => new Set(preHolidays), [preHolidays]);

  return (
    <div className={styles.calendar}>
      <div className={styles.weekdayHeader}>
        {WEEKDAY_HEADERS.map(w => (
          <div key={w} className={styles.weekdayCell}>{w}</div>
        ))}
      </div>
      <div className={styles.daysGrid}>
        {cells.map((cell, i) => {
          if (!cell.inMonth || !cell.iso || cell.day === null) {
            return <div key={i} className={`${styles.dayBtn} ${styles.dayBtnOutside}`} />;
          }
          const isHoliday = holidaySet.has(cell.iso);
          const isMandatory = mandatorySet.has(cell.iso);
          const isPreHoliday = preSet.has(cell.iso);
          const weekend = isWeekend(year, month, cell.day);
          const today = isToday(year, month, cell.day);

          const classes = [styles.dayBtn];
          if (weekend) classes.push(styles.dayBtnWeekend);
          if (isHoliday) classes.push(styles.dayBtnHoliday);
          if (isMandatory) classes.push(styles.dayBtnMandatory);
          if (isPreHoliday) classes.push(styles.dayBtnPreHoliday);
          if (today) classes.push(styles.dayBtnToday);

          const title = `${cell.iso}${isMandatory ? ' • всегда-выходной' : ''}${isHoliday ? ' • праздник' : ''}${isPreHoliday ? ' • предпраздничный (-1ч)' : ''}`;

          const pressed =
            mode === 'holiday' ? isHoliday :
            mode === 'mandatory' ? isMandatory :
            isPreHoliday;

          return (
            <button
              key={cell.iso}
              type="button"
              className={classes.join(' ')}
              onClick={() => onToggleDay(cell.iso!)}
              title={title}
              aria-pressed={pressed}
            >
              {cell.day}
            </button>
          );
        })}
      </div>
    </div>
  );
};
