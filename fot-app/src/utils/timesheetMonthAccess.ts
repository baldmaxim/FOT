const pad2 = (value: number): string => String(value).padStart(2, '0');

const lastDayOfMonth = (year: number, month: number): number =>
  new Date(year, month, 0).getDate();

export const DEFAULT_TIMESHEET_MONTHS_BACK = 1;
export const DEFAULT_TIMESHEET_MONTHS_FORWARD = 1;

const sanitizeBound = (value: unknown, fallback: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
};

export interface ITimesheetMonthAccess {
  isRestrictedManagerView: boolean;
  minDate: string | undefined;
  maxDate: string | undefined;
  monthsBack: number;
  monthsForward: number;
  isMonthAllowed: (year: number, month: number) => boolean;
}

export const getTimesheetMonthAccess = (
  isRestrictedManagerView: boolean,
  monthsBack: number = DEFAULT_TIMESHEET_MONTHS_BACK,
  monthsForward: number = DEFAULT_TIMESHEET_MONTHS_FORWARD,
  now: Date = new Date(),
): ITimesheetMonthAccess => {
  const back = sanitizeBound(monthsBack, DEFAULT_TIMESHEET_MONTHS_BACK);
  const forward = sanitizeBound(monthsForward, DEFAULT_TIMESHEET_MONTHS_FORWARD);

  if (!isRestrictedManagerView) {
    return {
      isRestrictedManagerView: false,
      minDate: undefined,
      maxDate: undefined,
      monthsBack: back,
      monthsForward: forward,
      isMonthAllowed: () => true,
    };
  }

  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  const minDateObj = new Date(currentYear, currentMonth - 1 - back, 1);
  const maxDateObj = new Date(currentYear, currentMonth - 1 + forward, 1);
  const maxYear = maxDateObj.getFullYear();
  const maxMonth = maxDateObj.getMonth() + 1;

  const minDate = `${minDateObj.getFullYear()}-${pad2(minDateObj.getMonth() + 1)}-01`;
  const maxDate = `${maxYear}-${pad2(maxMonth)}-${pad2(lastDayOfMonth(maxYear, maxMonth))}`;

  const currentMonthIndex = currentYear * 12 + currentMonth - 1;

  return {
    isRestrictedManagerView: true,
    minDate,
    maxDate,
    monthsBack: back,
    monthsForward: forward,
    isMonthAllowed: (year: number, month: number) => {
      const idx = year * 12 + month - 1;
      return idx >= currentMonthIndex - back && idx <= currentMonthIndex + forward;
    },
  };
};

export const parseMonthFromIso = (iso: string): { year: number; month: number } | null => {
  const match = /^(\d{4})-(\d{2})/.exec(iso);
  if (!match) return null;
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return null;
  return { year, month };
};
