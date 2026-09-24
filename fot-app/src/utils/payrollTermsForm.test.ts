import { describe, expect, it } from 'vitest';

import {
  firstInvalidField,
  initialPayrollTermsValues,
  isSamePayrollTermsValues,
  toInputValue,
  validatePayrollTerms,
  type IPayrollTermsFormValues,
} from './payrollTermsForm';
import { defaultCalcTypeFor, type IPayrollTermsRow } from '../services/payrollService';

const EMPTY_MONEY = { bonus: '', housing: '', travel: '', communication: '', deduction: '' };

const values = (over: Partial<IPayrollTermsFormValues> = {}): IPayrollTermsFormValues => ({
  category: 'office',
  calcType: 'salary',
  amount: '175000',
  money: EMPTY_MONEY,
  effectiveFrom: '2026-09-24',
  ...over,
});

/** Тело запроса как его увидит сервер: undefined-поля в JSON не попадают. */
const wire = (payload: unknown) => JSON.parse(JSON.stringify(payload));

const row = (over: Partial<IPayrollTermsRow> = {}): IPayrollTermsRow => ({
  employee_id: 7, full_name: 'Иванов Иван', tab_number: null, department_id: null, department_name: null,
  position_name: null, schedule_name: null, terms_id: 5, staff_category: 'worker', calc_type: 'hourly',
  monthly_salary: null, hourly_rate: '450.0000', bonus_amount: '15000.00', housing_compensation: null,
  travel_compensation: '3000.50', communication_compensation: null, deduction_amount: '0.00',
  staff_units: '1.000', effective_from: '2026-07-01', effective_to: null, can_edit: true,
  ...over,
});

describe('validatePayrollTerms: состав запроса сохранения', () => {
  it('оклад: сумма в monthly_salary, пустые необязательные суммы не передаются', () => {
    const result = validatePayrollTerms(values({ money: { ...EMPTY_MONEY, bonus: '20000' } }));
    expect(result.errors).toBeNull();
    expect(wire(result.payload)).toEqual({
      staff_category: 'office',
      calc_type: 'salary',
      monthly_salary: 175000,
      bonus_amount: 20000,
      effective_from: '2026-09-24',
    });
  });

  it('часы: сумма в hourly_rate, запятая как разделитель, явный 0 уходит нулём', () => {
    const result = validatePayrollTerms(values({
      category: 'worker',
      calcType: 'hourly',
      amount: '450,5',
      money: { bonus: '15000', housing: '12000', travel: '3000', communication: '500', deduction: '0' },
    }));
    expect(wire(result.payload)).toEqual({
      staff_category: 'worker',
      calc_type: 'hourly',
      hourly_rate: 450.5,
      bonus_amount: 15000,
      housing_compensation: 12000,
      travel_compensation: 3000,
      communication_compensation: 500,
      deduction_amount: 0,
      effective_from: '2026-09-24',
    });
  });

  it('ошибки — по полям, все сразу; первая по порядку на экране', () => {
    const result = validatePayrollTerms(values({
      calcType: 'hourly',
      amount: '',
      money: { ...EMPTY_MONEY, travel: '-1', deduction: 'abc' },
      effectiveFrom: '',
    }));
    expect(result.payload).toBeNull();
    expect(result.errors).toEqual({
      amount: 'Укажите часовую ставку',
      travel: 'Введите число не меньше нуля',
      deduction: 'Введите число не меньше нуля',
      effectiveFrom: 'Укажите дату «Действует с»',
    });
    expect(firstInvalidField(result.errors ?? {})).toBe('effectiveFrom');
  });

  it('порядок фокуса — как на экране: премия рядом с окладом, удержание перед проездом', () => {
    expect(firstInvalidField({ travel: 'x', deduction: 'x' })).toBe('deduction');
    expect(firstInvalidField({ housing: 'x', bonus: 'x' })).toBe('bonus');
  });

  it('оклад ноль — ошибка оклада', () => {
    expect(validatePayrollTerms(values({ amount: '0' })).errors).toEqual({ amount: 'Укажите оклад' });
  });
});

describe('initialPayrollTermsValues', () => {
  it('из условий сотрудника: хвост нулей NUMERIC убирается, пустые суммы остаются пустыми', () => {
    expect(initialPayrollTermsValues(row(), '2026-09-24', defaultCalcTypeFor)).toEqual({
      category: 'worker',
      calcType: 'hourly',
      amount: '450',
      money: { bonus: '15000', housing: '', travel: '3000.5', communication: '', deduction: '0' },
      effectiveFrom: '2026-09-24',
    });
  });

  it('без условий: суммы пустые, вид оплаты — по категории', () => {
    const initial = initialPayrollTermsValues(
      row({ terms_id: null, staff_category: null, calc_type: null, hourly_rate: null, bonus_amount: '1.00' }),
      '2026-09-24',
      defaultCalcTypeFor,
    );
    expect(initial).toEqual({
      category: 'worker', calcType: 'hourly', amount: '', money: EMPTY_MONEY, effectiveFrom: '2026-09-24',
    });
  });

  it('массовое назначение: рабочие на часах, всё пусто', () => {
    expect(initialPayrollTermsValues(null, '2026-09-24', defaultCalcTypeFor)).toEqual({
      category: 'worker', calcType: 'hourly', amount: '', money: EMPTY_MONEY, effectiveFrom: '2026-09-24',
    });
  });
});

describe('isSamePayrollTermsValues / toInputValue', () => {
  it('любое отличие — несохранённые изменения', () => {
    const base = values();
    expect(isSamePayrollTermsValues(base, values())).toBe(true);
    expect(isSamePayrollTermsValues(base, values({ calcType: 'hourly' }))).toBe(false);
    expect(isSamePayrollTermsValues(base, values({ money: { ...EMPTY_MONEY, communication: '1' } }))).toBe(false);
    expect(isSamePayrollTermsValues(base, values({ effectiveFrom: '2026-10-01' }))).toBe(false);
  });

  it('целые не трогает, дробные обрезает только по нулям', () => {
    expect(toInputValue('100')).toBe('100');
    expect(toInputValue('0.00')).toBe('0');
    expect(toInputValue('10.50')).toBe('10.5');
    expect(toInputValue(null)).toBe('');
  });
});
