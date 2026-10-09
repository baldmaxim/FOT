/**
 * Удержания сотрудника по месяцам в карточке («Подробно», окно «Расчётов»): строки «месяц · вид · сумма».
 * Один вид за месяц — одна строка. Сохраняются целиком вместе с карточкой.
 */
import type { IPayrollDeductionEntry, IPayrollDeductionEntryPayload } from '../services/payrollService';
import { toInputValue } from './payrollTermsForm';

/** Строка в полях ввода. key — для React и ошибок, на сервер не уходит. */
export interface IDeductionEntryDraft {
  key: string;
  /** YYYY-MM */
  month: string;
  kindId: number | null;
  amount: string;
}

export type DeductionEntryField = 'kind' | 'amount';

export type DeductionEntriesErrors = Record<string, Partial<Record<DeductionEntryField, string>>>;

/** Сохранённые записи → строки формы: «3000.00» → «3000». */
export const toDeductionDrafts = (entries: readonly IPayrollDeductionEntry[]): IDeductionEntryDraft[] => (
  entries.map(entry => ({
    key: `saved-${entry.month}-${entry.kind_id}`,
    month: entry.month,
    kindId: entry.kind_id,
    amount: toInputValue(entry.amount),
  }))
);

/** Новая строка без вида и суммы — не заполнена: не проверяется и не сохраняется. */
const isBlank = (draft: IDeductionEntryDraft): boolean => draft.kindId === null && !draft.amount.trim();

const canonical = (drafts: readonly IDeductionEntryDraft[]): string[] => drafts
  .filter(draft => !isBlank(draft))
  .map(draft => `${draft.month}|${draft.kindId ?? ''}|${draft.amount.trim()}`)
  .sort();

/** Правили ли удержания: набор заполненных строк отличается от сохранённого (порядок не важен). */
export const isDeductionEntriesChanged = (
  drafts: readonly IDeductionEntryDraft[],
  initial: readonly IDeductionEntryDraft[],
): boolean => {
  const a = canonical(drafts);
  const b = canonical(initial);
  return a.length !== b.length || a.some((value, index) => value !== b[index]);
};

/** Сумма удержания: «100,5» → 100.5; не больше двух знаков после запятой. */
const parseAmount = (raw: string): { value: number } | { error: string } => {
  const trimmed = raw.trim();
  if (!trimmed) return { error: 'Укажите сумму' };
  const value = Number(trimmed.replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0) return { error: 'Введите число больше нуля' };
  if (Math.abs(Math.round(value * 100) - value * 100) > 1e-6) return { error: 'Не больше двух знаков после запятой' };
  return { value };
};

export type DeductionEntriesValidation =
  | { payload: IPayrollDeductionEntryPayload[]; errors: null }
  | { payload: null; errors: DeductionEntriesErrors };

/**
 * Проверка и запрос сохранения: вид обязателен, сумма > 0, тот же вид за тот же месяц — второй раз нельзя
 * (ошибка у повторной строки). Незаполненные новые строки пропускаются.
 */
export const validateDeductionEntries = (drafts: readonly IDeductionEntryDraft[]): DeductionEntriesValidation => {
  const errors: DeductionEntriesErrors = {};
  const payload: IPayrollDeductionEntryPayload[] = [];
  const seen = new Set<string>();

  for (const draft of drafts) {
    if (isBlank(draft)) continue;
    const rowErrors: Partial<Record<DeductionEntryField, string>> = {};
    if (draft.kindId === null) {
      rowErrors.kind = 'Выберите вид';
    } else {
      const pair = `${draft.month}|${draft.kindId}`;
      if (seen.has(pair)) rowErrors.kind = 'Этот вид за месяц уже есть';
      seen.add(pair);
    }
    const amount = parseAmount(draft.amount);
    if ('error' in amount) rowErrors.amount = amount.error;

    if (rowErrors.kind || rowErrors.amount) errors[draft.key] = rowErrors;
    else if (draft.kindId !== null && 'value' in amount) {
      payload.push({ month: draft.month, kind_id: draft.kindId, amount: amount.value });
    }
  }

  return Object.keys(errors).length > 0 ? { payload: null, errors } : { payload, errors: null };
};

/** Первое поле с ошибкой в порядке на экране: строки сверху вниз, в строке — вид, затем сумма. */
export const firstInvalidDeductionField = (
  drafts: readonly IDeductionEntryDraft[],
  errors: DeductionEntriesErrors,
): { key: string; field: DeductionEntryField } | null => {
  for (const draft of drafts) {
    const rowErrors = errors[draft.key];
    if (rowErrors?.kind) return { key: draft.key, field: 'kind' };
    if (rowErrors?.amount) return { key: draft.key, field: 'amount' };
  }
  return null;
};

/** id поля строки: по нему карточка ставит фокус на первую ошибку. */
export const deductionFieldId = (idPrefix: string, key: string, field: DeductionEntryField | 'month'): string => (
  `${idPrefix}-deduction-${key}-${field}`
);

/** Месяцы выбора: окно (от текущего назад) и месяцы строк вне окна — от новых к старым. */
export const deductionMonthOptions = (base: readonly string[], drafts: readonly IDeductionEntryDraft[]): string[] => (
  [...new Set([...base, ...drafts.map(draft => draft.month)])].sort().reverse()
);
