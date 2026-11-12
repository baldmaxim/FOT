/**
 * Окно «Добавить сотрудника» / ✎ удержания — во вкладке кадров «Удержания» и в «Справочнике» «Зарплаты»: разбор
 * полей повторяет проверку сервера — ошибка видна до запроса, а не ответом 400.
 */
import type {
  IPlannedDeductionPayload,
  IStaffDeductionKind,
  IStaffDeductionPayload,
} from '../services/staffDeductionService';
import { shiftMonth } from './moscowDate';
import { rateAmountInputValue } from './payrollDictionary';
import { parsePositiveAmount } from './payrollRegistryForms';

export type StaffDeductionField = 'employee' | 'kind' | 'month' | 'amount';

export type StaffDeductionParse =
  | { ok: true; payload: IStaffDeductionPayload }
  | { ok: false; field: StaffDeductionField; message: string };

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export const parseStaffDeduction = (draft: {
  /** Сотрудник выбран (при правке — всегда). */
  selected: boolean;
  kindId: number | null;
  /** null — без подвида. */
  subkindId: number | null;
  month: string;
  amount: string;
}): StaffDeductionParse => {
  if (!draft.selected) return { ok: false, field: 'employee', message: 'Выберите сотрудника' };
  if (draft.kindId === null) return { ok: false, field: 'kind', message: 'Выберите вид удержания' };
  if (!MONTH_PATTERN.test(draft.month)) return { ok: false, field: 'month', message: 'Укажите месяц' };
  const amount = parsePositiveAmount(draft.amount);
  if ('error' in amount) return { ok: false, field: 'amount', message: amount.error };
  return {
    ok: true,
    payload: { kind_id: draft.kindId, subkind_id: draft.subkindId, month: draft.month, amount: amount.amount },
  };
};

/**
 * Сумма по умолчанию для выбранных вида и подвида (миграция 321): у подвида своя — она; нет — сумма вида.
 * Вид не выбран или его нет в справочнике — null.
 */
export const deductionDefaultAmount = (
  kinds: readonly IStaffDeductionKind[],
  kindId: number | null,
  subkindId: number | null,
): string | null => {
  const kind = kinds.find(entry => entry.id === kindId);
  if (!kind) return null;
  const subkind = kind.subkinds.find(entry => entry.id === subkindId);
  return subkind?.default_amount ?? kind.default_amount;
};

/**
 * Сумма в поле после смены вида или подвида: пусто или стоит сумма по умолчанию прежнего вида — подставляется сумма
 * нового вида (нет её — поле пустеет); введённую руками сумму смена вида не трогает.
 */
export const amountAfterKindChange = (
  current: string,
  previousDefault: string | null | undefined,
  nextDefault: string | null | undefined,
): string => {
  const untouched = current.trim() === '' || current === rateAmountInputValue(previousDefault);
  return untouched ? rateAmountInputValue(nextDefault) : current;
};

/**
 * Месяц после выбора сотрудника: уволенному удержание — не позже месяца увольнения (сервер проверяет то же), поэтому
 * выбранный месяц позже увольнения становится месяцем увольнения; раньше — остаётся. Работающему — без изменений.
 * month — YYYY-MM, dismissalDate — YYYY-MM-DD.
 */
export const monthForDismissed = (month: string, dismissalDate: string | null | undefined): string => {
  if (!dismissalDate) return month;
  const dismissalMonth = dismissalDate.slice(0, 7);
  return month > dismissalMonth ? dismissalMonth : month;
};

/**
 * Виды для списков окна правки: вид и подвид строки могли удалить из справочника — они остаются в списках (сервер
 * ответит понятной ошибкой), остальные виды — те же объекты. kept не передан (добавление) — справочник как есть.
 */
export const withKeptKind = (
  kinds: readonly IStaffDeductionKind[],
  kept?: { kind_id: number; kind_name: string; subkind_id: number | null; subkind_name: string | null },
): readonly IStaffDeductionKind[] => {
  if (!kept) return kinds;
  const kind = kinds.find(entry => entry.id === kept.kind_id)
    ?? { id: kept.kind_id, name: kept.kind_name, default_amount: null, subkinds: [] };
  const subkinds = kept.subkind_id === null || kept.subkind_name === null
    || kind.subkinds.some(subkind => subkind.id === kept.subkind_id)
    ? kind.subkinds
    : [...kind.subkinds, { id: kept.subkind_id, kind_id: kept.kind_id, name: kept.subkind_name, default_amount: null }];
  const patched = { ...kind, subkinds };
  return kinds.some(entry => entry.id === kind.id)
    ? kinds.map(entry => (entry.id === kind.id ? patched : entry))
    : [...kinds, patched];
};

/** «С месяца» планового: 11 назад (как у разового — поиск уволенных рассчитан на них) … 12 вперёд. */
const PLANNED_FROM_BACK = 11;
const PLANNED_FROM_AHEAD = 12;
/** «По месяц»: до 5 лет вперёд; дальше — «Бессрочно». */
const PLANNED_TO_AHEAD = 60;

