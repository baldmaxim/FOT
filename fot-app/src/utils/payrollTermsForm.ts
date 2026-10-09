import type {
  IAssignTermsPayload,
  IPayrollTermsRow,
  IPlannedSupplementPayload,
  PayrollCalcType,
} from '../services/payrollService';

/** Необязательные суммы условий, ₽/мес: премия, компенсации и удержание. */
export type PayrollMoneyField = 'bonus' | 'housing' | 'travel' | 'deduction';

export const PAYROLL_MONEY_FIELDS: readonly PayrollMoneyField[] = ['bonus', 'housing', 'travel', 'deduction'];

/** Плановая доплата: сумма ₽/мес, дата начала и дата окончания — строки как в полях ввода. */
export interface IPayrollSupplementValues {
  amount: string;
  from: string;
  to: string;
}

export type PayrollSupplementField = keyof IPayrollSupplementValues;

/** Ключ ошибки и id поля доплаты. */
export const SUPPLEMENT_FIELD_KEYS = {
  amount: 'supplementAmount',
  from: 'supplementFrom',
  to: 'supplementTo',
} as const satisfies Record<PayrollSupplementField, string>;

/** Поля, у которых бывает ошибка проверки, — в порядке на экране (фокус на первую ошибку). */
export type PayrollTermsFieldKey =
  | 'effectiveFrom'
  | 'amount'
  | PayrollMoneyField
  | (typeof SUPPLEMENT_FIELD_KEYS)[PayrollSupplementField];

export const PAYROLL_TERMS_FIELD_ORDER: readonly PayrollTermsFieldKey[] = [
  'effectiveFrom', 'amount', 'bonus', 'housing', 'travel',
  'supplementAmount', 'supplementFrom', 'supplementTo', 'deduction',
];

export type PayrollTermsFieldErrors = Partial<Record<PayrollTermsFieldKey, string>>;

/** Значения формы — строки как в полях ввода. Категории нет: её ставит сервер по отделу. */
export interface IPayrollTermsFormValues {
  calcType: PayrollCalcType;
  amount: string;
  money: Record<PayrollMoneyField, string>;
  supplement: IPayrollSupplementValues;
  effectiveFrom: string;
}

/** NUMERIC приходит строкой с хвостом нулей: «450.0000» → «450», «175000.50» → «175000.5». */
export const toInputValue = (value: string | number | null | undefined): string => {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
};

/**
 * Начальные значения: из строки списка одного сотрудника; без условий или массово — пусто,
 * вид оплаты — «По графику (оклад)». Плановая доплата от условий не зависит: предзаполняется
 * и у сотрудника без условий на дату.
 */
export const initialPayrollTermsValues = (
  row: IPayrollTermsRow | null,
  defaultDate: string,
): IPayrollTermsFormValues => {
  const hasTerms = Boolean(row?.terms_id);
  const pick = (value: string | number | null | undefined) => (hasTerms ? toInputValue(value) : '');
  return {
    calcType: row?.calc_type ?? 'salary',
    amount: hasTerms && row ? pick(row.calc_type === 'salary' ? row.monthly_salary : row.hourly_rate) : '',
    money: {
      bonus: pick(row?.bonus_amount),
      housing: pick(row?.housing_compensation),
      travel: pick(row?.travel_compensation),
      deduction: pick(row?.deduction_amount),
    },
    supplement: {
      amount: toInputValue(row?.planned_supplement_amount),
      from: row?.planned_supplement_from ?? '',
      to: row?.planned_supplement_to ?? '',
    },
    effectiveFrom: defaultDate,
  };
};

const SUPPLEMENT_FIELDS = Object.keys(SUPPLEMENT_FIELD_KEYS) as PayrollSupplementField[];

/** Правили ли условия: хоть одно поле отличается от начального значения. */
export const isPayrollTermsChanged = (values: IPayrollTermsFormValues, initial: IPayrollTermsFormValues): boolean => (
  values.calcType !== initial.calcType
  || values.amount !== initial.amount
  || values.effectiveFrom !== initial.effectiveFrom
  || PAYROLL_MONEY_FIELDS.some(field => values.money[field] !== initial.money[field])
  || SUPPLEMENT_FIELDS.some(field => values.supplement[field] !== initial.supplement[field])
);

/** Необязательная сумма: пусто → undefined, некорректно или < 0 → null. */
const parseOptionalMoney = (raw: string): number | undefined | null => {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed.replace(',', '.'));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const isSupplementEmpty = (values: IPayrollSupplementValues): boolean =>
  !values.amount.trim() && !values.from && !values.to;

