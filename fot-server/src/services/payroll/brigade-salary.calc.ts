/**
 * Распределение «Выработки» бригады (вкладка «Табель → Зарплата по объектам»): чистые функции без БД.
 *
 * Учтённые часы дня — по графику; переработка — только корректировкой с часами или согласованным
 * выходом в выходной (решение 27.10.2026). Сырой СКУД сверх графика обрезается.
 *
 * Выработка вводится по объектам (решение 29.10.2026, миграция 336): учтённые минуты дня раскладываются по
 * объектам дня пропорционально часам на объекте, выработка объекта делится по КТУ × минуты на этом объекте.
 *
 * Деньги — целые копейки в BigInt, веса — целые (КТУ в десятых × минуты): дробей нет нигде, Σ долей
 * объекта равна его выработке до копейки.
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
  /**
   * Часы дня по объектам (object_key → часы) — та же разбивка, что уходит в 1С по объектам; веса раскладки
   * учтённых минут. Нет или все нулевые — день целиком в «Не определён».
   */
  objects?: ReadonlyMap<string, number>;
}

/** object_config — разбивку по объектам собрать нельзя (режим «объект» без закреплённого объекта): даты нет. */
export type BrigadeSalaryErrorCode = 'unknown_status' | 'no_schedule' | 'duplicate_day' | 'object_config';

export interface IBrigadeSalaryError {
  employee_id: number;
  code: BrigadeSalaryErrorCode;
  /** null — ошибка не дня, а настройки сотрудника (object_config). */
  date: string | null;
}

/** «Не определён» — тот же ключ, что UNKNOWN_OBJECT_KEY разбивки (timesheet-object.service). */
export const BRIGADE_UNKNOWN_OBJECT_KEY = '__unknown_object__';

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

/** Весы объектов дня в сотых часа: только положительные, ключи по порядку. */
const objectWeights = (objects: ReadonlyMap<string, number> | undefined): Array<[string, bigint]> => (
  [...(objects ?? [])]
    .map(([key, hours]): [string, bigint] => [key, BigInt(Math.max(0, Math.round(hours * 100)))])
    .filter(([, weight]) => weight > 0n)
    .sort(([a], [b]) => a.localeCompare(b))
);

/**
 * Учтённые минуты дня по объектам: пропорционально часам на объекте, остаток — наибольшим остаткам, при
 * равенстве — по object_key. Весов нет — всё в «Не определён». Σ результата = minutes.
 */
export const splitMinutesByObjects = (
  minutes: number,
  objects: ReadonlyMap<string, number> | undefined,
): Map<string, number> => {
  const result = new Map<string, number>();
  if (minutes <= 0) return result;
  const weights = objectWeights(objects);
  const total = weights.reduce((sum, [, weight]) => sum + weight, 0n);
  if (total === 0n) {
    result.set(BRIGADE_UNKNOWN_OBJECT_KEY, minutes);
    return result;
  }
  const whole = BigInt(minutes);
  const shares = weights.map(([key, weight]) => ({
    key,
    base: (whole * weight) / total,
    remainder: (whole * weight) % total,
  }));
  let leftover = whole - shares.reduce((sum, share) => sum + share.base, 0n);
  for (const share of shares) result.set(share.key, Number(share.base));
  const byRemainder = [...shares].sort((a, b) => (
    a.remainder === b.remainder ? a.key.localeCompare(b.key) : (a.remainder > b.remainder ? -1 : 1)
  ));
  for (const share of byRemainder) {
    if (leftover <= 0n) break;
    result.set(share.key, (result.get(share.key) ?? 0) + 1);
    leftover -= 1n;
  }
  for (const [key, value] of [...result]) if (value === 0) result.delete(key);
  return result;
};

/**
 * Часы дня по объектам для показа (группы «Зарплаты по объектам»): разбивка дня как есть; день с часами без
 * разбивки — целиком в «Не определён», как и его учтённые минуты.
 */
export const displayHoursByObjects = (day: IBrigadeDayValue): Map<string, number> => {
  const result = new Map<string, number>();
  for (const [key, hours] of day.objects ?? []) {
    if (hours > 0) result.set(key, hours);
  }
  if (result.size === 0 && day.hours > 0 && !ZERO_STATUSES.has(day.status)) {
    result.set(BRIGADE_UNKNOWN_OBJECT_KEY, day.hours);
  }
  return result;
};

export interface IMemberMinutes {
  minutes: number;
  /** Учтённые минуты по объектам (только > 0). */
  byObject: Map<string, number>;
  /** Часы по дням на объекте — для показа: object_key → дата → часы. */
  days: Map<string, Map<string, number>>;
  errors: IBrigadeSalaryError[];
}

