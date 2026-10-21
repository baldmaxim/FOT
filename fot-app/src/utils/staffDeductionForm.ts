/**
 * Окно «Добавить сотрудника» / ✎ удержания — во вкладке кадров «Удержания» и в «Справочнике» «Зарплаты»: разбор
 * полей повторяет проверку сервера — ошибка видна до запроса, а не ответом 400.
 */
import type { IStaffDeductionKind, IStaffDeductionPayload } from '../services/staffDeductionService';
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
