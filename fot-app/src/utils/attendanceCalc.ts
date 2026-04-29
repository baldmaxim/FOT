import type { SkudEvent, TimesheetEntry, IProductionCalendarMonth } from '../types';
import type { IResolvedSchedule } from '../types/schedule';
import {
  getEffectiveLateThresholdForDay,
  getFullDayThresholdHoursForDay,
  getScheduleForTimesheetDay,
  getWorkHoursForDay,
  isScheduleDayOff,
  parseHMToMinutes,
} from './scheduleUtils';

const WORK_START_MINUTES = 9 * 60; // 09:00
const WORKDAY_TARGET_SECONDS = 8 * 3600; // 8 часов фактического присутствия

/** ISO day-of-week: 1=Пн..7=Вс */
const getISODow = (date: Date): number => {
  const d = date.getDay();
  return d === 0 ? 7 : d;
};

/** Проверка выходного дня с учётом графика */
const isScheduleWeekend = (year: number, month: number, day: number, schedule?: IResolvedSchedule): boolean => {
  if (!schedule) return isWeekend(year, month, day);
  return !schedule.work_days.includes(getISODow(new Date(year, month, day)));
};

export interface IDayAttendance {
  day: number;
  status:
    | 'present'
    | 'underwork'
    | 'absent'
    | 'weekend'
    | 'future'
    | 'sick'
    | 'vacation'
    | 'remote'
    | 'incomplete_skud';
  arrivalTime?: string;
  totalSeconds: number;
  isLate?: boolean;
  plannedHours?: number;
  scheduledStartMinutes?: number | null;
}

export interface IMonthStats {
  attendancePercent: number;
  lateCount: number;
  hoursWorked: number;
  hoursPlanned: number;
  avgArrivalTime: string | null;
  avgArrivalDiffMinutes: number;
}

export interface IWeekdayPattern {
  day: string;
  avgTime: string | null;
  heightPercent: number;
}

export interface IAlert {
  type: 'warning' | 'error';
  title: string;
  description: string;
}

export interface ITodayEvent {
  id: number;
  direction: 'entry' | 'exit';
  time: string;
  accessPoint: string | null;
}

const timeToMinutes = (time: string): number => {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
};

const timeToSeconds = (time: string): number => {
  const [h, m, s = 0] = time.split(':').map(Number);
  return h * 3600 + m * 60 + s;
};

