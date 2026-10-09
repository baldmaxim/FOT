import { useState } from 'react';

import type {
  IAssignTermsPayload,
  IPayrollTermsRow,
  PayrollCalcType,
} from '../services/payrollService';
import {
  firstInvalidField,
  initialPayrollTermsValues,
  isPayrollTermsChanged,
  SUPPLEMENT_FIELD_KEYS,
  validatePayrollTerms,
  type IPayrollTermsFormValues,
  type PayrollMoneyField,
  type PayrollSupplementField,
  type PayrollTermsFieldErrors,
  type PayrollTermsFieldKey,
} from '../utils/payrollTermsForm';

interface IUsePayrollTermsFormArgs {
  /** Строка одного сотрудника — предзаполнение; null — массовое назначение. */
  row: IPayrollTermsRow | null;
  defaultDate: string;
  /** Секция «Плановые доплаты» — только в карточке одного сотрудника. */
  plannedSupplement?: boolean;
}

/**
 * Состояние формы условий оплаты — общее для карточки сотрудника и массового назначения.
 * Проверка и состав запроса — в utils/payrollTermsForm (покрыты тестом); деньги дальше
 * считает сервер. Ошибки хранятся по полям и снимаются при правке своего поля.
 */
export const usePayrollTermsForm = ({
  row,
  defaultDate,
  plannedSupplement = false,
}: IUsePayrollTermsFormArgs) => {
  // Начальные значения храним: доплата уходит в запрос, только если отличается от них.
  const [initial] = useState<IPayrollTermsFormValues>(() => initialPayrollTermsValues(row, defaultDate));
  const [values, setValues] = useState<IPayrollTermsFormValues>(initial);
  const [fieldErrors, setFieldErrors] = useState<PayrollTermsFieldErrors>({});

  const clearError = (key: PayrollTermsFieldKey) => {
    setFieldErrors(prev => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  /** Введённая сумма при смене вида оплаты сохраняется. */
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

  const changeSupplement = (field: PayrollSupplementField, value: string) => {
    setValues(prev => ({ ...prev, supplement: { ...prev.supplement, [field]: value } }));
    clearError(SUPPLEMENT_FIELD_KEYS[field]);
  };

  const setEffectiveFrom = (value: string) => {
    setValues(prev => ({ ...prev, effectiveFrom: value }));
    clearError('effectiveFrom');
  };

  /** Проверяет форму: запрос сохранения или первое поле с ошибкой (для фокуса). */
  const buildPayload = (): { payload: IAssignTermsPayload | null; firstInvalid: PayrollTermsFieldKey | null } => {
    const result = validatePayrollTerms(
      values,
      plannedSupplement ? { initialSupplement: initial.supplement } : {},
    );
    setFieldErrors(result.errors ?? {});
    return result.payload
      ? { payload: result.payload, firstInvalid: null }
      : { payload: null, firstInvalid: firstInvalidField(result.errors) };
  };

  /** Условия правили: иначе «Сохранить» с правкой одного «Оплачено» не создаёт новую версию условий. */
  const isChanged = (): boolean => isPayrollTermsChanged(values, initial);

  return {
    ...values,
    plannedSupplement,
    fieldErrors,
    setCalcType,
    setAmount,
    changeMoney,
    changeSupplement,
    setEffectiveFrom,
    buildPayload,
    isChanged,
  };
};

export type PayrollTermsFormApi = ReturnType<typeof usePayrollTermsForm>;
