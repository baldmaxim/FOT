import { type FC, useEffect, useMemo, useRef, useState } from 'react';
import { useEmployeeTimesheetMonth } from '../../hooks/useEmployeeTimesheet';
import { useAuth } from '../../contexts/AuthContext';
import { useTimesheetMonthAccess } from '../../hooks/useTimesheetMonthAccess';
import { useMyLeaveRequests } from '../../hooks/usePortalData';
import {
  getFullDayThresholdHoursForDay,
  isHolidayForSchedule,
  isPreHolidayForSchedule,
  isScheduleDayOff,
} from '../../utils/scheduleUtils';
import { getDayStatus, type DayStatus } from '../../utils/dayStatus';
import { formatHoursLabel, selectVisibleHours } from '../../utils/hoursDisplay';
import {
  REQUEST_TYPE_LABELS,
  STATUS_LABELS,
  type ILeaveRequest,
  type LeaveRequestStatus,
} from '../../services/leaveRequestService';
import type { TimesheetEntry, TimesheetObjectEntry } from '../../types';
import styles from './MyMonthTimesheet.module.css';

// Проблемные статусы дня — для них блок дня показывает просмотр СКУД (#7).
const PROBLEMATIC_STATUSES: ReadonlySet<DayStatus> = new Set(['underwork', 'incomplete_skud', 'absent']);

export interface IDayFocusPayload {
  entry: TimesheetEntry | null;
  objectEntries: TimesheetObjectEntry[];
  ds: DayStatus;
  isProblematic: boolean;
}

const APPROVED_ABSENCE_TYPES: ReadonlySet<ILeaveRequest['request_type']> = new Set([
  'vacation',
  'sick_leave',
  'unpaid',
  'educational_leave',
]);

const REQUEST_TYPE_TO_DS: Partial<Record<ILeaveRequest['request_type'], DayStatus>> = {
  vacation: 'vacation',
  sick_leave: 'sick',
  unpaid: 'unpaid',
  educational_leave: 'educational_leave',
  sick_worked: 'sick_worked',
};

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
  sick_worked: 'cellRemote',
  weekend: 'cellWeekend',
  future: 'cellEmpty',
  empty: 'cellEmpty',
};

const ABSENCE_DAY_STATUSES: ReadonlySet<DayStatus> = new Set([
  'vacation',
  'sick',
  'unpaid',
  'educational_leave',
]);

