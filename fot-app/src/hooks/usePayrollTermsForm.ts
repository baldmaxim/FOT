import { useState } from 'react';

import type {
  IAssignTermsPayload,
  IPayrollTermsRow,
  PayrollCalcType,
  StaffCategory,
} from '../services/payrollService';
import {
  firstInvalidField,
  initialPayrollTermsValues,
  validatePayrollTerms,
  type IPayrollTermsFormValues,
  type PayrollMoneyField,
  type PayrollTermsFieldErrors,
  type PayrollTermsFieldKey,
} from '../utils/payrollTermsForm';

interface IUsePayrollTermsFormArgs {
  /** Строка одного сотрудника — предзаполнение; null — массовое назначение. */
  row: IPayrollTermsRow | null;
  defaultDate: string;
  resolveDefaultCalcType: (category: StaffCategory) => PayrollCalcType;
}

/**
 * Состояние формы условий оплаты — общее для карточки сотрудника и массового назначения.
 * Проверка и состав запроса — в utils/payrollTermsForm (покрыты тестом); деньги дальше
 * считает сервер. Ошибки хранятся по полям и снимаются при правке своего поля.
 */
export const usePayrollTermsForm = ({ row, defaultDate, resolveDefaultCalcType }: IUsePayrollTermsFormArgs) => {
  const [values, setValues] = useState<IPayrollTermsFormValues>(
    () => initialPayrollTermsValues(row, defaultDate, resolveDefaultCalcType),
  );
  const [fieldErrors, setFieldErrors] = useState<PayrollTermsFieldErrors>({});

  const clearError = (key: PayrollTermsFieldKey) => {
    setFieldErrors(prev => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  /**
   * Смена категории подставляет вид оплаты по умолчанию (Офис — оклад, стройка — часы),
   * но не запрещает выбрать другой: ИТР на окладе и офисный на часах — рабочие случаи.
   * Введённая сумма при смене вида оплаты сохраняется.
   */
  const changeCategory = (next: StaffCategory) => {
    setValues(prev => ({ ...prev, category: next, calcType: resolveDefaultCalcType(next) }));
  };

  const setCalcType = (next: PayrollCalcType) => {
    setValues(prev => ({ ...prev, calcType: next }));
    clearError('amount');
  };

  const setAmount = (value: string) => {
    setValues(prev => ({ ...prev, amount: value }));
    clearError('amount');
  };

  const changeMoney = (field: PayrollMoneyField, value: string) => {
    setValues(prev => ({ ...prev, money: { ...prev.money, [field]: value } }));
    clearError(field);
  };

  const setEffectiveFrom = (value: string) => {
    setValues(prev => ({ ...prev, effectiveFrom: value }));
    clearError('effectiveFrom');
  };

  /** Проверяет форму: запрос сохранения или первое поле с ошибкой (для фокуса). */
  const buildPayload = (): { payload: IAssignTermsPayload | null; firstInvalid: PayrollTermsFieldKey | null } => {
    const result = validatePayrollTerms(values);
    setFieldErrors(result.errors ?? {});
    return result.payload
      ? { payload: result.payload, firstInvalid: null }
      : { payload: null, firstInvalid: firstInvalidField(result.errors) };
  };

  return {
    ...values,
    fieldErrors,
    changeCategory,
    setCalcType,
    setAmount,
    changeMoney,
    setEffectiveFrom,
    buildPayload,
  };
};

export type PayrollTermsFormApi = ReturnType<typeof usePayrollTermsForm>;