/** Месяцы a…b по возрастанию (YYYY-MM). */
const monthRange = (from: string, to: string): string[] => {
  const months: string[] = [];
  for (let month = from; month <= to; month = shiftMonth(month, 1)) months.push(month);
  return months;
};

/** Список с месяцем правки, если он вне диапазона (по возрастанию). */
const withMonth = (options: string[], kept: string | null | undefined): string[] => (
  kept && !options.includes(kept) ? [...options, kept].sort() : options
);

/** «С месяца»: currentMonth − 11 … + 12; значение правки вне диапазона — тоже в списке. */
export const plannedFromMonthOptions = (currentMonth: string, kept?: string | null): string[] => withMonth(
  monthRange(shiftMonth(currentMonth, -PLANNED_FROM_BACK), shiftMonth(currentMonth, PLANNED_FROM_AHEAD)),
  kept,
);

/** «По месяц»: от «С месяца» до currentMonth + 60; значение правки вне диапазона — тоже в списке. */
export const plannedToMonthOptions = (monthFrom: string, currentMonth: string, kept?: string | null): string[] => {
  const last = shiftMonth(currentMonth, PLANNED_TO_AHEAD);
  return withMonth(monthRange(monthFrom, last > monthFrom ? last : monthFrom), kept && kept >= monthFrom ? kept : null);
};

/** «По» после смены «С»: раньше нового начала — становится им, бессрочно ('') — остаётся. */
export const monthToAfterFromChange = (monthTo: string, monthFrom: string): string => (
  monthTo !== '' && monthTo < monthFrom ? monthFrom : monthTo
);

/**
 * Другая сумма в последнем месяце (миграция 362) — только если «По месяц» задан и позже «С месяца»: у бессрочного
 * последнего месяца нет, у периода в месяц он единственный. Сервер и БД проверяют то же.
 */
export const plannedLastMonthAllowed = (monthFrom: string, monthTo: string): boolean => (
  monthTo !== '' && monthTo > monthFrom
);

export type PlannedDeductionField = 'employee' | 'kind' | 'month_from' | 'month_to' | 'amount' | 'last_month_amount';

export type PlannedDeductionParse =
  | { ok: true; payload: IPlannedDeductionPayload }
  | { ok: false; field: PlannedDeductionField; message: string };

/**
 * Окно планового удержания: та же проверка, что на сервере, — ошибка видна до запроса. monthTo '' — бессрочно.
 * lastMonth — галочка «Другая сумма в последнем месяце»; при периоде без последнего месяца её нет на экране — не
 * учитывается (сумма последнего месяца — null).
 */
export const parsePlannedDeduction = (draft: {
  selected: boolean;
  kindId: number | null;
  subkindId: number | null;
  amount: string;
  monthFrom: string;
  monthTo: string;
  lastMonth?: boolean;
  lastMonthAmount?: string;
}): PlannedDeductionParse => {
  if (!draft.selected) return { ok: false, field: 'employee', message: 'Выберите сотрудника' };
  if (draft.kindId === null) return { ok: false, field: 'kind', message: 'Выберите вид удержания' };
  const amount = parsePositiveAmount(draft.amount);
  if ('error' in amount) return { ok: false, field: 'amount', message: amount.error };
  if (!MONTH_PATTERN.test(draft.monthFrom)) return { ok: false, field: 'month_from', message: 'Укажите месяц начала' };
  if (draft.monthTo !== '' && !MONTH_PATTERN.test(draft.monthTo)) {
    return { ok: false, field: 'month_to', message: 'Укажите месяц окончания' };
  }
  if (draft.monthTo !== '' && draft.monthTo < draft.monthFrom) {
    return { ok: false, field: 'month_to', message: '«По месяц» не может быть раньше «С месяца»' };
  }
  let lastMonthAmount: number | null = null;
  if (draft.lastMonth && plannedLastMonthAllowed(draft.monthFrom, draft.monthTo)) {
    const parsed = parsePositiveAmount(draft.lastMonthAmount ?? '');
    if ('error' in parsed) return { ok: false, field: 'last_month_amount', message: parsed.error };
    // Сравнение в копейках: ввод — не больше двух знаков.
    if (Math.round(parsed.amount * 100) === Math.round(amount.amount * 100)) {
      return {
        ok: false, field: 'last_month_amount', message: 'Сумма в последнем месяце равна сумме в месяц — снимите галочку',
      };
    }
    lastMonthAmount = parsed.amount;
  }
  return {
    ok: true,
    payload: {
      kind_id: draft.kindId,
      subkind_id: draft.subkindId,
      amount: amount.amount,
      month_from: draft.monthFrom,
      month_to: draft.monthTo === '' ? null : draft.monthTo,
      last_month_amount: lastMonthAmount,
    },
  };
};
