import { useMemo, type FC } from 'react';
import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react';
import { getFirstDayOffset, getDaysInMonth, type IDayAttendance } from '../../utils/attendanceCalc';

const MONTH_NAMES = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

const DAY_HEADERS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

interface IAttendanceCalendarProps {
  days: IDayAttendance[];
  month: number;
  year: number;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  onDayClick?: (day: number) => void;
  onDayPrefetch?: (day: number) => void;
  selectedDay?: number | null;
  loading?: boolean;
}

const formatWorkedTime = (totalSeconds: number): string => {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  return m > 0 ? `${h}ч${m}м` : `${h}ч`;
};

export const AttendanceCalendar: FC<IAttendanceCalendarProps> = ({
  days, month, year, onPrevMonth, onNextMonth, onDayClick, onDayPrefetch, selectedDay = null, loading = false,
}) => {
  const today = new Date();
  const isToday = (day: number) =>
    today.getFullYear() === year && today.getMonth() === month && today.getDate() === day;

  const offset = useMemo(() => getFirstDayOffset(year, month), [year, month]);
  const daysInMonth = useMemo(() => getDaysInMonth(year, month), [year, month]);

  const dayMap = useMemo(() => {
    const m = new Map<number, IDayAttendance>();
    for (const d of days) m.set(d.day, d);
    return m;
  }, [days]);

  const emptyCells = Array.from({ length: offset }, (_, i) => (
    <div key={`e-${i}`} className="ec-cal-day empty" />
  ));

  const trailingEmpty = (7 - ((offset + daysInMonth) % 7)) % 7;
  const trailingCells = Array.from({ length: trailingEmpty }, (_, i) => (
    <div key={`t-${i}`} className="ec-cal-day empty" />
  ));

  return (
    <div className="ec-card">
      <div className="ec-card-header">
        <div className="ec-card-title">
          <Calendar size={18} />
          Календарь посещаемости
        </div>
      </div>
      <div className="ec-calendar">
        <div className="ec-cal-header">
          <div className="ec-cal-nav">
            <button className="ec-cal-nav-btn" onClick={onPrevMonth}>
              <ChevronLeft size={16} />
            </button>
            <span className="ec-cal-month">{MONTH_NAMES[month]} {year}</span>
            <button className="ec-cal-nav-btn" onClick={onNextMonth}>
              <ChevronRight size={16} />
            </button>
          </div>
          <div className="ec-cal-legend">
            <div className="ec-legend-item"><span className="ec-legend-dot present" /> Норма / переработка</div>
            <div className="ec-legend-item"><span className="ec-legend-dot underwork" /> Недоработка</div>
            <div className="ec-legend-item"><span className="ec-legend-dot absent" /> Отсутствие</div>
            <div className="ec-legend-item"><span className="ec-legend-dot weekend" /> Выходной</div>
          </div>
        </div>

        {loading ? (
          <div className="ec-loading">Загрузка табеля...</div>
        ) : (
          <div className="ec-cal-grid">
            {DAY_HEADERS.map(h => (
              <div key={h} className="ec-cal-day-header">{h}</div>
            ))}
            {emptyCells}
            {Array.from({ length: daysInMonth }, (_, i) => {
              const day = i + 1;
              const data = dayMap.get(day);
              const status = data?.status || '';
              const classes = [
                'ec-cal-day',
                status,
                isToday(day) ? 'today' : '',
                selectedDay === day ? 'selected' : '',
              ].filter(Boolean).join(' ');

              const clickable = data && data.status !== 'future' && data.status !== 'weekend';
              return (
                <div
                  key={day}
                  className={`${classes}${clickable ? ' clickable' : ''}`}
                  onClick={() => clickable && onDayClick?.(day)}
                  onMouseEnter={() => clickable && onDayPrefetch?.(day)}
                  onFocus={() => clickable && onDayPrefetch?.(day)}
                  onTouchStart={() => clickable && onDayPrefetch?.(day)}
                >
                  {day}
                  {data && data.totalSeconds > 0 && (
                    <span className="ec-time-badge">{formatWorkedTime(data.totalSeconds)}</span>
                  )}
                </div>
              );
            })}
            {trailingCells}
          </div>
        )}
      </div>
    </div>
  );
};
