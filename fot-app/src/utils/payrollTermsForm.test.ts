import { describe, expect, it } from 'vitest';

import {
  firstInvalidField,
  initialPayrollTermsValues,
  isPayrollTermsChanged,
  toInputValue,
  validatePayrollTerms,
  type IPayrollTermsFormValues,
} from './payrollTermsForm';
import type { IPayrollTermsRow } from '../services/payrollService';

const EMPTY_MONEY = { bonus: '', housing: '', travel: '' };
const EMPTY_SUPPLEMENT = { amount: '', from: '', to: '' };
const NOV_DEC = { amount: '10000', from: '2026-11-01', to: '2026-12-31' };

const values = (over: Partial<IPayrollTermsFormValues> = {}): IPayrollTermsFormValues => ({
  calcType: 'salary',
  amount: '175000',
  money: EMPTY_MONEY,
  supplement: EMPTY_SUPPLEMENT,
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
  it('оклад: сумма в monthly_salary, пустые необязательные суммы не передаются, категорию ставит сервер', () => {
    const result = validatePayrollTerms(values({ money: { ...EMPTY_MONEY, bonus: '20000' } }));
    expect(result.errors).toBeNull();
    expect(wire(result.payload)).toEqual({
      calc_type: 'salary',
      monthly_salary: 175000,
      bonus_amount: 20000,
      effective_from: '2026-09-24',
    });
  });

  it('часы: сумма в hourly_rate, запятая как разделитель, явный 0 уходит нулём', () => {
    const result = validatePayrollTerms(values({
      calcType: 'hourly',
      amount: '450,5',
      money: { bonus: '15000', housing: '12000', travel: '0' },
    }));
    expect(wire(result.payload)).toEqual({
      calc_type: 'hourly',
      hourly_rate: 450.5,
      bonus_amount: 15000,
      housing_compensation: 12000,
      travel_compensation: 0,
      effective_from: '2026-09-24',
    });
  });

  it('ошибки — по полям, все сразу; первая по порядку на экране', () => {
    const result = validatePayrollTerms(values({
      calcType: 'hourly',
      amount: '',
      money: { ...EMPTY_MONEY, travel: '-1', housing: 'abc' },
      effectiveFrom: '',
    }));
    expect(result.payload).toBeNull();
    expect(result.errors).toEqual({
      amount: 'Укажите часовую ставку',
      housing: 'Введите число не меньше нуля',
      travel: 'Введите число не меньше нуля',
      effectiveFrom: 'Укажите дату «Действует с»',
    });
    expect(firstInvalidField(result.errors ?? {})).toBe('effectiveFrom');
  });

  it('порядок фокуса — как на экране: премия рядом с окладом, доплата после компенсаций', () => {
    expect(firstInvalidField({ travel: 'x', housing: 'x' })).toBe('housing');
    expect(firstInvalidField({ housing: 'x', bonus: 'x' })).toBe('bonus');
    expect(firstInvalidField({ supplementTo: 'x', travel: 'x' })).toBe('travel');
    expect(firstInvalidField({ supplementTo: 'x', supplementAmount: 'x' })).toBe('supplementAmount');
  });

  it('оклад ноль — ошибка оклада', () => {
    expect(validatePayrollTerms(values({ amount: '0' })).errors).toEqual({ amount: 'Укажите оклад' });
  });
});

describe('validatePayrollTerms: плановая доплата', () => {
  const withSupplement = (initial = EMPTY_SUPPLEMENT) => ({ initialSupplement: initial });

  it('без опции (массовое назначение) доплата в запрос не входит, даже если поля заполнены', () => {
    const result = validatePayrollTerms(values({ supplement: NOV_DEC }));
    expect(result.errors).toBeNull();
    expect(wire(result.payload)).not.toHaveProperty('planned_supplement');
  });

  it('новая доплата: сумма числом (запятая — разделитель), даты как есть', () => {
    const result = validatePayrollTerms(values({ supplement: { ...NOV_DEC, amount: '10000,5' } }), withSupplement());
    expect(result.payload?.planned_supplement).toEqual({ amount: 10000.5, date_from: '2026-11-01', date_to: '2026-12-31' });
  });

  it('не меняли — не передаётся: чужая правка, сделанная пока карточка открыта, не затрётся', () => {
    const unchanged = validatePayrollTerms(values({ supplement: NOV_DEC }), withSupplement(NOV_DEC));
    expect(unchanged.errors).toBeNull();
    expect(wire(unchanged.payload)).not.toHaveProperty('planned_supplement');
    // Та же сумма в другой записи — тоже без изменений.
    const sameAmount = validatePayrollTerms(
      values({ supplement: { ...NOV_DEC, amount: '10000,00' } }),
      withSupplement(NOV_DEC),
    );
    expect(wire(sameAmount.payload)).not.toHaveProperty('planned_supplement');
    // Пусто было и пусто осталось.
    expect(wire(validatePayrollTerms(values(), withSupplement()).payload)).not.toHaveProperty('planned_supplement');
  });

  it('очистили все поля — null: доплата снимается', () => {
    const result = validatePayrollTerms(values({ supplement: EMPTY_SUPPLEMENT }), withSupplement(NOV_DEC));
    expect(result.errors).toBeNull();
    expect(wire(result.payload)).toHaveProperty('planned_supplement', null);
  });

  it('изменили сумму или период — новая доплата', () => {
    const result = validatePayrollTerms(
      values({ supplement: { ...NOV_DEC, to: '2027-01-31' } }),
      withSupplement(NOV_DEC),
    );
    expect(result.payload?.planned_supplement).toEqual({ amount: 10000, date_from: '2026-11-01', date_to: '2027-01-31' });
  });

  it('заполнено частично — ошибки по полям, запроса нет', () => {
    expect(validatePayrollTerms(values({ supplement: { ...EMPTY_SUPPLEMENT, amount: '5000' } }), withSupplement()).errors)
      .toEqual({ supplementFrom: 'Укажите дату начала', supplementTo: 'Укажите дату окончания' });
    expect(validatePayrollTerms(values({ supplement: { ...NOV_DEC, amount: '' } }), withSupplement()).errors)
      .toEqual({ supplementAmount: 'Укажите сумму доплаты' });
    expect(validatePayrollTerms(values({ supplement: { ...NOV_DEC, amount: '0' } }), withSupplement()).errors)
      .toEqual({ supplementAmount: 'Введите число больше нуля' });
    expect(validatePayrollTerms(values({ supplement: { ...NOV_DEC, amount: 'abc' } }), withSupplement()).errors)
      .toEqual({ supplementAmount: 'Введите число больше нуля' });
  });

  it('окончание раньше начала — ошибка у даты окончания', () => {
    const result = validatePayrollTerms(
      values({ supplement: { ...NOV_DEC, from: '2026-12-01', to: '2026-11-30' } }),
      withSupplement(),
    );
    expect(result.payload).toBeNull();
    expect(result.errors).toEqual({ supplementTo: 'Дата окончания раньше даты начала' });
  });

  it('ошибка доплаты не прячет ошибки условий: фокус на первое поле по порядку', () => {
    const result = validatePayrollTerms(
      values({ amount: '', supplement: { ...EMPTY_SUPPLEMENT, amount: '5000' } }),
      withSupplement(),
    );
    expect(result.errors).toMatchObject({ amount: 'Укажите оклад', supplementFrom: 'Укажите дату начала' });
    expect(firstInvalidField(result.errors ?? {})).toBe('amount');
  });
});

