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
 *
 * «Доля», вписанная рублями (миграция 355, решение 09.11.2026): у вписанного ровно она, остаток выработки объекта делится
 * между остальными по КТУ × минуты; КТУ вписанного — расчётный. Не сходится (больше выработки, остаток некому, расчётный
 * КТУ выше 2,2, доля без часов) — конфликт объекта: долей на нём нет ни у кого, частичных сумм не бывает.
 */
import type { IProductionCalendarMonth, IResolvedSchedule } from '../../types/index.js';
import { getHolidayLunchHours } from '../holiday-lunch.util.js';
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
  const holidayLunchHours = getHolidayLunchHours(schedule, localDate, calendar);
  if (!isWorkingDay(schedule, localDate, calendar)) {
    if (day.corrected) return { minutes: factMinutes };
    return { minutes: Math.min(factMinutes, hoursToMinutes(schedule.work_hours + holidayLunchHours)) };
  }
  return { minutes: Math.min(factMinutes, hoursToMinutes(getDayNormHours(schedule, localDate, calendar) + holidayLunchHours)) };
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

/** КТУ — 0,0…2,2 с шагом 0,1 (миграция 355); предел и для расчётного КТУ вписанной доли. */
export const KTU_MIN_TENTHS = 0;
export const KTU_MAX_TENTHS = 22;

/**
 * Расчётный КТУ вписанной доли, 2 знака: S × W / (R × m) в десятых → '1.59'. Это КТУ, при котором формула дала бы ровно
 * вписанную сумму. W (Σ весов невписанных) или R (остаток выработки) равен нулю — сравнить не с кем, null.
 */
