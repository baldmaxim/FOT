const pad2 = (value: number): string => String(value).padStart(2, '0');

const lastDayOfMonth = (year: number, month: number): number =>
  new Date(year, month, 0).getDate();

export interface ITimesheetMonthAccess {
  isRestrictedManagerView: boolean;
  minDate: string | undefined;
  maxDate: string | undefined;
  isMonthAllowed: (year: number, month: number) => boolean;
}

export const getTimesheetMonthAccess = (
  isRestrictedManagerView: boolean,
  now: Date = new Date(),
): ITimesheetMonthAccess => {
  if (!isRestrictedManagerView) {
    return {
      isRestrictedManagerView: false,
      minDate: undefined,
      maxDate: undefined,
      isMonthAllowed: () => true,
    };
  }

  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  const prevDate = new Date(currentYear, currentMonth - 2, 1);
  const prevYear = prevDate.getFullYear();
  const prevMonth = prevDate.getMonth() + 1;

  const minDate = `${prevYear}-${pad2(prevMonth)}-01`;
  const maxDate = `${currentYear}-${pad2(currentMonth)}-${pad2(lastDayOfMonth(currentYear, currentMonth))}`;

  const currentMonthIndex = currentYear * 12 + currentMonth - 1;

  return {
    isRestrictedManagerView: true,
    minDate,
    maxDate,
    isMonthAllowed: (year: number, month: number) => {
      const idx = year * 12 + month - 1;
      return idx === currentMonthIndex || idx === currentMonthIndex - 1;
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
