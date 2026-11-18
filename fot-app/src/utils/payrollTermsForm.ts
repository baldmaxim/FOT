import type {
  ContractType,
  IAssignTermsPayload,
  IPayrollTermsRow,
  PayrollCalcType,
  StaffCategory,
} from '../services/payrollService';
import { parseRateAmount } from './payrollFormat';

/**
 * Необязательные суммы условий, ₽/мес: премия и проживание (только показ). Удержания с миграции 321 — не условия:
 * их вносят в «Справочнике» и у кадров, окно сотрудника только показывает. Проезд с миграции 324 — ставка
 * «Справочника», не значение формы (travelAllowance).
 */
export type PayrollMoneyField = 'bonus' | 'housing';

export const PAYROLL_MONEY_FIELDS: readonly PayrollMoneyField[] = ['bonus', 'housing'];

/**
 * Поля, у которых бывает ошибка проверки, — в порядке на экране (фокус на первую ошибку). Плановые доплаты с миграции
 * 369 в форме не правятся (их может быть несколько): окно сотрудника показывает их списком, правят в «Справочнике».
 */
export type PayrollTermsFieldKey =
  | 'effectiveFrom'
  | 'amount'
  | PayrollMoneyField;

export const PAYROLL_TERMS_FIELD_ORDER: readonly PayrollTermsFieldKey[] = ['effectiveFrom', 'amount', 'bonus', 'housing'];

export type PayrollTermsFieldErrors = Partial<Record<PayrollTermsFieldKey, string>>;

/** Значения формы — строки как в полях ввода. */
export interface IPayrollTermsFormValues {
  calcType: PayrollCalcType;
  amount: string;
  /** Тип договора (миграция 352). */
  contractType: ContractType;
  money: Record<PayrollMoneyField, string>;
  effectiveFrom: string;
}

/** NUMERIC приходит строкой с хвостом нулей: «450.0000» → «450», «175000.50» → «175000.5». */
export const toInputValue = (value: string | number | null | undefined): string => {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
};

/** Категория сотрудника — по табелю, её ставит сервер; не выбирается. */
export const payrollRowCategory = (row: IPayrollTermsRow): StaffCategory => row.category ?? 'office';

/**
 * Начальные значения: из строки списка сотрудника; без условий — пусто,
 * вид оплаты — «По графику (оклад)».
 */
export const initialPayrollTermsValues = (
  row: IPayrollTermsRow,
  defaultDate: string,
): IPayrollTermsFormValues => {
  const hasTerms = Boolean(row.terms_id);
  const pick = (value: string | number | null | undefined) => (hasTerms ? toInputValue(value) : '');
  return {
    calcType: row.calc_type ?? 'salary',
    amount: hasTerms ? pick(row.calc_type === 'salary' ? row.monthly_salary : row.hourly_rate) : '',
    contractType: (hasTerms && row.contract_type) || 'labor',
    money: {
      bonus: pick(row.bonus_amount),
      // Проживание — квартира «Проживания» на дату (миграция 320), не условия: есть и без оклада, только показ.
      housing: toInputValue(row.housing_compensation),
    },
    effectiveFrom: defaultDate,
  };
};

/** Правили ли условия: хоть одно поле отличается от начального значения. */
export const isPayrollTermsChanged = (values: IPayrollTermsFormValues, initial: IPayrollTermsFormValues): boolean => (
  values.calcType !== initial.calcType
  || values.amount !== initial.amount
  || values.contractType !== initial.contractType
  || values.effectiveFrom !== initial.effectiveFrom
  || PAYROLL_MONEY_FIELDS.some(field => values.money[field] !== initial.money[field])
);

/**
 * Текст ошибки поля суммы: число, но с лишним знаком после запятой или слишком большое, — текст разбора
 * («до двух знаков после запятой»); буквы, минус — прежняя подсказка поля.
 */
const amountError = (raw: string, parseError: string, fallback: string): string => {
  const num = Number(raw.replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(num) && num > 0 ? parseError : fallback;
};

/** Необязательная сумма: пусто → undefined, иначе число или текст ошибки (третий знак, буквы, < 0). */
const parseOptionalMoney = (raw: string): { value: number } | { error: string } | undefined => {
  const parsed = parseRateAmount(raw);
  if (parsed.error !== null) return { error: amountError(raw, parsed.error, 'Введите число не меньше нуля') };
  return parsed.amount === null ? undefined : { value: parsed.amount };
};

export type PayrollTermsValidation =
  | { payload: IAssignTermsPayload; errors: null }
  | { payload: null; errors: PayrollTermsFieldErrors };

/**
 * Проверка формы и запрос сохранения. Состав запроса не зависит от раскладки формы:
 * сумма уходит в monthly_salary или hourly_rate по виду оплаты, пустые необязательные суммы
 * не передаются (на сервере — NULL, а не 0). Плановой доплаты в запросе нет (миграция 369).
 */
export const validatePayrollTerms = (values: IPayrollTermsFormValues): PayrollTermsValidation => {
  const errors: PayrollTermsFieldErrors = {};

  // Ставка хранится с 4 знаками (NUMERIC(12,4)), оклад — с копейками.
  const amountParse = parseRateAmount(values.amount, values.calcType === 'hourly' ? 4 : 2);
  const parsed = amountParse.amount ?? 0;
  const amountRequired = values.calcType === 'salary' ? 'Укажите оклад' : 'Укажите часовую ставку';
  if (amountParse.error !== null) errors.amount = amountError(values.amount, amountParse.error, amountRequired);
  else if (parsed <= 0) errors.amount = amountRequired;

  const optional: Partial<Record<PayrollMoneyField, number>> = {};
  for (const field of PAYROLL_MONEY_FIELDS) {
    // У почасовой поля премии нет: значение от прежнего вида оплаты не проверяем и не отправляем.
    if (field === 'bonus' && values.calcType === 'hourly') continue;
    const result = parseOptionalMoney(values.money[field]);
    if (result === undefined) continue;
    if ('error' in result) errors[field] = result.error;
    else optional[field] = result.value;
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
      contract_type: values.contractType,
      effective_from: values.effectiveFrom,
    },
  };
};

/**
 * «Итого» рядом с окладом и премией: их сумма, ₽/мес. Только у оклада (ставка — за час, премия — за месяц);
 * пусто в обоих полях или ошибка в любом (буквы, третий знак после запятой) — null («—»): не показываем
 * округлённую сумму, которую сохранить нельзя. Пустое поле — 0, сумма в копейках без ошибки float.
 */
export const payrollTermsTotal = (values: Pick<IPayrollTermsFormValues, 'calcType' | 'amount' | 'money'>): number | null => {
  if (values.calcType !== 'salary') return null;
  const parts = [values.amount, values.money.bonus].map(raw => parseRateAmount(raw));
  if (parts.some(part => part.error !== null) || parts.every(part => part.amount === null)) return null;
  const cents = parts.reduce((sum, part) => sum + Math.round((part.amount ?? 0) * 100), 0);
  return cents / 100;
};

/** id поля формы: `${prefix}-amount`, `${prefix}-bonus` и т.д. — по нему ставится фокус на ошибку. */
export const payrollFieldId = (idPrefix: string, key: PayrollTermsFieldKey | 'category'): string => `${idPrefix}-${key}`;

/** Первое поле с ошибкой в порядке на экране. */
export const firstInvalidField = (errors: PayrollTermsFieldErrors): PayrollTermsFieldKey | null => (
  PAYROLL_TERMS_FIELD_ORDER.find(key => errors[key]) ?? null
);