const minutesToTime = (minutes: number): string => {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

const getScheduledStartMinutes = (
  sched: IResolvedSchedule | undefined,
  year: number,
  month: number,
  day: number,
): number => {
  if (!sched) return WORK_START_MINUTES;
  const date = new Date(year, month, day);
  const isoDow = getISODow(date);
  const override = sched.day_overrides?.[String(isoDow)];
  return parseHMToMinutes((override?.work_start || sched.work_start).slice(0, 5)) ?? WORK_START_MINUTES;
};

const isWeekend = (year: number, month: number, day: number): boolean => {
  const dow = new Date(year, month, day).getDay();
  return dow === 0 || dow === 6;
};

const calcWorkSeconds = (events: SkudEvent[], internalPoints: Set<string>, isToday = false): number => {
  const ext = events.filter(e => !e.access_point || !internalPoints.has(e.access_point));
  const sorted = [...ext].sort((a, b) => a.event_time.localeCompare(b.event_time));
  let total = 0;
  let entryTime: number | null = null;
  for (const ev of sorted) {
    if (ev.direction === 'entry') {
      if (entryTime === null) entryTime = timeToSeconds(ev.event_time);
    } else if (ev.direction === 'exit' && entryTime !== null) {
      total += timeToSeconds(ev.event_time) - entryTime;
      entryTime = null;
    }
  }
  // Если последний вход без выхода и это сегодня — считаем до текущего момента
  if (entryTime !== null && isToday) {
    const now = new Date();
    const nowSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    total += nowSec - entryTime;
  }
  return total;
};

export const getFirstDayOffset = (year: number, month: number): number => {
  const d = new Date(year, month, 1).getDay();
  return d === 0 ? 6 : d - 1;
};

export const getDaysInMonth = (year: number, month: number): number =>
  new Date(year, month + 1, 0).getDate();

export const calculateAttendance = (
  events: SkudEvent[],
  internalPoints: Set<string>,
  year: number,
  month: number,
  schedule?: IResolvedSchedule,
) => {
  const today = new Date();
  const todayDate = today.getDate();
  const isCurrentMonth = today.getFullYear() === year && today.getMonth() === month;
  const daysInMonth = getDaysInMonth(year, month);

  const eventsByDay = new Map<number, SkudEvent[]>();
  for (const ev of events) {
    const d = new Date(ev.event_date + 'T00:00:00');
    if (d.getFullYear() === year && d.getMonth() === month) {
      const day = d.getDate();
      if (!eventsByDay.has(day)) eventsByDay.set(day, []);
      eventsByDay.get(day)!.push(ev);
    }
  }

  const days: IDayAttendance[] = [];
  let presentCount = 0, lateCount = 0, totalWorkdays = 0, totalWorkSecs = 0;
  const arrivalMins: number[] = [];
  const arrivalByDow: number[][] = [[], [], [], [], []];

  const workStartMin = schedule ? (() => { const [h, m] = schedule.work_start.split(':').map(Number); return h * 60 + m; })() : WORK_START_MINUTES;
  const targetSeconds = schedule ? schedule.work_hours * 3600 : WORKDAY_TARGET_SECONDS;
  const isRemoteSchedule = schedule && (schedule.schedule_type === 'remote');

  for (let d = 1; d <= daysInMonth; d++) {
    if (isScheduleWeekend(year, month, d, schedule)) {
      days.push({ day: d, status: 'weekend', totalSeconds: 0 });
      continue;
    }
    if (isCurrentMonth && d > todayDate) {
      days.push({ day: d, status: 'future', totalSeconds: 0, plannedHours: schedule ? schedule.work_hours : 8, scheduledStartMinutes: workStartMin });
      continue;
    }

    totalWorkdays++;

    // Для полной удалёнки — автоматически "present"
    if (isRemoteSchedule) {
      presentCount++;
      totalWorkSecs += targetSeconds;
      days.push({ day: d, status: 'present', totalSeconds: targetSeconds, plannedHours: schedule ? schedule.work_hours : 8, scheduledStartMinutes: workStartMin });
      continue;
    }

    const dayEvs = eventsByDay.get(d) || [];

    if (dayEvs.length === 0) {
      days.push({ day: d, status: 'absent', totalSeconds: 0, plannedHours: schedule ? schedule.work_hours : 8, scheduledStartMinutes: workStartMin });
      continue;
    }

    const ext = dayEvs.filter(e => !e.access_point || !internalPoints.has(e.access_point));
    const entries = ext
      .filter(e => e.direction === 'entry')
      .sort((a, b) => a.event_time.localeCompare(b.event_time));

    let arrivalTime: string | undefined;
    let late = false;

    if (entries.length > 0) {
      const mins = timeToMinutes(entries[0].event_time);
      arrivalTime = entries[0].event_time.slice(0, 5);
      arrivalMins.push(mins);
      const dow = new Date(year, month, d).getDay();
      const dowIdx = dow === 0 ? 6 : dow - 1;
      if (dowIdx < 5) arrivalByDow[dowIdx].push(mins);
      late = mins > workStartMin;
    }

    const isTodayDay = isCurrentMonth && d === todayDate;
    const workSecs = calcWorkSeconds(dayEvs, internalPoints, isTodayDay);
    totalWorkSecs += workSecs;

    const status = workSecs < targetSeconds ? 'underwork' : 'present';

    if (late) lateCount++;
    presentCount++;
    days.push({
      day: d,
      status,
      arrivalTime,
      totalSeconds: workSecs,
      isLate: late,
      plannedHours: schedule ? schedule.work_hours : 8,
      scheduledStartMinutes: workStartMin,
    });
  }

  const attendancePercent = totalWorkdays > 0
    ? Math.round((presentCount / totalWorkdays) * 100)
    : 0;

  let avgArrivalTime: string | null = null;
  let avgArrivalDiffMinutes = 0;
  if (arrivalMins.length > 0) {
    const avg = arrivalMins.reduce((a, b) => a + b, 0) / arrivalMins.length;
    avgArrivalTime = minutesToTime(avg);
    avgArrivalDiffMinutes = Math.round(avg - workStartMin);
  }

  const DOW_LABELS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт'];
  const weeklyPattern: IWeekdayPattern[] = DOW_LABELS.map((label, i) => {
    const times = arrivalByDow[i];
    if (times.length === 0) return { day: label, avgTime: null, heightPercent: 0 };
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const minM = 8 * 60 + 30, maxM = 9 * 60 + 30;
    const pct = ((Math.max(minM, Math.min(maxM, avg)) - minM) / (maxM - minM)) * 100;
    return { day: label, avgTime: minutesToTime(avg), heightPercent: Math.max(20, pct) };
  });

  const alerts: IAlert[] = [];
  if (lateCount > 2) {
    alerts.push({
      type: 'warning',
      title: `${lateCount} опозданий за месяц`,
      description: 'Превышен лимит в 2 опоздания',
    });
  }

  const absentDays = days.filter(d => d.status === 'absent').map(d => d.day);
  if (absentDays.length > 0) {
    const MN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
      'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
    const ranges: string[] = [];
    let start = absentDays[0], end = absentDays[0];
    for (let i = 1; i < absentDays.length; i++) {
      if (absentDays[i] === end + 1) { end = absentDays[i]; }
      else { ranges.push(start === end ? `${start}` : `${start}–${end}`); start = end = absentDays[i]; }
    }
    ranges.push(start === end ? `${start}` : `${start}–${end}`);
    const word = absentDays.length === 1 ? 'день' : absentDays.length < 5 ? 'дня' : 'дней';
    alerts.push({
      type: 'error',
      title: `${absentDays.length} ${word} отсутствия`,
      description: `${ranges.join(', ')} ${MN[month]} без объяснения`,
    });
  }

  return {
    days,
    stats: { attendancePercent, lateCount, hoursWorked: Math.round(totalWorkSecs / 3600), hoursPlanned: totalWorkdays * (schedule ? schedule.work_hours : 8), avgArrivalTime, avgArrivalDiffMinutes } as IMonthStats,
    weeklyPattern,
    alerts,
  };
};

export const getTodayTimeline = (events: SkudEvent[]): ITodayEvent[] => {
  const today = new Date().toISOString().slice(0, 10);
  return events
    .filter(e => e.event_date === today)
    .sort((a, b) => a.event_time.localeCompare(b.event_time))
    .map(e => ({
      id: e.id,
      direction: (e.direction as 'entry' | 'exit') || 'entry',
      time: e.event_time.slice(0, 5),
      accessPoint: e.access_point,
    }));
};

export const computePeriodData = (
  days: IDayAttendance[],
  year: number,
  month: number,
): { stats: IMonthStats; weeklyPattern: IWeekdayPattern[] } => {
  const workDays = days.filter(d => d.status !== 'weekend' && d.status !== 'future');
  const presentDays = workDays.filter(d => d.status !== 'absent');
  const lateDays = workDays.filter(d => d.isLate);

  const attendancePercent = workDays.length > 0
    ? Math.round((presentDays.length / workDays.length) * 100)
    : 0;
  const totalSecs = workDays.reduce((sum, d) => sum + d.totalSeconds, 0);
  const totalPlannedHours = workDays.reduce((sum, d) => sum + (d.plannedHours ?? 8), 0);

  const arrivalMins = presentDays
    .filter(d => d.arrivalTime)
    .map(d => {
      const [h, m] = d.arrivalTime!.split(':').map(Number);
      return h * 60 + m;
    });

  let avgArrivalTime: string | null = null;
  let avgArrivalDiffMinutes = 0;
  if (arrivalMins.length > 0) {
    const avg = arrivalMins.reduce((a, b) => a + b, 0) / arrivalMins.length;
    avgArrivalTime = minutesToTime(avg);
    const baseStartMinutes = presentDays
      .filter(d => d.arrivalTime)
      .map(d => d.scheduledStartMinutes ?? WORK_START_MINUTES);
    const avgBase = baseStartMinutes.reduce((a, b) => a + b, 0) / baseStartMinutes.length;
    avgArrivalDiffMinutes = Math.round(avg - avgBase);
  }

  const stats: IMonthStats = {
    attendancePercent,
    lateCount: lateDays.length,
    hoursWorked: Math.round(totalSecs / 3600),
    hoursPlanned: Math.round(totalPlannedHours),
    avgArrivalTime,
    avgArrivalDiffMinutes,
  };

  const DOW_LABELS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт'];
  const arrivalByDow: number[][] = [[], [], [], [], []];
  for (const d of presentDays) {
    if (!d.arrivalTime) continue;
    const dow = new Date(year, month, d.day).getDay();
    const dowIdx = dow === 0 ? 6 : dow - 1;
    if (dowIdx < 5) {
      const [h, m] = d.arrivalTime.split(':').map(Number);
      arrivalByDow[dowIdx].push(h * 60 + m);
    }
  }

  const weeklyPattern: IWeekdayPattern[] = DOW_LABELS.map((label, i) => {
    const times = arrivalByDow[i];
    if (times.length === 0) return { day: label, avgTime: null, heightPercent: 0 };
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const minM = 8 * 60 + 30, maxM = 9 * 60 + 30;
    const pct = ((Math.max(minM, Math.min(maxM, avg)) - minM) / (maxM - minM)) * 100;
    return { day: label, avgTime: minutesToTime(avg), heightPercent: Math.max(20, pct) };
  });

  return { stats, weeklyPattern };
};

export const calculateAttendanceFromTimesheet = (params: {
  employeeId: number;
  entries: TimesheetEntry[];
  year: number;
  month: number;
  schedules?: Record<number, IResolvedSchedule>;
  dailySchedules?: Record<number, Record<string, IResolvedSchedule>>;
  calendar?: IProductionCalendarMonth | null;
  liveDayEvents?: SkudEvent[];
  monthSkudEvents?: SkudEvent[];
  internalPoints?: Set<string>;
  capToSchedule?: boolean;
}) => {
  const {
    employeeId,
    entries,
    year,
    month,
    schedules,
    dailySchedules,
    calendar,
    liveDayEvents,
    monthSkudEvents,
    internalPoints,
    capToSchedule,
  } = params;

  const today = new Date();
  const todayDate = today.getDate();
  const isCurrentMonth = today.getFullYear() === year && today.getMonth() === month;
  const daysInMonth = getDaysInMonth(year, month);
  const liveInternalPoints = internalPoints ?? new Set<string>();
  const liveTodayEvents = isCurrentMonth
    ? (liveDayEvents ?? [])
      .filter(event => {
        const eventDate = new Date(`${event.event_date}T00:00:00`);
        return eventDate.getFullYear() === year
          && eventDate.getMonth() === month
          && eventDate.getDate() === todayDate;
      })
      .sort((a, b) => a.event_time.localeCompare(b.event_time))
    : [];
  const liveTodayAttendanceEvents = liveTodayEvents
    .filter(event => !event.access_point || !liveInternalPoints.has(event.access_point));

  // Карта внешних СКУД-событий по дням месяца — нужна, чтобы дни без записи в табеле,
  // но с реальными проходами, не сваливались в 'absent', а получали индикатор 'incomplete_skud'.
  const externalEventsByDay = new Map<number, SkudEvent[]>();
  for (const ev of monthSkudEvents ?? []) {
    if (ev.access_point && liveInternalPoints.has(ev.access_point)) continue;
    const evDate = new Date(`${ev.event_date}T00:00:00`);
    if (evDate.getFullYear() !== year || evDate.getMonth() !== month) continue;
    const dayNum = evDate.getDate();
    if (!externalEventsByDay.has(dayNum)) externalEventsByDay.set(dayNum, []);
    externalEventsByDay.get(dayNum)!.push(ev);
  }

  const entryByDay = new Map<number, TimesheetEntry>();
  for (const entry of entries) {
    if (entry.employee_id !== employeeId) continue;
    const workDate = new Date(`${entry.work_date}T00:00:00`);
    if (workDate.getFullYear() !== year || workDate.getMonth() !== month) continue;
    entryByDay.set(workDate.getDate(), entry);
  }

  const days: IDayAttendance[] = [];
  let coveredDays = 0;
  let lateCount = 0;
  let totalWorkdays = 0;
  let totalWorkSecs = 0;
  let totalPlannedHours = 0;
  const arrivalMins: number[] = [];
  const arrivalDiffs: number[] = [];
  const arrivalByDow: number[][] = [[], [], [], [], []];
  const workedLikeStatuses = new Set(['work', 'manual', 'remote']);

  for (let day = 1; day <= daysInMonth; day++) {
    const schedule = getScheduleForTimesheetDay(schedules, dailySchedules, employeeId, year, month + 1, day);
    const plannedHours = isScheduleDayOff(schedule, calendar ?? null, year, month + 1, day)
      ? 0
      : getWorkHoursForDay(schedule, year, month + 1, day);
    const scheduledStartMinutes = getScheduledStartMinutes(schedule, year, month, day);
    const entry = entryByDay.get(day);
    const isScheduledDayOff = plannedHours <= 0;
    const shouldUseLiveTodayEvents = isCurrentMonth && day === todayDate && liveTodayAttendanceEvents.length > 0;

    if (isCurrentMonth && day > todayDate) {
      days.push({ day, status: 'future', totalSeconds: 0, plannedHours, scheduledStartMinutes });
      continue;
    }

    if (isScheduledDayOff && !entry && !shouldUseLiveTodayEvents) {
      days.push({ day, status: 'weekend', totalSeconds: 0, plannedHours: 0, scheduledStartMinutes });
      continue;
    }

    if (!isScheduledDayOff) {
      totalWorkdays++;
      totalPlannedHours += plannedHours;
    }

    if (!entry && !shouldUseLiveTodayEvents) {
      const hasExternalSkud = (externalEventsByDay.get(day) ?? []).length > 0;
      const fallbackStatus: IDayAttendance['status'] = hasExternalSkud && !isScheduledDayOff
        ? 'incomplete_skud'
        : 'absent';
      days.push({ day, status: fallbackStatus, totalSeconds: 0, plannedHours, scheduledStartMinutes });
      continue;
    }
    const liveTodayExternalEvents = shouldUseLiveTodayEvents
      ? liveTodayAttendanceEvents
      : [];
    const liveTodayEntries = liveTodayExternalEvents
      .filter(event => event.direction === 'entry')
      .sort((a, b) => a.event_time.localeCompare(b.event_time));

    const liveSeconds = shouldUseLiveTodayEvents
      ? calcWorkSeconds(liveTodayEvents, liveInternalPoints, true)
      : 0;
    const rawTotalSeconds = shouldUseLiveTodayEvents
      ? liveSeconds
      : Math.max(0, Math.round((entry?.hours_worked ?? 0) * 3600));
    const totalSeconds = capToSchedule && plannedHours > 0
      ? Math.min(rawTotalSeconds, Math.round(plannedHours * 3600))
      : rawTotalSeconds;
    const arrivalTime = shouldUseLiveTodayEvents
      ? liveTodayEntries[0]?.event_time.slice(0, 5)
      : entry?.first_entry?.slice(0, 5);
    const hasActualPresence = shouldUseLiveTodayEvents
      ? totalSeconds > 0 || liveTodayExternalEvents.length > 0
      : totalSeconds > 0 || Boolean(entry?.first_entry) || Boolean(entry?.last_exit) || Boolean(entry?.status && workedLikeStatuses.has(entry.status));
    let isLate = false;

    if (arrivalTime && !isScheduledDayOff) {
      const arrivalMinutes = timeToMinutes(arrivalTime);
      arrivalMins.push(arrivalMinutes);
      arrivalDiffs.push(arrivalMinutes - scheduledStartMinutes);
      const dow = new Date(year, month, day).getDay();
      const dowIdx = dow === 0 ? 6 : dow - 1;
      if (dowIdx < 5) {
        arrivalByDow[dowIdx].push(arrivalMinutes);
      }
      const lateThresholdMinutes = parseHMToMinutes(getEffectiveLateThresholdForDay(schedule, year, month + 1, day).slice(0, 5)) ?? scheduledStartMinutes;
      isLate = arrivalMinutes > lateThresholdMinutes;
    }

    const fullDayThresholdHours = getFullDayThresholdHoursForDay(schedule, calendar ?? null, year, month + 1, day);

    // Зеркалим логику TimesheetGrid.getDayCellClass, чтобы цвет в карточке совпадал с табелем.
    const visibleHours = entry?.display_hours_worked ?? entry?.hours_worked ?? null;
    const hasSkudEvents = Boolean(entry?.first_entry || entry?.last_exit)
      || (shouldUseLiveTodayEvents && liveTodayExternalEvents.length > 0);
    const zeroHours = visibleHours == null || visibleHours <= 0;
    const incompleteSkud = hasSkudEvents && zeroHours;

    let status: IDayAttendance['status'];
    switch (entry?.status) {
      case 'sick':
        status = 'sick';
        break;
      case 'vacation':
      case 'dayoff':
        status = 'vacation';
        break;
      case 'remote':
        status = 'remote';
        break;
      case 'absent':
        status = hasSkudEvents ? 'incomplete_skud' : 'absent';
        break;
      case 'unpaid':
        status = 'absent';
        break;
      case 'work':
      case 'manual':
      default: {
        if (incompleteSkud) {
          status = 'incomplete_skud';
        } else if (hasActualPresence) {
          const hoursOk = plannedHours <= 0 || totalSeconds >= Math.round(fullDayThresholdHours * 3600);
          const spanOk = entry?.presence_covers_shift !== false;
          status = (hoursOk && spanOk) ? 'present' : 'underwork';
        } else if (isScheduledDayOff) {
          status = 'weekend';
        } else {
          status = 'absent';
        }
      }
    }

    if (!isScheduledDayOff && status !== 'absent') {
      coveredDays++;
    }
    if (isLate) {
      lateCount++;
    }
    totalWorkSecs += totalSeconds;

    days.push({
      day,
      status,
      arrivalTime,
      totalSeconds,
      isLate,
      plannedHours,
      scheduledStartMinutes,
    });
  }

  const attendancePercent = totalWorkdays > 0
    ? Math.round((coveredDays / totalWorkdays) * 100)
    : 0;

  let avgArrivalTime: string | null = null;
  let avgArrivalDiffMinutes = 0;
  if (arrivalMins.length > 0) {
    const avgArrival = arrivalMins.reduce((a, b) => a + b, 0) / arrivalMins.length;
    avgArrivalTime = minutesToTime(avgArrival);
    avgArrivalDiffMinutes = Math.round(arrivalDiffs.reduce((a, b) => a + b, 0) / arrivalDiffs.length);
  }

  const DOW_LABELS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт'];
  const weeklyPattern: IWeekdayPattern[] = DOW_LABELS.map((label, index) => {
    const times = arrivalByDow[index];
    if (times.length === 0) return { day: label, avgTime: null, heightPercent: 0 };
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const minM = 8 * 60 + 30;
    const maxM = 9 * 60 + 30;
    const pct = ((Math.max(minM, Math.min(maxM, avg)) - minM) / (maxM - minM)) * 100;
    return { day: label, avgTime: minutesToTime(avg), heightPercent: Math.max(20, pct) };
  });

  const alerts: IAlert[] = [];
  if (lateCount > 2) {
    alerts.push({
      type: 'warning',
      title: `${lateCount} опозданий за месяц`,
      description: 'Превышен лимит в 2 опоздания',
    });
  }

  const absentDays = days.filter(d => d.status === 'absent').map(d => d.day);
  if (absentDays.length > 0) {
    const monthNames = [
      'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
      'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
    ];
    const ranges: string[] = [];
    let start = absentDays[0];
    let end = absentDays[0];
    for (let i = 1; i < absentDays.length; i++) {
      if (absentDays[i] === end + 1) {
        end = absentDays[i];
      } else {
        ranges.push(start === end ? `${start}` : `${start}–${end}`);
        start = absentDays[i];
        end = absentDays[i];
      }
    }
    ranges.push(start === end ? `${start}` : `${start}–${end}`);
    const word = absentDays.length === 1 ? 'день' : absentDays.length < 5 ? 'дня' : 'дней';
    alerts.push({
      type: 'error',
      title: `${absentDays.length} ${word} отсутствия`,
      description: `${ranges.join(', ')} ${monthNames[month]} без подтверждённого покрытия в табеле`,
    });
  }

  return {
    days,
    stats: {
      attendancePercent,
      lateCount,
      hoursWorked: Math.round(totalWorkSecs / 3600),
      hoursPlanned: Math.round(totalPlannedHours),
      avgArrivalTime,
      avgArrivalDiffMinutes,
    } as IMonthStats,
    weeklyPattern,
    alerts,
  };
};

export const isEmployeeOnSite = (events: SkudEvent[], internalPoints: Set<string>): boolean => {
  const today = new Date().toISOString().slice(0, 10);
  const todayExt = events
    .filter(e => e.event_date === today && (!e.access_point || !internalPoints.has(e.access_point)))
    .sort((a, b) => b.event_time.localeCompare(a.event_time));
  return todayExt.length > 0 && todayExt[0].direction === 'entry';
};
