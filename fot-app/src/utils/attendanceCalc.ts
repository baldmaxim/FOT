import type { SkudEvent } from '../types';

const WORK_START_MINUTES = 9 * 60; // 09:00
const WORKDAY_TARGET_SECONDS = 8 * 3600; // 8 часов фактического присутствия

export interface IDayAttendance {
  day: number;
  status: 'present' | 'underwork' | 'absent' | 'weekend' | 'future';
  arrivalTime?: string;
  totalSeconds: number;
  isLate?: boolean;
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

  for (let d = 1; d <= daysInMonth; d++) {
    if (isWeekend(year, month, d)) {
      days.push({ day: d, status: 'weekend', totalSeconds: 0 });
      continue;
    }
    if (isCurrentMonth && d > todayDate) {
      days.push({ day: d, status: 'future', totalSeconds: 0 });
      continue;
    }

    totalWorkdays++;
    const dayEvs = eventsByDay.get(d) || [];

    if (dayEvs.length === 0) {
      days.push({ day: d, status: 'absent', totalSeconds: 0 });
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
      late = mins > WORK_START_MINUTES;
    }

    const isTodayDay = isCurrentMonth && d === todayDate;
    const workSecs = calcWorkSeconds(dayEvs, internalPoints, isTodayDay);
    totalWorkSecs += workSecs;

    const status = workSecs < WORKDAY_TARGET_SECONDS ? 'underwork' : 'present';

    if (late) lateCount++;
    presentCount++;
    days.push({ day: d, status, arrivalTime, totalSeconds: workSecs, isLate: late });
  }

  const attendancePercent = totalWorkdays > 0
    ? Math.round((presentCount / totalWorkdays) * 100)
    : 0;

  let avgArrivalTime: string | null = null;
  let avgArrivalDiffMinutes = 0;
  if (arrivalMins.length > 0) {
    const avg = arrivalMins.reduce((a, b) => a + b, 0) / arrivalMins.length;
    avgArrivalTime = minutesToTime(avg);
    avgArrivalDiffMinutes = Math.round(avg - WORK_START_MINUTES);
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
    stats: { attendancePercent, lateCount, hoursWorked: Math.round(totalWorkSecs / 3600), hoursPlanned: totalWorkdays * 8, avgArrivalTime, avgArrivalDiffMinutes } as IMonthStats,
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
  const presentDays = workDays.filter(d => d.status === 'present' || d.status === 'underwork');
  const lateDays = workDays.filter(d => d.isLate);

  const attendancePercent = workDays.length > 0
    ? Math.round((presentDays.length / workDays.length) * 100)
    : 0;
  const totalSecs = workDays.reduce((sum, d) => sum + d.totalSeconds, 0);

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
    avgArrivalDiffMinutes = Math.round(avg - WORK_START_MINUTES);
  }

  const stats: IMonthStats = {
    attendancePercent,
    lateCount: lateDays.length,
    hoursWorked: Math.round(totalSecs / 3600),
    hoursPlanned: workDays.length * 8,
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

export const isEmployeeOnSite = (events: SkudEvent[], internalPoints: Set<string>): boolean => {
  const today = new Date().toISOString().slice(0, 10);
  const todayExt = events
    .filter(e => e.event_date === today && (!e.access_point || !internalPoints.has(e.access_point)))
    .sort((a, b) => b.event_time.localeCompare(a.event_time));
  return todayExt.length > 0 && todayExt[0].direction === 'entry';
};
