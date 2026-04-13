export type TimesheetApprovalHalf = 'H1' | 'H2';

interface IParsedTimesheetApprovalPeriod {
  year: number;
  month: number;
  half: TimesheetApprovalHalf;
}

const PERIOD_REGEX = /^(\d{4})-(\d{2})-(H1|H2)$/;
const MONTH_NAMES = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

export const buildTimesheetApprovalPeriod = (month: string, half: TimesheetApprovalHalf): string => `${month}-${half}`;

export const parseTimesheetApprovalPeriod = (period: string): IParsedTimesheetApprovalPeriod | null => {
  const match = period.match(PERIOD_REGEX);
  if (!match) return null;

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const half = match[3] as TimesheetApprovalHalf;

  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    return null;
  }

  return { year, month, half };
};

export const formatTimesheetHalfLabel = (half: TimesheetApprovalHalf, year: number, month: number): string => {
  if (half === 'H1') return '1-15';
  const lastDay = new Date(year, month, 0).getDate();
  return `16-${lastDay}`;
};

export const formatTimesheetApprovalPeriod = (period: string): string => {
  const parsed = parseTimesheetApprovalPeriod(period);
  if (!parsed) return period;

  const monthLabel = MONTH_NAMES[parsed.month - 1] || `Месяц ${parsed.month}`;
  return `${monthLabel} ${parsed.year}, ${formatTimesheetHalfLabel(parsed.half, parsed.year, parsed.month)}`;
};
