/**
 * Распределение «Выработки» бригады (вкладка «Табель → Зарплата»): чистые функции без БД.
 *
 * Учтённые часы дня — по графику; переработка — только корректировкой с часами или согласованным
 * выходом в выходной (решение 27.10.2026). Сырой СКУД сверх графика обрезается.
 *
 * Деньги — целые копейки в BigInt, веса — целые (КТУ в десятых × минуты): дробей нет нигде, Σ долей
 * равна выработке до копейки.
 */
import type { IProductionCalendarMonth, IResolvedSchedule } from '../../types/index.js';
import { getDayNormHours, isWorkingDay } from '../schedule.service.js';

/** День табеля так, как он лежит в редакции (timesheet_versions.payload) и в живом dataMap. */
export interface IBrigadeDayValue {
  status: string;
  hours: number;
  /** День закрыт правкой (корректировка, согласованный выход) — в выходной часы идут целиком. */
  corrected: boolean;
  /** Часы проставлены корректировкой — идут целиком, даже сверх графика. */
  hours_overridden: boolean;
}

export type BrigadeSalaryErrorCode = 'unknown_status' | 'no_schedule' | 'duplicate_day';

export interface IBrigadeSalaryError {
  employee_id: number;
  code: BrigadeSalaryErrorCode;
  date: string;
}

/** Статусы без оплачиваемых часов: статус важнее hours_overridden. */
const ZERO_STATUSES: ReadonlySet<string> = new Set([
  'vacation', 'sick', 'educational_leave', 'unpaid', 'dayoff', 'absent',
]);

/** Отработанные статусы: УУ, РБ, УД — как явка. */
const WORKED_STATUSES: ReadonlySet<string> = new Set([
  'work', 'manual', 'remote', 'sick_worked', 'study_day',
]);

export const hoursToMinutes = (hours: number): number => Math.round(hours * 60);

const toLocalDate = (iso: string): Date => {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year, month - 1, day);
};

/**
 * Учтённые минуты одного дня. Несогласованные часы выходного сюда уже приходят нулём
 * (includeExportDayHours), поэтому оставшиеся часы выходного без правки — плановая суббота/воскресенье.
 */
export const countedMinutesForDay = (
  day: IBrigadeDayValue,
  schedule: IResolvedSchedule | undefined,
  date: string,
  calendar: IProductionCalendarMonth | null,
): { minutes: number } | { error: BrigadeSalaryErrorCode } => {
  if (ZERO_STATUSES.has(day.status)) return { minutes: 0 };
  if (!WORKED_STATUSES.has(day.status)) return { error: 'unknown_status' };
  const factMinutes = hoursToMinutes(day.hours > 0 ? day.hours : 0);
  if (factMinutes === 0) return { minutes: 0 };
  if (day.hours_overridden) return { minutes: factMinutes };
  if (!schedule) return { error: 'no_schedule' };

  const localDate = toLocalDate(date);
  if (!isWorkingDay(schedule, localDate, calendar)) {
    if (day.corrected) return { minutes: factMinutes };
    return { minutes: Math.min(factMinutes, hoursToMinutes(schedule.work_hours)) };
  }
  return { minutes: Math.min(factMinutes, hoursToMinutes(getDayNormHours(schedule, localDate, calendar))) };
};

/** Учтённые минуты сотрудника за его дни в бригаде; ошибки — по дням. */
export const countMemberMinutes = (
  employeeId: number,
  days: ReadonlyMap<string, IBrigadeDayValue>,
  schedules: ReadonlyMap<string, IResolvedSchedule> | undefined,
  calendar: IProductionCalendarMonth | null,
): { minutes: number; errors: IBrigadeSalaryError[] } => {
  let minutes = 0;
  const errors: IBrigadeSalaryError[] = [];
  for (const [date, value] of [...days].sort(([a], [b]) => a.localeCompare(b))) {
    const counted = countedMinutesForDay(value, schedules?.get(date), date, calendar);
    if ('error' in counted) errors.push({ employee_id: employeeId, code: counted.error, date });
    else minutes += counted.minutes;
  }
  return { minutes, errors };
};

/** '1234.5' / '1234.56' → копейки. Строка из NUMERIC(12,2), не float. */
export const moneyToCents = (amount: string): bigint => {
  const negative = amount.startsWith('-');
  const [whole, fraction = ''] = (negative ? amount.slice(1) : amount).split('.');
  const cents = BigInt(whole || '0') * 100n + BigInt((fraction + '00').slice(0, 2));
  return negative ? -cents : cents;
};

export const centsToMoney = (cents: bigint): string => {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const fraction = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${abs / 100n}.${fraction}`;
};

/** '1.5' → 15. КТУ хранится NUMERIC(2,1). */
export const ktuToTenths = (ktu: string): number => Math.round(Number(ktu) * 10);

export const tenthsToKtu = (tenths: number): string => (tenths / 10).toFixed(1);

/**
 * Доли выработки пропорционально весам. Остаток копеек — по наибольшим остаткам деления,
 * при равенстве — по employee_id. Σ весов = 0 — null (распределять не по чему).
 */
export const distributeByWeights = (
  totalCents: bigint,
  items: ReadonlyArray<{ employee_id: number; weight: bigint }>,
): Map<number, bigint> | null => {
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0n);
  if (totalWeight === 0n) return null;
  const shares = items.map(item => ({
    employee_id: item.employee_id,
    base: (totalCents * item.weight) / totalWeight,
    remainder: (totalCents * item.weight) % totalWeight,
  }));
  let leftover = totalCents - shares.reduce((sum, share) => sum + share.base, 0n);
  const byRemainder = [...shares].sort((a, b) => (
    a.remainder === b.remainder ? a.employee_id - b.employee_id : (a.remainder > b.remainder ? -1 : 1)
  ));
  const result = new Map(shares.map(share => [share.employee_id, share.base]));
  for (const share of byRemainder) {
    if (leftover <= 0n) break;
    result.set(share.employee_id, (result.get(share.employee_id) ?? 0n) + 1n);
    leftover -= 1n;
  }
  return result;
};

export type BrigadeDistributionState = 'ok' | 'no_output' | 'nothing_to_distribute' | 'error';

export interface IBrigadeMemberInput {
  employee_id: number;
  ktu_tenths: number;
  minutes: number;
}

/**
 * Итог бригады: доли по КТУ × минуты. Выработка не введена — no_output; 0,00 — всем 0,00;
 * есть ошибки дней — error (без долей: распределение зависит от всех участников).
 */
export const buildBrigadeDistribution = (
  outputCents: bigint | null,
  members: ReadonlyArray<IBrigadeMemberInput>,
  errors: ReadonlyArray<IBrigadeSalaryError>,
): { state: BrigadeDistributionState; amounts: Map<number, bigint> | null } => {
  if (errors.length > 0) return { state: 'error', amounts: null };
  if (outputCents === null) return { state: 'no_output', amounts: null };
  if (outputCents === 0n) return { state: 'ok', amounts: new Map(members.map(member => [member.employee_id, 0n])) };
  const amounts = distributeByWeights(
    outputCents,
    members.map(member => ({
      employee_id: member.employee_id,
      weight: BigInt(member.ktu_tenths) * BigInt(member.minutes),
    })),
  );
  if (!amounts) return { state: 'nothing_to_distribute', amounts: null };
  return { state: 'ok', amounts };
};