// Буквенные коды статусов-отсутствий для ячейки календаря ЛК (без времени).
// Рабочие дни (present/underwork) показывают числовые часы, не букву.
const STATUS_LETTER: Partial<Record<DayStatus, string>> = {
  vacation: 'От',
  sick: 'Б',
  remote: 'Уд',
  unpaid: 'С',
  educational_leave: 'УО',
  sick_worked: 'РБ',
  absent: 'Н',
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
  sick_worked: 'Работал на больничном',
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

// Маркер корректировки табеля (из табеля/объектной/одобренной заявки) по approval_status (#9).
type CorrApproval = 'auto_approved' | 'pending' | 'approved' | 'rejected';
const CORR_APPROVAL_TO_CSS: Record<CorrApproval, string> = {
  pending: 'corrPending',
  approved: 'corrApproved',
  auto_approved: 'corrApproved',
  rejected: 'corrRejected',
};
const CORR_APPROVAL_LABEL: Record<CorrApproval, string> = {
  pending: 'корректировка на согласовании',
  approved: 'корректировка согласована',
  auto_approved: 'корректировка учтена',
  rejected: 'корректировка отклонена',
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
  // Вызывается при каждом клике по дню — отдаёт данные дня для блока деталей/СКУД (#7, #10).
  onDayFocus?: (date: string, payload: IDayFocusPayload) => void;
  noCard?: boolean;
  allowFuture?: boolean;
}

export const MyMonthTimesheet: FC<IMyMonthTimesheetProps> = ({
  employeeId,
  activeDayIso,
  onDayActivate,
  selectedDates,
  onDayToggle,
  onDayFocus,
  noCard,
  allowFuture,
}) => {
  const { showActualHours } = useAuth();
  const { minOffset, maxOffset } = useTimesheetMonthAccess({ ignoreExempt: true });
  const today = useMemo(() => new Date(), []);
  const currentYear = today.getFullYear();
  const currentMonth = today.getMonth() + 1;
  const todayIso = useMemo(() => buildIsoDate(currentYear, currentMonth, today.getDate()), [currentYear, currentMonth, today]);

  const [monthOffset, setMonthOffset] = useState<number>(0);
  // Навигация в пределах 5 месяцев: текущий ±2 (в рамках доступного по ролям окна).
  const effMin = Math.max(minOffset, -2);
  const effMax = Math.min(maxOffset, 2);
  const offset = Math.min(effMax, Math.max(effMin, monthOffset));

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

  const objectEntriesByIso = useMemo(() => {
    const map = new Map<string, TimesheetObjectEntry[]>();
    const list = timesheetQuery.data?.object_entries || [];
    for (const oe of list) {
      if (oe.employee_id !== employeeId) continue;
      const bucket = map.get(oe.work_date) || [];
      bucket.push(oe);
      map.set(oe.work_date, bucket);
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

  // Авто-фокус текущего дня при первом рендере: блок «Проходы» сразу показывает сегодня.
  const didAutoFocusRef = useRef(false);
  useEffect(() => {
    if (didAutoFocusRef.current || !onDayFocus || offset !== 0 || timesheetQuery.isLoading) return;
    const day = today.getDate();
    const entry = entriesByDay.get(day) || null;
    const isScheduledDayOff = isScheduleDayOff(employeeSchedule, calendar, currentYear, currentMonth, day);
    const fullDayThresholdHours = getFullDayThresholdHoursForDay(employeeSchedule, calendar, currentYear, currentMonth, day);
    const ds = getDayStatus(entry, { showActualHours, fullDayThresholdHours, isScheduledDayOff, isFuture: false });
    onDayFocus(todayIso, {
      entry,
      objectEntries: objectEntriesByIso.get(todayIso) ?? [],
      ds,
      isProblematic: PROBLEMATIC_STATUSES.has(ds),
    });
    didAutoFocusRef.current = true;
  }, [timesheetQuery.isLoading, offset, onDayFocus, entriesByDay, objectEntriesByIso, employeeSchedule, calendar, currentYear, currentMonth, todayIso, today, showActualHours]);

  const daysInMonth = new Date(year, month, 0).getDate();
  const firstDow = (() => {
    const d = new Date(year, month - 1, 1).getDay();
    return d === 0 ? 6 : d - 1;
  })();

  const cells: Array<{
    day: number;
    iso: string;
    isToday: boolean;
    entry: TimesheetEntry | null;
    ds: DayStatus;
    isHoliday: boolean;
    isPreHoliday: boolean;
  } | null> = [];
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
    const isHoliday = isHolidayForSchedule(employeeSchedule, calendar, year, month, day);
    const isPreHoliday = isPreHolidayForSchedule(employeeSchedule, calendar, year, month, day);
    cells.push({ day, iso, isToday: iso === todayIso, entry, ds, isHoliday, isPreHoliday });
  }

  const monthLabel = new Date(year, month - 1, 1)
    .toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });

  const isMultiMode = !!(selectedDates && onDayToggle);

  const handleCellClick = (iso: string, entry: TimesheetEntry | null, ds: DayStatus) => {
    if (ds === 'future' && !allowFuture) return;
    onDayFocus?.(iso, {
      entry,
      objectEntries: objectEntriesByIso.get(iso) ?? [],
      ds,
      isProblematic: PROBLEMATIC_STATUSES.has(ds),
    });
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
          onClick={() => setMonthOffset(o => Math.max(effMin, Math.min(effMax, o) - 1))}
          disabled={offset <= effMin}
          aria-label="Предыдущий месяц"
        >
          ◀
        </button>
        <h2 className={styles.title}>{monthLabel}</h2>
        <button
          type="button"
          className={styles.monthBtn}
          onClick={() => setMonthOffset(o => Math.min(effMax, Math.max(effMin, o) + 1))}
          disabled={offset >= effMax}
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
          // Выходной, попавший в период одобренного отпуска/больничного/за-свой-счёт,
          // должен быть подсвечен как период отсутствия, а не серым weekend (включая
          // праздничные дни внутри периода).
          const absenceOverrideDs =
            reqInfo
            && reqInfo.status === 'approved'
            && APPROVED_ABSENCE_TYPES.has(reqInfo.request_type)
            && !cell.entry
              ? REQUEST_TYPE_TO_DS[reqInfo.request_type] ?? null
              : null;
          const effectiveDs = absenceOverrideDs ?? cell.ds;
          const visibleHours = selectVisibleHours(cell.entry, showActualHours);
          const cellCls = [
            styles.cell,
            cell.isToday ? styles.cellToday : '',
            styles[STATUS_TO_CSS[effectiveDs]] || '',
            cell.isHoliday && !absenceOverrideDs ? styles.cellHoliday : '',
            cell.isPreHoliday ? styles.cellPreHoliday : '',
            isActive ? styles.cellActive : '',
            isSelected ? styles.cellSelected : '',
            cell.entry?.is_correction ? styles.cellCorrection : '',
          ].filter(Boolean).join(' ');

          const label = STATUS_LABEL[effectiveDs];
          const dayHints: string[] = [];
          if (cell.isHoliday) dayHints.push('праздник');
          if (cell.isPreHoliday) dayHints.push('сокращённый −1ч');
          if (!cell.entry && cell.ds === 'weekend' && !cell.isHoliday && !absenceOverrideDs) dayHints.push('выходной');
          const hintsStr = dayHints.length > 0 ? ` (${dayHints.join(', ')})` : '';
          const isAbsenceDay = ABSENCE_DAY_STATUSES.has(effectiveDs);
          const showHours = visibleHours != null && visibleHours > 0 && !isAbsenceDay;
          const baseTitle = cell.entry
            ? `${cell.day}: ${label}${showHours ? ` (${formatHoursLabel(visibleHours)})` : ''}${cell.entry.is_correction ? ' • корр.' : ''}${hintsStr}`
            : `${cell.day}${hintsStr}`;
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
              data-tooltip={title}
            >
              <span className={styles.cellDay}>{cell.day}</span>
              {STATUS_LETTER[effectiveDs] ? (
                <span className={styles.cellHours}>{STATUS_LETTER[effectiveDs]}</span>
              ) : showHours ? (
                <span className={styles.cellHours}>{formatHoursLabel(visibleHours)}</span>
              ) : null}
              {reqInfo && reqInfo.status !== 'cancelled' ? (
                <span
                  className={`${styles.cellRequestBadge} ${reqBadgeCls}`}
                  aria-label={`Заявка: ${STATUS_LABELS[reqInfo.status]}`}
                />
              ) : null}
              {cell.entry?.is_correction ? (
                <span
                  className={`${styles.cellCorrectionDot} ${styles[CORR_APPROVAL_TO_CSS[(cell.entry.approval_status ?? 'auto_approved') as CorrApproval]] || ''}`}
                  aria-label={CORR_APPROVAL_LABEL[(cell.entry.approval_status ?? 'auto_approved') as CorrApproval]}
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
        <span><i className={`${styles.dot} ${styles.cellWeekend}`}/>Выходной по графику</span>
        <span><i className={`${styles.dot} ${styles.cellHoliday}`}/>Нерабочий день</span>
        <span><i className={`${styles.dot} ${styles.cellPreHoliday}`}/>Сокращённый день</span>
        <span><i className={`${styles.dot} ${styles.cellAbsent}`}/>Неявка</span>
        <span><i className={`${styles.dotReq} ${styles.reqPending}`}/>Заявка на рассмотрении</span>
        <span><i className={`${styles.dotReq} ${styles.reqApproved}`}/>Согласовано</span>
        <span><i className={`${styles.dotReq} ${styles.reqRejected}`}/>Отклонено</span>
      </div>
    </div>
  );
};
