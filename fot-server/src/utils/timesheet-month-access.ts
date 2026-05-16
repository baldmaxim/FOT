/**
 * Политика доступа к месяцам табеля для scope='department' (руководитель):
 * окно [current - monthsBack .. current + monthsForward] настраивается per-role
 * (system_roles.timesheet_months_back / timesheet_months_forward). Дефолты 1/1
 * дают [previous, current, next] — например, отпуск 27 мая – 14 июня создаётся
 * одной операцией. Для scope='all' (админ) ограничений нет — вызывающий код
 * просто не должен звать эту функцию.
 */
export const DEFAULT_TIMESHEET_MONTHS_BACK = 1;
export const DEFAULT_TIMESHEET_MONTHS_FORWARD = 1;

export interface ITimesheetMonthAccessOptions {
  monthsBack?: number;
  monthsForward?: number;
  referenceDate?: Date;
}

export function toMonthIndex(year: number, month: number): number {
  return year * 12 + month - 1;
}

const sanitizeBound = (value: number | undefined, fallback: number): number =>
  Number.isFinite(value) && (value as number) >= 0 ? Math.floor(value as number) : fallback;

export function isDepartmentMonthAllowed(
  year: number,
  month: number,
  options: ITimesheetMonthAccessOptions = {},
): boolean {
  const back = sanitizeBound(options.monthsBack, DEFAULT_TIMESHEET_MONTHS_BACK);
  const forward = sanitizeBound(options.monthsForward, DEFAULT_TIMESHEET_MONTHS_FORWARD);
  const referenceDate = options.referenceDate ?? new Date();
  const requested = toMonthIndex(year, month);
  const current = toMonthIndex(referenceDate.getFullYear(), referenceDate.getMonth() + 1);
  return requested >= current - back && requested <= current + forward;
}

export const DEPARTMENT_MONTH_FORBIDDEN_MESSAGE =
  'Месяц вне разрешённого окна для вашей роли. Обратитесь к администратору для расширения доступа.';

/** Удобный shortcut: достать окно из req.user. */
export function monthAccessFromUser(user: {
  timesheet_months_back?: number;
  timesheet_months_forward?: number;
}): ITimesheetMonthAccessOptions {
  return {
    monthsBack: user.timesheet_months_back,
    monthsForward: user.timesheet_months_forward,
  };
}

/**
 * Единый признак освобождения от окна месяцев табеля.
 * Освобождён, если scope не 'department' (админ/all уже без ограничений) ИЛИ
 * у пользователя стоит признак «Админ» роли (is_admin) — гарантия, что истинный
 * админ никогда не получит 403 по месяцу, даже при edge-case scope.
 */
export function isTimesheetWindowExempt(
  user: { is_admin?: boolean },
  scope: string | null | undefined,
): boolean {
  return scope !== 'department' || user.is_admin === true;
}
