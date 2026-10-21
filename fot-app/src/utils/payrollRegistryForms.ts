/**
 * Формы таблиц окна «Справочник» на «Расчётах» («Доплата за проживание», «Доплата за общежитие», «Доплата», «Без проезда»,
 * «Удержания»):
 * разбор полей повторяет проверку сервера — ошибка видна до запроса, а не ответом 400.
 */
import type {
  IDeductionRegistryPayload,
  IHousingAllowancePayload,
  IOneTimeSupplementFields,
  IPlannedSupplementFields,
  IRegistryPeriodFields,
} from '../services/payrollRegistryService';
import { isCalendarDate } from './dormitoryStayForm';
import { shiftMonth } from './moscowDate';
import { parseRateAmount } from './payrollDictionary';

export type RegistryFormField = 'employee' | 'kinds' | 'amount' | 'date_from' | 'date_to' | 'month' | 'reason';

export type RegistryFormParse<T> =
  | { ok: true; payload: T }
  | { ok: false; field: RegistryFormField; message: string };

const fail = (field: RegistryFormField, message: string) => ({ ok: false as const, field, message });

export const SUPPLEMENT_REASON_MAX_LENGTH = 200;

/** Месяцев в выборе месяца разовой доплаты: следующий, текущий и 11 прошлых. */
const ONE_TIME_MONTHS_BACK = 11;

export const oneTimeMonthOptions = (currentMonth: string): string[] => (
  Array.from({ length: ONE_TIME_MONTHS_BACK + 2 }, (_, index) => shiftMonth(currentMonth, 1 - index))
);

/** Сумма больше нуля: «1 250,5» → 1250.5. Та же проверка — у «Удержаний» кадров (staffDeductionForm.ts). */
export const parsePositiveAmount = (raw: string): { amount: number } | { error: string } => {
  const parsed = parseRateAmount(raw);
  if (parsed.error !== null) return { error: 'Сумма — число больше нуля, до двух знаков после запятой' };
  if (parsed.amount === null) return { error: 'Укажите сумму' };
  if (parsed.amount <= 0) return { error: 'Сумма должна быть больше нуля' };
  return { amount: parsed.amount };
};

const parseDate = (value: string, field: RegistryFormField, emptyMessage: string) => {
  if (!value) return fail(field, emptyMessage);
  if (!isCalendarDate(value)) return fail(field, 'Такой даты нет');
  return null;
};

/** «Доплата за проживание»: сотрудник с окладом, сумма, «Действует с». */
export const parseHousingForm = (draft: {
  selected: boolean;
  hasTerms: boolean;
  amount: string;
  effectiveFrom: string;
}): RegistryFormParse<IHousingAllowancePayload> => {
  if (!draft.selected) return fail('employee', 'Выберите сотрудника');
  if (!draft.hasTerms) return fail('employee', 'Сначала внесите оклад в окне сотрудника');
  const amount = parsePositiveAmount(draft.amount);
  if ('error' in amount) return fail('amount', amount.error);
  const dateError = parseDate(draft.effectiveFrom, 'date_from', 'Укажите дату «Действует с»');
  if (dateError) return dateError;
  return { ok: true, payload: { amount: amount.amount, effective_from: draft.effectiveFrom } };
};

/** Плановая доплата: сумма ₽/мес, «с — по» включительно. */
export const parsePlannedForm = (draft: {
  selected: boolean;
  amount: string;
  dateFrom: string;
  dateTo: string;
}): RegistryFormParse<IPlannedSupplementFields> => {
  if (!draft.selected) return fail('employee', 'Выберите сотрудника');
  const amount = parsePositiveAmount(draft.amount);
  if ('error' in amount) return fail('amount', amount.error);
  const fromError = parseDate(draft.dateFrom, 'date_from', 'Укажите дату начала');
  if (fromError) return fromError;
  const toError = parseDate(draft.dateTo, 'date_to', 'Укажите дату окончания');
  if (toError) return toError;
  if (draft.dateTo < draft.dateFrom) return fail('date_to', 'Дата окончания раньше даты начала');
  return { ok: true, payload: { amount: amount.amount, date_from: draft.dateFrom, date_to: draft.dateTo } };
};

/** Разовая доплата: месяц, сумма, основание (обязательно). */
export const parseOneTimeForm = (draft: {
  selected: boolean;
  month: string;
  amount: string;
  reason: string;
}): RegistryFormParse<IOneTimeSupplementFields> => {
  if (!draft.selected) return fail('employee', 'Выберите сотрудника');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(draft.month)) return fail('month', 'Укажите месяц');
  const amount = parsePositiveAmount(draft.amount);
  if ('error' in amount) return fail('amount', amount.error);
  const reason = draft.reason.replace(/\s+/g, ' ').trim();
  if (!reason) return fail('reason', 'Укажите основание');
  if (reason.length > SUPPLEMENT_REASON_MAX_LENGTH) return fail('reason', 'Основание — не больше 200 символов');
  return { ok: true, payload: { month: draft.month, amount: amount.amount, reason } };
};

/**
 * Период «с — по» («Без проезда», «Доплата за общежитие»): с — обязательно, по — включительно, пусто — бессрочно.
 * fromLabel — подпись даты начала в сообщении: «Без проезда с», «Доплата с».
 */
export const parsePeriodForm = (draft: {
  selected: boolean;
  dateFrom: string;
  dateTo: string;
  fromLabel: string;
}): RegistryFormParse<IRegistryPeriodFields> => {
  if (!draft.selected) return fail('employee', 'Выберите сотрудника');
  const fromError = parseDate(draft.dateFrom, 'date_from', `Укажите дату «${draft.fromLabel}»`);
  if (fromError) return fromError;
  if (draft.dateTo && !isCalendarDate(draft.dateTo)) return fail('date_to', 'Такой даты нет');
  if (draft.dateTo && draft.dateTo < draft.dateFrom) return fail('date_to', 'Дата «по» раньше даты «с»');
  return { ok: true, payload: { date_from: draft.dateFrom, date_to: draft.dateTo || null } };
};

/**
 * «Удержания»: виды и/или сумма ₽/мес с даты «Действует с». При добавлении нужен вид или сумма; при правке
 * пусто в обоих — снять. Сумма без оклада — нельзя (hasTerms — подсказка на сегодня, решает сервер).
 */
export const parseDeductionForm = (draft: {
  selected: boolean;
  isEdit: boolean;
  hasTerms: boolean;
  kindIds: ReadonlyArray<number>;
  amount: string;
  effectiveFrom: string;
}): RegistryFormParse<IDeductionRegistryPayload> => {
  if (!draft.selected) return fail('employee', 'Выберите сотрудника');
  const amountText = draft.amount.trim();
  let amount: number | null = null;
  if (amountText) {
    const parsed = parsePositiveAmount(amountText);
    if ('error' in parsed) return fail('amount', parsed.error);
    amount = parsed.amount;
  }
  if (!draft.isEdit && draft.kindIds.length === 0 && amount === null) return fail('kinds', 'Выберите вид удержания или укажите сумму');
  if (amount !== null && !draft.hasTerms) return fail('amount', 'Сначала внесите оклад в окне сотрудника');
  const dateError = parseDate(draft.effectiveFrom, 'date_from', 'Укажите дату «Действует с»');
  if (dateError) return dateError;
  return {
    ok: true,
    payload: { kind_ids: [...new Set(draft.kindIds)], amount, effective_from: draft.effectiveFrom },
  };
};
