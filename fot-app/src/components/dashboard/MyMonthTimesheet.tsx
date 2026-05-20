import { type FC, useMemo, useState } from 'react';
import { useEmployeeTimesheetMonth } from '../../hooks/useEmployeeTimesheet';
import { useAuth } from '../../contexts/AuthContext';
import { useMyLeaveRequests } from '../../hooks/usePortalData';
import { getFullDayThresholdHoursForDay, isScheduleDayOff } from '../../utils/scheduleUtils';
import { getDayStatus, type DayStatus } from '../../utils/dayStatus';
import {
  REQUEST_TYPE_LABELS,
  STATUS_LABELS,
  type ILeaveRequest,
  type LeaveRequestStatus,
} from '../../services/leaveRequestService';
import type { TimesheetEntry } from '../../types';
import styles from './MyMonthTimesheet.module.css';

const WEEKDAY_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

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

const REQ_STATUS_TO_CSS: Record<Exclude<LeaveRequestStatus, 'cancelled'>, string> = {
  pending: 'reqPending',
  approved: 'reqApproved',
  rejected: 'reqRejected',
};

const REQ_STATUS_PRIORITY: Record<LeaveRequestStatus, number> = {
  pending: 3,
  approved: 2,
  rejected: 1,
  cancelled: 0,
};

const pad = (n: number) => String(n).padStart(2, '0');

const buildIsoDate = (year: number, month: number, day: number) =>
  `${year}-${pad(month)}-${pad(day)}`;

interface IRequestDayInfo {
  status: LeaveRequestStatus;
  request_type: ILeaveRequest['request_type'];
  id: number;
}

const enumerateDates = (startIso: string, endIso: string): string[] => {
  if (!startIso || !endIso) return [];
  const out: string[] = [];
  const start = new Date(startIso + 'T00:00:00');
  const end = new Date(endIso + 'T00:00:00');
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return out;
  const cur = new Date(start);
  while (cur.getTime() <= end.getTime()) {
    out.push(`${cur.getFullYear()}-${pad(cur.getMonth() + 1)}-${pad(cur.getDate())}`);
    cur.setDate(cur.getDate() + 1);
  }
  return out;
};

interface IMyMonthTimesheetProps {
  employeeId: number | null;
  activeDayIso?: string | null;
  onDayActivate?: (date: string, entry: TimesheetEntry | null) => void;
  selectedDates?: Set<string>;
  onDayToggle?: (date: string, entry: TimesheetEntry | null) => void;
  noCard?: boolean;
}

export const MyMonthTimesheet: FC<IMyMonthTimesheetProps> = ({
  employeeId,
  activeDayIso,
  onDayActivate,
  selectedDates,
  onDayToggle,
  noCard,
}) => {
  const { showActualHours, timesheetMonthsBack, timesheetMonthsForward } = useAuth();
  const today = useMemo(() => new Date(), []);
  const currentYear = today.getFullYear();
  const currentMonth = today.getMonth() + 1;
  const todayIso = useMemo(() => buildIsoDate(currentYear, currentMonth, today.getDate()), [currentYear, currentMonth, today]);

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
  const leaveRequestsQuery = useMyLeaveRequests();

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

  const requestByIso = useMemo(() => {
    const map = new Map<string, IRequestDayInfo>();
    const list = leaveRequestsQuery.data || [];
    for (const req of list) {
      if (req.status === 'cancelled') continue;
      const isoDates = req.request_type === 'time_correction'
        ? (req.correction_date ? [req.correction_date] : [])
        : enumerateDates(req.start_date, req.end_date);
      for (const iso of isoDates) {
        const prev = map.get(iso);
        const incomingPriority = REQ_STATUS_PRIORITY[req.status];
        const prevPriority = prev ? REQ_STATUS_PRIORITY[prev.status] : -1;
        if (incomingPriority > prevPriority) {
          map.set(iso, { status: req.status, request_type: req.request_type, id: req.id });
        }
      }
    }
    return map;
  }, [leaveRequestsQuery.data]);

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

  const isMultiMode = !!(selectedDates && onDayToggle);

  const handleCellClick = (iso: string, entry: TimesheetEntry | null, ds: DayStatus) => {
    if (ds === 'future') return;
    if (isMultiMode) {
      onDayToggle?.(iso, entry);
    } else {
      onDayActivate?.(iso, entry);
    }
  };

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
          const isActive = !isMultiMode && cell.iso === activeDayIso;
          const isSelected = isMultiMode && selectedDates?.has(cell.iso);
          const reqInfo = requestByIso.get(cell.iso);
          const reqBadgeCls = reqInfo && reqInfo.status !== 'cancelled'
            ? styles[REQ_STATUS_TO_CSS[reqInfo.status as Exclude<LeaveRequestStatus, 'cancelled'>]]
            : '';
          const cellCls = [
            styles.cell,
            cell.isToday ? styles.cellToday : '',
            styles[STATUS_TO_CSS[cell.ds]] || '',
            isActive ? styles.cellActive : '',
            isSelected ? styles.cellSelected : '',
            cell.entry?.is_correction ? styles.cellCorrection : '',
          ].filter(Boolean).join(' ');

          const label = STATUS_LABEL[cell.ds];
          const baseTitle = cell.entry
            ? `${cell.day}: ${label}${cell.entry.hours_worked ? ` (${cell.entry.hours_worked}ч)` : ''}${cell.entry.is_correction ? ' • корр.' : ''}`
            : `${cell.day}${cell.ds === 'weekend' ? ' (выходной)' : ''}`;
          const reqTitle = reqInfo
            ? ` • ${REQUEST_TYPE_LABELS[reqInfo.request_type] || 'заявка'}: ${STATUS_LABELS[reqInfo.status]}`
            : '';
          const title = `${baseTitle}${reqTitle}`;

          return (
            <button
              key={cell.iso}
              type="button"
              className={cellCls}
              onClick={() => handleCellClick(cell.iso, cell.entry, cell.ds)}
              title={title}
            >
              <span className={styles.cellDay}>{cell.day}</span>
              {cell.entry?.hours_worked ? (
                <span className={styles.cellHours}>{cell.entry.hours_worked}ч</span>
              ) : null}
              {reqInfo && reqInfo.status !== 'cancelled' ? (
                <span
                  className={`${styles.cellRequestBadge} ${reqBadgeCls}`}
                  aria-label={`Заявка: ${STATUS_LABELS[reqInfo.status]}`}
                />
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
        <span><i className={`${styles.dotReq} ${styles.reqPending}`}/>Заявка на рассмотрении</span>
        <span><i className={`${styles.dotReq} ${styles.reqApproved}`}/>Одобрено</span>
        <span><i className={`${styles.dotReq} ${styles.reqRejected}`}/>Отклонено</span>
      </div>
    </div>
  );
};