export const effectiveKtu = (
  fixedCents: bigint,
  freeWeight: bigint,
  remainderCents: bigint,
  minutes: number,
): string | null => {
  if (freeWeight <= 0n || remainderCents <= 0n || minutes <= 0) return null;
  const numerator = fixedCents * freeWeight * 10n;
  const denominator = remainderCents * BigInt(minutes);
  // Сотые, округление половины вверх.
  const hundredths = (2n * numerator + denominator) / (2n * denominator);
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, '0')}`;
};

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

/**
 * Состояние объекта: no_output — выработка не внесена; nothing_to_distribute — внесена, учтённых минут нет;
 * by_brigade — выработка внесена одной суммой на бригаду (341), объект только для показа часов; share_conflict —
 * вписанные доли не сходятся с выработкой (355), долей на объекте нет.
 */
export type BrigadeObjectState = 'ok' | 'no_output' | 'nothing_to_distribute' | 'by_brigade' | 'share_conflict';

/**
 * Почему вписанные доли объекта не сходятся:
 *  - fixed_exceeds_output — Σ вписанных больше выработки, amount — на сколько;
 *  - remainder_without_weight — остаток выработки некому распределить (у остальных КТУ 0 или все вписаны), amount;
 *  - ktu_above_max — расчётный КТУ вписанного выше 2,2 (ktu — расчётный, null — бесконечный: остаток 0);
 *  - fixed_without_hours — доля вписана тому, у кого на объекте нет учтённых часов (или его нет в бригаде).
 */
export type BrigadeShareConflictCode =
  | 'fixed_exceeds_output' | 'remainder_without_weight' | 'ktu_above_max' | 'fixed_without_hours';

export interface IBrigadeShareConflict {
  code: BrigadeShareConflictCode;
  /** Превышение или остаток, NUMERIC строкой (fixed_exceeds_output, remainder_without_weight). */
  amount?: string;
  employee_id?: number;
  /** Расчётный КТУ (ktu_above_max): '2.41'; null — остаток 0, КТУ бесконечный. */
  ktu?: string | null;
}

export interface IBrigadeObjectMemberInput {
  employee_id: number;
  ktu_tenths: number;
  /** Учтённые минуты по объектам (только > 0). */
  byObject: ReadonlyMap<string, number>;
}

export interface IBrigadeObjectResult {
  state: BrigadeObjectState;
  /**
   * Σ весов невписанных — КТУ в десятых × минуты на объекте; точный знаменатель их долей. Без вписанных — Σ весов
   * объекта, как до 355.
   */
  total_weight: number;
  /** Доли участников объекта в копейках; null — долей нет (не внесена, делить не по чему, конфликт или ошибка). */
  amounts: Map<number, bigint> | null;
  /** Σ применённых вписанных долей (у тех, у кого на объекте есть минуты); остаток — выработка минус она. */
  fixed_total: bigint;
  /** Конфликты вписанных долей (state = share_conflict); пусто — сходится. */
  conflicts: IBrigadeShareConflict[];
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
 *  - вписанная доля (355) — ровно она; остальным — остаток по КТУ × минуты; не сходится — конфликт объекта, долей нет;
 *  - итог сотрудника null, только если у него есть учтённые минуты на объекте без выработки (или с конфликтом);
 *    выработка на объекте без минут («некому распределить») чужие суммы не трогает; у кого минут нет — 0,00, если у
 *    бригады внесена хоть одна выработка, иначе null;
 *  - есть ошибки — error, долей нет ни у кого (распределение зависит от всех участников);
 *  - общий итог по приоритету: error → no_output → nothing_to_distribute (и конфликт) → ok; ничего не внесено — no_output.
 */
export const buildBrigadeObjectDistribution = (
  outputs: ReadonlyMap<string, bigint>,
  members: ReadonlyArray<IBrigadeObjectMemberInput>,
  errors: ReadonlyArray<IBrigadeSalaryError>,
  fixed: ReadonlyMap<string, ReadonlyMap<number, bigint>> = new Map(),
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
        minutes: member.byObject.get(key)!,
        weight: BigInt(member.ktu_tenths) * BigInt(member.byObject.get(key)!),
      }));
    const output = outputs.get(key);
    // Выработка не внесена — вписанные доли не применяются и конфликтом не считаются.
    const result: IBrigadeObjectResult = output === undefined
      ? {
        state: 'no_output',
        amounts: null,
        total_weight: Number(items.reduce((sum, item) => sum + item.weight, 0n)),
        fixed_total: 0n,
        conflicts: [],
      }
      : distributeObject(output, items, fixed.get(key) ?? new Map());
    objects.set(key, { ...result, amounts: failed ? null : result.amounts });
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
      : states.includes('nothing_to_distribute') || states.includes('share_conflict') ? 'nothing_to_distribute'
        : 'ok';
  return { state, objects, totals };
};

interface IObjectItem {
  employee_id: number;
  minutes: number;
  weight: bigint;
}

/**
 * Делёж одного объекта с внесённой выработкой: без вписанных — как до 355 (0,00 — всем 0,00; веса нулевые — некому
 * распределить); с вписанными — им ровно их суммы, остальным остаток по весам, иначе конфликт.
 */
const distributeObject = (
  output: bigint,
  items: readonly IObjectItem[],
  fixedOnKey: ReadonlyMap<number, bigint>,
): IBrigadeObjectResult => {
  const fixedItems = items.filter(item => fixedOnKey.has(item.employee_id));
  const freeItems = items.filter(item => !fixedOnKey.has(item.employee_id));
  const freeWeight = freeItems.reduce((sum, item) => sum + item.weight, 0n);
  const fixedTotal = fixedItems.reduce((sum, item) => sum + fixedOnKey.get(item.employee_id)!, 0n);
  const base = { total_weight: Number(freeWeight), fixed_total: fixedTotal };

  const conflicts = shareConflicts(output, items, fixedOnKey);
  if (conflicts.length > 0) return { ...base, state: 'share_conflict', amounts: null, conflicts };
  // Конфликтов нет — значит, вписанных без часов тоже нет.
  if (fixedItems.length === 0) {
    if (output === 0n) return { ...base, state: 'ok', amounts: new Map(items.map(item => [item.employee_id, 0n])), conflicts };
    const amounts = distributeByWeights(output, freeItems);
    return { ...base, state: amounts ? 'ok' : 'nothing_to_distribute', amounts, conflicts };
  }
  const remainder = output - fixedTotal;
  const amounts = new Map<number, bigint>(fixedItems.map(item => [item.employee_id, fixedOnKey.get(item.employee_id)!]));
  const freeAmounts = remainder === 0n
    ? new Map(freeItems.map(item => [item.employee_id, 0n]))
    : distributeByWeights(remainder, freeItems)!;
  for (const [employeeId, amount] of freeAmounts) amounts.set(employeeId, amount);
  return { ...base, state: 'ok', amounts, conflicts };
};

/**
 * Конфликты вписанных долей объекта с внесённой выработкой (пусто — сходится). Одна функция у расчёта и у проверки
 * ввода: что прошло проверку, то и посчитается. Расчётный КТУ проверяется у всех вписанных, целыми:
 * S × W ≤ 22 × R × m.
 */
export const shareConflicts = (
  output: bigint,
  items: ReadonlyArray<IObjectItem>,
  fixedOnKey: ReadonlyMap<number, bigint>,
): IBrigadeShareConflict[] => {
  if (fixedOnKey.size === 0) return [];
  const present = new Set(items.map(item => item.employee_id));
  const conflicts: IBrigadeShareConflict[] = [...fixedOnKey.keys()]
    .filter(employeeId => !present.has(employeeId))
    .sort((a, b) => a - b)
    .map(employeeId => ({ code: 'fixed_without_hours' as const, employee_id: employeeId }));
  const fixedItems = items.filter(item => fixedOnKey.has(item.employee_id));
  if (fixedItems.length === 0) return conflicts;
  const freeWeight = items
    .filter(item => !fixedOnKey.has(item.employee_id))
    .reduce((sum, item) => sum + item.weight, 0n);
  const fixedTotal = fixedItems.reduce((sum, item) => sum + fixedOnKey.get(item.employee_id)!, 0n);
  const remainder = output - fixedTotal;
  if (remainder < 0n) return [...conflicts, { code: 'fixed_exceeds_output', amount: centsToMoney(-remainder) }];
  if (freeWeight === 0n) {
    return remainder > 0n ? [...conflicts, { code: 'remainder_without_weight', amount: centsToMoney(remainder) }] : conflicts;
  }
  const limit = BigInt(KTU_MAX_TENTHS);
  for (const item of [...fixedItems].sort((a, b) => a.employee_id - b.employee_id)) {
    const share = fixedOnKey.get(item.employee_id)!;
    if (share * freeWeight > limit * remainder * BigInt(item.minutes)) {
      conflicts.push({
        code: 'ktu_above_max',
        employee_id: item.employee_id,
        ktu: effectiveKtu(share, freeWeight, remainder, item.minutes),
      });
    }
  }
  return conflicts;
};

/**
 * Наибольшая доля, которую можно вписать сотруднику на объекте при остальных вписанных как есть, — в копейках вниз;
 * limitedBy — чей расчётный КТУ упрётся в 2,2 (сам или уже вписанный). exact — остальным распределять некому (Σ их
 * весов 0): вписать можно только ровно остаток. null — не впишется ничего (остаток уже отрицательный).
 */
export const maxFixedShare = (
  output: bigint,
  items: ReadonlyArray<IObjectItem>,
  fixedOthers: ReadonlyMap<number, bigint>,
  employeeId: number,
): { max: bigint; limitedBy: number; exact: boolean } | null => {
  const self = items.find(item => item.employee_id === employeeId);
  if (!self) return null;
  const others = items.filter(item => item.employee_id !== employeeId);
  const fixedItems = others.filter(item => fixedOthers.has(item.employee_id));
  const freeWeight = others
    .filter(item => !fixedOthers.has(item.employee_id))
    .reduce((sum, item) => sum + item.weight, 0n);
  const remainder = output - fixedItems.reduce((sum, item) => sum + fixedOthers.get(item.employee_id)!, 0n);
  if (remainder < 0n) return null;
  if (freeWeight === 0n) return { max: remainder, limitedBy: employeeId, exact: true };
  const limit = BigInt(KTU_MAX_TENTHS);
  // Сам: S × W' ≤ 22 × m × (R − S) → S ≤ 22·m·R / (W' + 22·m).
  const selfLimit = limit * BigInt(self.minutes);
  let best = { max: (selfLimit * remainder) / (freeWeight + selfLimit), limitedBy: employeeId, exact: false };
  // Уже вписанный j: S_j × W' ≤ 22 × m_j × (R − S) → S ≤ R − ⌈S_j × W' / (22 × m_j)⌉.
  for (const item of [...fixedItems].sort((a, b) => a.employee_id - b.employee_id)) {
    const denominator = limit * BigInt(item.minutes);
    const need = (fixedOthers.get(item.employee_id)! * freeWeight + denominator - 1n) / denominator;
    const max = remainder - need;
    if (max < best.max) best = { max, limitedBy: item.employee_id, exact: false };
  }
  return best.max < 0n ? null : best;
};

/** Строка расчёта бригады в части, нужной расчётному КТУ: сохранённая (снимок) или живая — одинаково. */
export interface IFixedKtuRowInput {
  employee_id: number;
  ktu: string;
  counted_minutes: number;
  amount: string | null;
  /** Сумма бригаде: вписанная доля строки. */
  fixed_amount?: string;
  objects?: ReadonlyArray<{ object_key: string; counted_minutes: number; amount: string | null; fixed_amount?: string }>;
}

/** Ключ доли при выработке одной суммой на бригаду — тот же, что BRIGADE_WHOLE_SHARE_KEY ввода. */
export const BRIGADE_WHOLE_FIXED_KEY = '__brigade__';

/**
 * Расчётный КТУ применённых вписанных долей из строк расчёта: ключ ('__brigade__' у суммы бригаде) → сотрудник →
 * '1.59' (null — сравнить не с кем). Одна функция у «Зарплаты по объектам» и у «Расчётов»: КТУ на экранах одинаковый.
 * У конфликта долей нет — и КТУ нет.
 */
export const fixedShareKtus = (
  wholeOutput: string | null | undefined,
  rows: ReadonlyArray<IFixedKtuRowInput>,
  objects: ReadonlyArray<{ object_key: string; output: string | null; total_weight: number }>,
): Map<string, Map<number, string | null>> => {
  const result = new Map<string, Map<number, string | null>>();
  if (wholeOutput !== undefined) {
    const applied = rows.filter(row => row.fixed_amount !== undefined && row.amount !== null);
    if (wholeOutput === null || applied.length === 0) return result;
    const freeWeight = rows
      .filter(row => row.fixed_amount === undefined)
      .reduce((sum, row) => sum + BigInt(ktuToTenths(row.ktu)) * BigInt(row.counted_minutes), 0n);
    const remainder = moneyToCents(wholeOutput)
      - applied.reduce((sum, row) => sum + moneyToCents(row.fixed_amount!), 0n);
    result.set(BRIGADE_WHOLE_FIXED_KEY, new Map(applied.map(row => [
      row.employee_id,
      effectiveKtu(moneyToCents(row.fixed_amount!), freeWeight, remainder, row.counted_minutes),
    ])));
    return result;
  }
  for (const object of objects) {
    if (object.output === null) continue;
    const applied = rows.flatMap(row => (row.objects ?? [])
      .filter(part => part.object_key === object.object_key && part.fixed_amount !== undefined && part.amount !== null)
      .map(part => ({ employee_id: row.employee_id, minutes: part.counted_minutes, fixed: moneyToCents(part.fixed_amount!) })));
    if (applied.length === 0) continue;
    const remainder = moneyToCents(object.output) - applied.reduce((sum, item) => sum + item.fixed, 0n);
    const freeWeight = BigInt(object.total_weight);
    result.set(object.object_key, new Map(applied.map(item => [
      item.employee_id,
      effectiveKtu(item.fixed, freeWeight, remainder, item.minutes),
    ])));
  }
  return result;
};
