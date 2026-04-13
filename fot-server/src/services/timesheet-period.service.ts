export type TimesheetHalf = 'H1' | 'H2';

export interface ITimesheetPeriodParts {
  year: number;
  month: number;
  half: TimesheetHalf;
}

export interface IZonedDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export interface ITimesheetReminderSettings {
  enabled: boolean;
  timezone: string;
  openingReminderHour: number;
  deadlineMorningHour: number;
  deadlineAfternoonHour: number;
  escalationHour: number;
  overdueHour: number;
}

export interface ITimesheetReminderEvent {
  period: string;
  stage: 'opening' | 'deadline_morning' | 'deadline_afternoon' | 'escalation' | 'overdue';
}

const PERIOD_REGEX = /^(\d{4})-(\d{2})-(H1|H2)$/;

export function isTimesheetHalf(value: unknown): value is TimesheetHalf {
  return value === 'H1' || value === 'H2';
}

export function buildTimesheetApprovalPeriod(year: number, month: number, half: TimesheetHalf): string {
  return `${year}-${String(month).padStart(2, '0')}-${half}`;
}

export function parseTimesheetApprovalPeriod(period: string): ITimesheetPeriodParts | null {
  const match = period.match(PERIOD_REGEX);
  if (!match) return null;

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const half = match[3] as TimesheetHalf;

  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    return null;
  }

  return { year, month, half };
}

export function getLastDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

export function getTimesheetPeriodDateRange(period: string): { startDate: string; endDate: string } | null {
  const parsed = parseTimesheetApprovalPeriod(period);
  if (!parsed) return null;

  const { year, month, half } = parsed;
  const startDay = half === 'H1' ? 1 : 16;
  const endDay = half === 'H1' ? 15 : getLastDayOfMonth(year, month);

  return {
    startDate: `${year}-${String(month).padStart(2, '0')}-${String(startDay).padStart(2, '0')}`,
    endDate: `${year}-${String(month).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`,
  };
}

export function formatTimesheetHalfLabel(half: TimesheetHalf, year: number, month: number): string {
  const lastDay = getLastDayOfMonth(year, month);
  return half === 'H1' ? '1-15' : `16-${lastDay}`;
}

export function getPreviousTimesheetApprovalPeriod(period: string): string | null {
  const parsed = parseTimesheetApprovalPeriod(period);
  if (!parsed) return null;

  if (parsed.half === 'H2') {
    return buildTimesheetApprovalPeriod(parsed.year, parsed.month, 'H1');
  }

  const prevMonth = parsed.month === 1 ? 12 : parsed.month - 1;
  const prevYear = parsed.month === 1 ? parsed.year - 1 : parsed.year;
  return buildTimesheetApprovalPeriod(prevYear, prevMonth, 'H2');
}

export function getCurrentTimesheetApprovalPeriod(date = new Date(), timeZone = 'Europe/Moscow'): string {
  const parts = getZonedDateParts(date, timeZone);
  return buildTimesheetApprovalPeriod(parts.year, parts.month, parts.day <= 15 ? 'H1' : 'H2');
}

export function getZonedDateParts(date: Date, timeZone: string): IZonedDateParts {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const partMap = new Map(
    formatter
      .formatToParts(date)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value]),
  );

  return {
    year: Number.parseInt(partMap.get('year') || '0', 10),
    month: Number.parseInt(partMap.get('month') || '0', 10),
    day: Number.parseInt(partMap.get('day') || '0', 10),
    hour: Number.parseInt(partMap.get('hour') || '0', 10),
    minute: Number.parseInt(partMap.get('minute') || '0', 10),
    second: Number.parseInt(partMap.get('second') || '0', 10),
  };
}

export function getTimesheetReminderEventsForDate(
  date: Date,
  settings: Pick<
    ITimesheetReminderSettings,
    'timezone' | 'openingReminderHour' | 'deadlineMorningHour' | 'deadlineAfternoonHour' | 'escalationHour' | 'overdueHour'
  >,
): ITimesheetReminderEvent[] {
  const parts = getZonedDateParts(date, settings.timezone);
  const currentH1 = buildTimesheetApprovalPeriod(parts.year, parts.month, 'H1');
  const currentH2 = buildTimesheetApprovalPeriod(parts.year, parts.month, 'H2');
  const lastDay = getLastDayOfMonth(parts.year, parts.month);
  const events: ITimesheetReminderEvent[] = [];

  if (parts.day === 1 && parts.hour >= settings.openingReminderHour) {
    events.push({ period: currentH1, stage: 'opening' });
  }

  if (parts.day === 15) {
    if (parts.hour >= settings.deadlineMorningHour) {
      events.push({ period: currentH1, stage: 'deadline_morning' });
    }
    if (parts.hour >= settings.deadlineAfternoonHour) {
      events.push({ period: currentH1, stage: 'deadline_afternoon' });
    }
    if (parts.hour >= settings.escalationHour) {
      events.push({ period: currentH1, stage: 'escalation' });
    }
  }

  if (parts.day === 16 && parts.hour >= settings.openingReminderHour) {
    events.push({ period: currentH2, stage: 'opening' });
  }

  if (parts.day === 16 && parts.hour >= settings.overdueHour) {
    events.push({ period: currentH1, stage: 'overdue' });
  }

  if (parts.day === lastDay) {
    if (parts.hour >= settings.deadlineMorningHour) {
      events.push({ period: currentH2, stage: 'deadline_morning' });
    }
    if (parts.hour >= settings.deadlineAfternoonHour) {
      events.push({ period: currentH2, stage: 'deadline_afternoon' });
    }
    if (parts.hour >= settings.escalationHour) {
      events.push({ period: currentH2, stage: 'escalation' });
    }
  }

  if (parts.day === 1 && parts.hour >= settings.overdueHour) {
    const previousH2 = getPreviousTimesheetApprovalPeriod(currentH1);
    if (previousH2) {
      events.push({ period: previousH2, stage: 'overdue' });
    }
  }

  return dedupeReminderEvents(events);
}

function dedupeReminderEvents(events: ITimesheetReminderEvent[]): ITimesheetReminderEvent[] {
  const seen = new Set<string>();
  const result: ITimesheetReminderEvent[] = [];

  for (const event of events) {
    const key = `${event.period}:${event.stage}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(event);
  }

  return result;
}