/** Учтённые минуты сотрудника за его дни в бригаде — всего и по объектам; ошибки — по дням. */
export const countMemberMinutes = (
  employeeId: number,
  days: ReadonlyMap<string, IBrigadeDayValue>,
  schedules: ReadonlyMap<string, IResolvedSchedule> | undefined,
  calendar: IProductionCalendarMonth | null,
): IMemberMinutes => {
  let minutes = 0;
  const byObject = new Map<string, number>();
  const shown = new Map<string, Map<string, number>>();
  const errors: IBrigadeSalaryError[] = [];
  for (const [date, value] of [...days].sort(([a], [b]) => a.localeCompare(b))) {
    for (const [key, hours] of displayHoursByObjects(value)) {
      const byDate = shown.get(key) ?? new Map<string, number>();
      byDate.set(date, hours);
      shown.set(key, byDate);
    }
    const counted = countedMinutesForDay(value, schedules?.get(date), date, calendar);
    if ('error' in counted) {
      errors.push({ employee_id: employeeId, code: counted.error, date });
      continue;
    }
    minutes += counted.minutes;
    for (const [key, part] of splitMinutesByObjects(counted.minutes, value.objects)) {
      byObject.set(key, (byObject.get(key) ?? 0) + part);
    }
  }
  return { minutes, byObject, days: shown, errors };
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

/** Состояние объекта: no_output — выработка не внесена; nothing_to_distribute — внесена, учтённых минут нет. */
export type BrigadeObjectState = 'ok' | 'no_output' | 'nothing_to_distribute';

export interface IBrigadeObjectMemberInput {
  employee_id: number;
  ktu_tenths: number;
  /** Учтённые минуты по объектам (только > 0). */
  byObject: ReadonlyMap<string, number>;
}

export interface IBrigadeObjectResult {
  state: BrigadeObjectState;
  /** Σ весов объекта — КТУ в десятых × минуты на объекте; точный знаменатель долей. */
  total_weight: number;
  /** Доли участников объекта в копейках; null — долей нет (не внесена, делить не по чему или ошибка). */
  amounts: Map<number, bigint> | null;
}

export interface IBrigadeObjectDistribution {
  state: BrigadeDistributionState;
  /** Объекты с учтёнными минутами и с внесённой выработкой, по object_key. */
  objects: Map<string, IBrigadeObjectResult>;
  /** Итог сотрудника — Σ его долей по объектам; null — суммы нет. */
  totals: Map<number, bigint | null>;
}

/**
 * Доли бригады по объектам (решения 29.10.2026):
 *  - доля на объекте = выработка объекта × КТУ × минуты на объекте / Σ; 0,00 — всем на объекте 0,00;
 *  - итог сотрудника null, только если у него есть учтённые минуты на объекте без выработки; выработка на объекте
 *    без минут («некому распределить») чужие суммы не трогает; у кого минут нет — 0,00, если у бригады внесена хоть
 *    одна выработка, иначе null;
 *  - есть ошибки — error, долей нет ни у кого (распределение зависит от всех участников);
 *  - общий итог по приоритету: error → no_output → nothing_to_distribute → ok; ничего не внесено — no_output.
 */
export const buildBrigadeObjectDistribution = (
  outputs: ReadonlyMap<string, bigint>,
  members: ReadonlyArray<IBrigadeObjectMemberInput>,
  errors: ReadonlyArray<IBrigadeSalaryError>,
): IBrigadeObjectDistribution => {
  const failed = errors.length > 0;
  const keys = new Set<string>(outputs.keys());
  for (const member of members) {
    for (const [key, minutes] of member.byObject) if (minutes > 0) keys.add(key);
  }
  const objects = new Map<string, IBrigadeObjectResult>();
  for (const key of [...keys].sort()) {
    const items = members
      .filter(member => (member.byObject.get(key) ?? 0) > 0)
      .map(member => ({
        employee_id: member.employee_id,
        weight: BigInt(member.ktu_tenths) * BigInt(member.byObject.get(key)!),
      }));
    const totalWeight = items.reduce((sum, item) => sum + item.weight, 0n);
    const output = outputs.get(key);
    let state: BrigadeObjectState;
    let amounts: Map<number, bigint> | null = null;
    if (output === undefined) {
      state = 'no_output';
    } else if (output === 0n) {
      state = 'ok';
      amounts = new Map(items.map(item => [item.employee_id, 0n]));
    } else {
      amounts = distributeByWeights(output, items);
      state = amounts ? 'ok' : 'nothing_to_distribute';
    }
    objects.set(key, { state, total_weight: Number(totalWeight), amounts: failed ? null : amounts });
  }

  const totals = new Map<number, bigint | null>();
  for (const member of members) {
    if (failed) {
      totals.set(member.employee_id, null);
      continue;
    }
    let total: bigint | null = 0n;
    let counted = false;
    for (const [key, minutes] of member.byObject) {
      if (minutes <= 0) continue;
      counted = true;
      const share = objects.get(key)?.amounts?.get(member.employee_id);
      if (share === undefined) {
        total = null;
        break;
      }
      total += share;
    }
    totals.set(member.employee_id, counted ? total : (outputs.size > 0 ? 0n : null));
  }

  const states = [...objects.values()].map(object => object.state);
  const state: BrigadeDistributionState = failed ? 'error'
    : outputs.size === 0 || states.includes('no_output') ? 'no_output'
      : states.includes('nothing_to_distribute') ? 'nothing_to_distribute'
        : 'ok';
  return { state, objects, totals };
};