describe('initialPayrollTermsValues', () => {
  it('из условий сотрудника: хвост нулей NUMERIC убирается, пустые суммы остаются пустыми', () => {
    expect(initialPayrollTermsValues(row(), '2026-09-24')).toEqual({
      calcType: 'hourly',
      amount: '450',
      money: { bonus: '15000', housing: '', travel: '3000.5' },
      supplement: EMPTY_SUPPLEMENT,
      effectiveFrom: '2026-09-24',
    });
  });

  it('плановая доплата — последняя сохранённая, хвост нулей убирается', () => {
    const initial = initialPayrollTermsValues(
      row({ planned_supplement_amount: '10000.00', planned_supplement_from: '2026-11-01', planned_supplement_to: '2026-12-31' }),
      '2026-09-24',
    );
    expect(initial.supplement).toEqual(NOV_DEC);
  });

  it('доплата предзаполняется и без условий на дату: она от условий не зависит', () => {
    const initial = initialPayrollTermsValues(
      row({
        terms_id: null, staff_category: null, calc_type: null, hourly_rate: null,
        planned_supplement_amount: 10000, planned_supplement_from: '2026-11-01', planned_supplement_to: '2026-12-31',
      }),
      '2026-09-24',
    );
    expect(initial.amount).toBe('');
    expect(initial.supplement).toEqual(NOV_DEC);
  });

  it('без условий: суммы пустые, вид оплаты — по графику (оклад), и у рабочих тоже', () => {
    const initial = initialPayrollTermsValues(
      row({ terms_id: null, staff_category: null, calc_type: null, hourly_rate: null, bonus_amount: '1.00' }),
      '2026-09-24',
    );
    expect(initial).toEqual({
      calcType: 'salary', amount: '', money: EMPTY_MONEY, supplement: EMPTY_SUPPLEMENT,
      effectiveFrom: '2026-09-24',
    });
  });

  it('массовое назначение: по графику (оклад), всё пусто', () => {
    expect(initialPayrollTermsValues(null, '2026-09-24')).toEqual({
      calcType: 'salary', amount: '', money: EMPTY_MONEY, supplement: EMPTY_SUPPLEMENT,
      effectiveFrom: '2026-09-24',
    });
  });
});

describe('toInputValue', () => {
  it('целые не трогает, дробные обрезает только по нулям', () => {
    expect(toInputValue('100')).toBe('100');
    expect(toInputValue('0.00')).toBe('0');
    expect(toInputValue('10.50')).toBe('10.5');
    expect(toInputValue(null)).toBe('');
  });
});

describe('isPayrollTermsChanged', () => {
  it('без правок — false: «Сохранить» с правкой одного «Оплачено» условия не трогает', () => {
    expect(isPayrollTermsChanged(values(), values())).toBe(false);
  });

  it('любое поле условий, компенсаций или доплаты — true; вернули как было — снова false', () => {
    const initial = values();
    expect(isPayrollTermsChanged(values({ amount: '180000' }), initial)).toBe(true);
    expect(isPayrollTermsChanged(values({ calcType: 'hourly' }), initial)).toBe(true);
    expect(isPayrollTermsChanged(values({ effectiveFrom: '2026-10-01' }), initial)).toBe(true);
    expect(isPayrollTermsChanged(values({ money: { ...EMPTY_MONEY, travel: '2730' } }), initial)).toBe(true);
    expect(isPayrollTermsChanged(values({ supplement: { ...EMPTY_SUPPLEMENT, to: '2026-12-31' } }), initial)).toBe(true);
    expect(isPayrollTermsChanged(values({ money: { ...EMPTY_MONEY } }), initial)).toBe(false);
  });
});
