import { useState } from 'react';

import type {
  IAssignTermsPayload,
  IPayrollTermsRow,
  PayrollCalcType,
  StaffCategory,
} from '../services/payrollService';

/** Необязательные суммы условий, ₽/мес: премия, компенсации и удержание. */
export type PayrollMoneyField = 'bonus' | 'housing' | 'travel' | 'communication' | 'deduction';

export const PAYROLL_MONEY_FIELDS: readonly PayrollMoneyField[] = ['bonus', 'housing', 'travel', 'communication', 'deduction'];

/** NUMERIC приходит строкой с хвостом нулей: «450.0000» → «450», «175000.50» → «175000.5». */
const toInputValue = (value: string | number | null | undefined): string => {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
};

/** Необязательная сумма: пусто → undefined, некорректно или < 0 → null. */
const parseOptionalMoney = (raw: string): number | undefined | null => {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed.replace(',', '.'));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

/** Значения строки списка по полям формы; без условий — пусто. */
const initialMoney = (row: IPayrollTermsRow | null): Record<PayrollMoneyField, string> => {
  const hasTerms = Boolean(row?.terms_id);
  const pick = (value: string | number | null | undefined) => (hasTerms ? toInputValue(value) : '');
  return {
    bonus: pick(row?.bonus_amount),
    housing: pick(row?.housing_compensation),
    travel: pick(row?.travel_compensation),
    communication: pick(row?.communication_compensation),
    deduction: pick(row?.deduction_amount),
  };
};

interface IUsePayrollTermsFormArgs {
  /** Строка одного сотрудника — предзаполнение; null — массовое назначение. */
  row: IPayrollTermsRow | null;
  defaultDate: string;
  resolveDefaultCalcType: (category: StaffCategory) => PayrollCalcType;
}

/**
 * Состояние и проверка формы условий оплаты — общие для карточки сотрудника
 * и массового назначения. Суммы уходят числами; деньги дальше считает сервер.
 */
export const usePayrollTermsForm = ({ row, defaultDate, resolveDefaultCalcType }: IUsePayrollTermsFormArgs) => {
  const [category, setCategory] = useState<StaffCategory>(row?.staff_category ?? 'worker');
  const [calcType, setCalcType] = useState<PayrollCalcType>(
    row?.calc_type ?? resolveDefaultCalcType(row?.staff_category ?? 'worker'),
  );
  const [amount, setAmount] = useState<string>(() => {
    if (!row?.terms_id) return '';
    return toInputValue(row.calc_type === 'salary' ? row.monthly_salary : row.hourly_rate);
  });
  const [money, setMoney] = useState<Record<PayrollMoneyField, string>>(() => initialMoney(row));
  const [effectiveFrom, setEffectiveFrom] = useState(defaultDate);
  const [error, setError] = useState<string | null>(null);

  /**
   * Смена категории подставляет вид оплаты по умолчанию (Офис — оклад, стройка — часы),
   * но не запрещает выбрать другой: ИТР на окладе и офисный на часах — рабочие случаи.
   */
  const changeCategory = (next: StaffCategory) => {
    setCategory(next);
    setCalcType(resolveDefaultCalcType(next));
  };

  const changeMoney = (field: PayrollMoneyField, value: string) => {
    setMoney(prev => ({ ...prev, [field]: value }));
  };

  /** Проверяет форму. Ошибку показывает сама и возвращает null. */
  const buildPayload = (): IAssignTermsPayload | null => {
    const parsed = Number(amount.replace(',', '.'));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError(calcType === 'salary' ? 'Укажите оклад' : 'Укажите часовую ставку');
      return null;
    }
    const optional: Partial<Record<PayrollMoneyField, number>> = {};
    for (const field of PAYROLL_MONEY_FIELDS) {
      const value = parseOptionalMoney(money[field]);
      if (value === null) {
        setError('Премия, компенсации и удержание — число не меньше нуля');
        return null;
      }
      if (value !== undefined) optional[field] = value;
    }
    if (!effectiveFrom) {
      setError('Укажите дату «Действует с»');
      return null;
    }
    setError(null);
    return {
      staff_category: category,
      calc_type: calcType,
      monthly_salary: calcType === 'salary' ? parsed : undefined,
      hourly_rate: calcType === 'hourly' ? parsed : undefined,
      bonus_amount: optional.bonus,
      housing_compensation: optional.housing,
      travel_compensation: optional.travel,
      communication_compensation: optional.communication,
      deduction_amount: optional.deduction,
      effective_from: effectiveFrom,
    };
  };

  return {
    category,
    calcType,
    amount,
    money,
    effectiveFrom,
    error,
    changeCategory,
    setCalcType,
    setAmount,
    changeMoney,
    setEffectiveFrom,
    buildPayload,
  };
};

export type PayrollTermsFormApi = ReturnType<typeof usePayrollTermsForm>;
