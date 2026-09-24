import type {
  IAssignTermsPayload,
  IPayrollTermsRow,
  PayrollCalcType,
  StaffCategory,
} from '../services/payrollService';

/** Необязательные суммы условий, ₽/мес: премия, компенсации и удержание. */
export type PayrollMoneyField = 'bonus' | 'housing' | 'travel' | 'communication' | 'deduction';

export const PAYROLL_MONEY_FIELDS: readonly PayrollMoneyField[] = ['bonus', 'housing', 'travel', 'communication', 'deduction'];

/** Поля, у которых бывает ошибка проверки, — в порядке на экране (фокус на первую ошибку). */
export type PayrollTermsFieldKey = 'effectiveFrom' | 'amount' | PayrollMoneyField;

export const PAYROLL_TERMS_FIELD_ORDER: readonly PayrollTermsFieldKey[] = [
  'effectiveFrom', 'amount', 'bonus', 'housing', 'deduction', 'travel', 'communication',
];

export type PayrollTermsFieldErrors = Partial<Record<PayrollTermsFieldKey, string>>;

/** Значения формы — строки как в полях ввода. */
export interface IPayrollTermsFormValues {
  category: StaffCategory;
  calcType: PayrollCalcType;
  amount: string;
  money: Record<PayrollMoneyField, string>;
  effectiveFrom: string;
}

/** NUMERIC приходит строкой с хвостом нулей: «450.0000» → «450», «175000.50» → «175000.5». */
export const toInputValue = (value: string | number | null | undefined): string => {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
};

/** Начальные значения: из строки списка одного сотрудника; без условий или массово — пусто. */
export const initialPayrollTermsValues = (
  row: IPayrollTermsRow | null,
  defaultDate: string,
  resolveDefaultCalcType: (category: StaffCategory) => PayrollCalcType,
): IPayrollTermsFormValues => {
  const hasTerms = Boolean(row?.terms_id);
  const pick = (value: string | number | null | undefined) => (hasTerms ? toInputValue(value) : '');
  const category = row?.staff_category ?? 'worker';
  return {
    category,
    calcType: row?.calc_type ?? resolveDefaultCalcType(category),
    amount: hasTerms && row ? pick(row.calc_type === 'salary' ? row.monthly_salary : row.hourly_rate) : '',
    money: {
      bonus: pick(row?.bonus_amount),
      housing: pick(row?.housing_compensation),
      travel: pick(row?.travel_compensation),
      communication: pick(row?.communication_compensation),
      deduction: pick(row?.deduction_amount),
    },
    effectiveFrom: defaultDate,
  };
};

/** Необязательная сумма: пусто → undefined, некорректно или < 0 → null. */
const parseOptionalMoney = (raw: string): number | undefined | null => {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed.replace(',', '.'));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

export type PayrollTermsValidation =
  | { payload: IAssignTermsPayload; errors: null }
  | { payload: null; errors: PayrollTermsFieldErrors };

/**
 * Проверка формы и запрос сохранения. Состав запроса не зависит от раскладки формы:
 * сумма уходит в monthly_salary или hourly_rate по виду оплаты, пустые необязательные суммы
 * не передаются (на сервере — NULL, а не 0).
 */
export const validatePayrollTerms = (values: IPayrollTermsFormValues): PayrollTermsValidation => {
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

  if (!values.effectiveFrom) errors.effectiveFrom = 'Укажите дату «Действует с»';

  if (Object.keys(errors).length > 0) return { payload: null, errors };

  return {
    errors: null,
    payload: {
      staff_category: values.category,
      calc_type: values.calcType,
      monthly_salary: values.calcType === 'salary' ? parsed : undefined,
      hourly_rate: values.calcType === 'hourly' ? parsed : undefined,
      bonus_amount: optional.bonus,
      housing_compensation: optional.housing,
      travel_compensation: optional.travel,
      communication_compensation: optional.communication,
      deduction_amount: optional.deduction,
      effective_from: values.effectiveFrom,
    },
  };
};

/** id поля формы: `${prefix}-amount`, `${prefix}-bonus` и т.д. — по нему ставится фокус на ошибку. */
export const payrollFieldId = (idPrefix: string, key: PayrollTermsFieldKey | 'category'): string => `${idPrefix}-${key}`;

/** Первое поле с ошибкой в порядке на экране. */
export const firstInvalidField = (errors: PayrollTermsFieldErrors): PayrollTermsFieldKey | null => (
  PAYROLL_TERMS_FIELD_ORDER.find(key => errors[key]) ?? null
);