/** Доплата из полей; null — поля пустые или заполнены с ошибкой (тогда errors не пуст). */
const parseSupplement = (
  values: IPayrollSupplementValues,
  errors: PayrollTermsFieldErrors,
): IPlannedSupplementPayload | null => {
  if (isSupplementEmpty(values)) return null;
  const rawAmount = values.amount.trim();
  const amount = Number(rawAmount.replace(',', '.'));
  if (!rawAmount) errors.supplementAmount = 'Укажите сумму доплаты';
  else if (!Number.isFinite(amount) || amount <= 0) errors.supplementAmount = 'Введите число больше нуля';
  if (!values.from) errors.supplementFrom = 'Укажите дату начала';
  if (!values.to) errors.supplementTo = 'Укажите дату окончания';
  else if (values.from && values.to < values.from) errors.supplementTo = 'Дата окончания раньше даты начала';
  if (errors.supplementAmount || errors.supplementFrom || errors.supplementTo) return null;
  return { amount, date_from: values.from, date_to: values.to };
};

const sameSupplement = (a: IPlannedSupplementPayload | null, b: IPlannedSupplementPayload | null): boolean => (
  a === null || b === null
    ? a === b
    : a.amount === b.amount && a.date_from === b.date_from && a.date_to === b.date_to
);

export interface IPayrollTermsValidateOptions {
  /**
   * Плановая доплата в форме (карточка одного сотрудника): начальные значения полей.
   * Не передано — секции нет, доплата в запрос не входит (массовое назначение).
   */
  initialSupplement?: IPayrollSupplementValues;
}

export type PayrollTermsValidation =
  | { payload: IAssignTermsPayload; errors: null }
  | { payload: null; errors: PayrollTermsFieldErrors };

/**
 * Проверка формы и запрос сохранения. Состав запроса не зависит от раскладки формы:
 * сумма уходит в monthly_salary или hourly_rate по виду оплаты, пустые необязательные суммы
 * не передаются (на сервере — NULL, а не 0).
 *
 * Плановая доплата уходит, только если её поменяли: равна начальной — не передаётся (чужая правка,
 * сделанная пока карточка открыта, не затрётся), очищена — null (снять), иначе — новая доплата.
 */
export const validatePayrollTerms = (
  values: IPayrollTermsFormValues,
  options: IPayrollTermsValidateOptions = {},
): PayrollTermsValidation => {
  const errors: PayrollTermsFieldErrors = {};

  const parsed = Number(values.amount.replace(',', '.'));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    errors.amount = values.calcType === 'salary' ? 'Укажите оклад' : 'Укажите часовую ставку';
  }

  const optional: Partial<Record<PayrollMoneyField, number>> = {};
  for (const field of PAYROLL_MONEY_FIELDS) {
    const value = parseOptionalMoney(values.money[field]);
    if (value === null) errors[field] = 'Введите число не меньше нуля';
    else if (value !== undefined) optional[field] = value;
  }

  let plannedSupplement: IPlannedSupplementPayload | null | undefined;
  if (options.initialSupplement) {
    const next = parseSupplement(values.supplement, errors);
    // Начальные значения пришли с сервера; если вдруг неполные — считаем, что доплаты не было.
    const initial = parseSupplement(options.initialSupplement, {});
    plannedSupplement = sameSupplement(next, initial) ? undefined : next;
  }

  if (!values.effectiveFrom) errors.effectiveFrom = 'Укажите дату «Действует с»';

  if (Object.keys(errors).length > 0) return { payload: null, errors };

  return {
    errors: null,
    payload: {
      calc_type: values.calcType,
      monthly_salary: values.calcType === 'salary' ? parsed : undefined,
      hourly_rate: values.calcType === 'hourly' ? parsed : undefined,
      bonus_amount: optional.bonus,
      housing_compensation: optional.housing,
      travel_compensation: optional.travel,
      deduction_amount: optional.deduction,
      effective_from: values.effectiveFrom,
      planned_supplement: plannedSupplement,
    },
  };
};

/** id поля формы: `${prefix}-amount`, `${prefix}-bonus` и т.д. — по нему ставится фокус на ошибку. */
export const payrollFieldId = (idPrefix: string, key: PayrollTermsFieldKey | 'category'): string => `${idPrefix}-${key}`;

/** Первое поле с ошибкой в порядке на экране. */
export const firstInvalidField = (errors: PayrollTermsFieldErrors): PayrollTermsFieldKey | null => (
  PAYROLL_TERMS_FIELD_ORDER.find(key => errors[key]) ?? null
);
