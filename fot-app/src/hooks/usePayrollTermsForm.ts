import { useState } from 'react';

import type {
  ContractType,
  IAssignTermsPayload,
  IPayrollTermsRow,
  PayrollCalcType,
} from '../services/payrollService';
import {
  firstInvalidField,
  initialPayrollTermsValues,
  isPayrollTermsChanged,
  validatePayrollTerms,
  type IPayrollTermsFormValues,
  type PayrollMoneyField,
  type PayrollTermsFieldErrors,
  type PayrollTermsFieldKey,
} from '../utils/payrollTermsForm';

interface IUsePayrollTermsFormArgs {
  /** Строка сотрудника — предзаполнение. */
  row: IPayrollTermsRow;
  defaultDate: string;
}

/**
 * Состояние формы условий оплаты в карточке сотрудника.
 * Проверка и состав запроса — в utils/payrollTermsForm (покрыты тестом); деньги дальше
 * считает сервер. Ошибки хранятся по полям и снимаются при правке своего поля.
 */
export const usePayrollTermsForm = ({ row, defaultDate }: IUsePayrollTermsFormArgs) => {
  // Начальные значения храним: по ним видно, правили ли условия (isChanged).
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

  const setContractType = (next: ContractType) => {
    setValues(prev => ({ ...prev, contractType: next }));
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

  /** Условия правили: иначе «Сохранить» с правкой одного «Оплачено» не создаёт новую версию условий. */
  const isChanged = (): boolean => isPayrollTermsChanged(values, initial);

  return {
    ...values,
    fieldErrors,
    setCalcType,
    setContractType,
    setAmount,
    changeMoney,
    setEffectiveFrom,
    buildPayload,
    isChanged,
  };
};

export type PayrollTermsFormApi = ReturnType<typeof usePayrollTermsForm>;
