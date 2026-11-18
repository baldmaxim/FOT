import { describe, expect, it } from 'vitest';

import {
  firstInvalidField,
  initialPayrollTermsValues,
  isPayrollTermsChanged,
  payrollRowCategory,
  payrollTermsTotal,
  toInputValue,
  validatePayrollTerms,
  type IPayrollTermsFormValues,
} from './payrollTermsForm';
import type { IPayrollTermsRow } from '../services/payrollService';

const EMPTY_MONEY = { bonus: '', housing: '' };

const values = (over: Partial<IPayrollTermsFormValues> = {}): IPayrollTermsFormValues => ({
  calcType: 'salary',
  amount: '175000',
  contractType: 'labor',
  money: EMPTY_MONEY,
  effectiveFrom: '2026-09-24',
  ...over,
});

/** Тело запроса как его увидит сервер: undefined-поля в JSON не попадают. */
const wire = (payload: unknown) => JSON.parse(JSON.stringify(payload));

const row = (over: Partial<IPayrollTermsRow> = {}): IPayrollTermsRow => ({
  employee_id: 7, full_name: 'Иванов Иван', tab_number: null, department_id: null, department_name: null,
  position_name: null, schedule_name: null, terms_id: 5, category: 'worker', calc_type: 'hourly',
  monthly_salary: null, hourly_rate: '450.0000', bonus_amount: '15000.00', housing_compensation: null,
  travel_compensation: '3000.50', communication_compensation: null,
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
      contract_type: 'labor',
      effective_from: '2026-09-24',
    });
  });

  it('часы: сумма в hourly_rate, запятая как разделитель; премиальная часть от прежнего вида оплаты не уходит', () => {
    const result = validatePayrollTerms(values({
      calcType: 'hourly',
      amount: '450,5',
      money: { bonus: '15000', housing: '12000' },
    }));
    expect(wire(result.payload)).toEqual({
      calc_type: 'hourly',
      hourly_rate: 450.5,
      contract_type: 'labor',
      // Проживание — только показ (квартира «Проживания», миграция 320), проезд — ставка «Справочника» (324):
      // в условия не уходят; удержаний в условиях с миграции 321 нет.
      effective_from: '2026-09-24',
    });
  });

  it('оклад: явный 0 премиальной части уходит нулём', () => {
    const result = validatePayrollTerms(values({ calcType: 'salary', amount: '100000', money: { bonus: '0', housing: '' } }));
    expect(result.payload?.bonus_amount).toBe(0);
  });

  it('часы: мусор в скрытой премиальной части сохранению не мешает', () => {
    const result = validatePayrollTerms(values({ calcType: 'hourly', amount: '730', money: { bonus: 'abc', housing: '' } }));
    expect(result.errors).toBeNull();
    expect(result.payload?.bonus_amount).toBeUndefined();
  });

  it('ошибки — по полям, все сразу; первая по порядку на экране', () => {
    const result = validatePayrollTerms(values({
      calcType: 'salary',
      amount: '',
      money: { ...EMPTY_MONEY, bonus: 'abc' },
      effectiveFrom: '',
    }));
    expect(result.payload).toBeNull();
    expect(result.errors).toEqual({
      amount: 'Укажите оклад',
      bonus: 'Введите число не меньше нуля',
      effectiveFrom: 'Укажите дату «Действует с»',
    });
    expect(firstInvalidField(result.errors ?? {})).toBe('effectiveFrom');
    expect(validatePayrollTerms(values({ calcType: 'hourly', amount: '' })).errors?.amount).toBe('Укажите часовую ставку');
  });

  it('копейки: пробелы между разрядами допустимы, третий знак — ошибка, а не молчаливое округление', () => {
    const ok = validatePayrollTerms(values({ amount: '175 000,50', money: { ...EMPTY_MONEY, bonus: '25\u00a0000,10' } }));
    expect(ok.errors).toBeNull();
    expect(ok.payload).toMatchObject({ monthly_salary: 175000.5, bonus_amount: 25000.1 });

    const result = validatePayrollTerms(values({ amount: '175000,555', money: { ...EMPTY_MONEY, bonus: '100,005' } }));
    expect(result.payload).toBeNull();
    expect(result.errors).toEqual({
      amount: 'Значение — число не меньше нуля, до двух знаков после запятой',
      bonus: 'Значение — число не меньше нуля, до двух знаков после запятой',
    });
  });

  it('часовая ставка — до 4 знаков после запятой, пятый — ошибка', () => {
    const ok = validatePayrollTerms(values({ calcType: 'hourly', amount: '450,1250' }));
    expect(ok.errors).toBeNull();
    expect(ok.payload?.hourly_rate).toBe(450.125);
    expect(validatePayrollTerms(values({ calcType: 'hourly', amount: '450,12345' })).errors)
      .toEqual({ amount: 'Значение — число не меньше нуля, до четырёх знаков после запятой' });
  });

  it('сумма сверх NUMERIC(12,2) — ошибка, а не 500 от БД', () => {
    expect(validatePayrollTerms(values({ amount: '10000000000' })).errors)
      .toEqual({ amount: 'Слишком большое значение' });
  });

  it('порядок фокуса — как на экране: премия рядом с окладом, компенсации после', () => {
    expect(firstInvalidField({ housing: 'x', bonus: 'x' })).toBe('bonus');
  });

  it('оклад ноль — ошибка оклада', () => {
    expect(validatePayrollTerms(values({ amount: '0' })).errors).toEqual({ amount: 'Укажите оклад' });
  });
});

describe('validatePayrollTerms: плановых доплат в запросе нет (миграция 369)', () => {
  it('доплаты правят в «Справочнике», окно сотрудника их только показывает — ключа planned_supplement нет', () => {
    const result = validatePayrollTerms(values());
    expect(result.errors).toBeNull();
    expect(wire(result.payload)).not.toHaveProperty('planned_supplement');
  });
});

describe('initialPayrollTermsValues', () => {
  it('договор — из условий; без условий — трудовой', () => {
    expect(initialPayrollTermsValues(row({ contract_type: 'gph' }), '2026-09-24').contractType).toBe('gph');
    expect(initialPayrollTermsValues(row({ terms_id: null, contract_type: 'gph' }), '2026-09-24').contractType)
      .toBe('labor');
  });

  it('смена договора — правка условий, ГПХ уходит в запрос и у почасовой ставки; округление оклада не шлём', () => {
    const initial = values();
    expect(isPayrollTermsChanged(values({ contractType: 'gph' }), initial)).toBe(true);
    const payload = wire(validatePayrollTerms(values({ calcType: 'hourly', amount: '450', contractType: 'gph' })).payload);
    expect(payload).toMatchObject({ contract_type: 'gph' });
    expect(payload).not.toHaveProperty('proration_rounding');
  });

  it('из условий сотрудника: хвост нулей NUMERIC убирается, пустые суммы остаются пустыми', () => {
    expect(initialPayrollTermsValues(row(), '2026-09-24')).toEqual({
      calcType: 'hourly',
      amount: '450',
      contractType: 'labor',
      // Проезд условий (travel_compensation) с миграции 324 в форму не попадает.
      money: { bonus: '15000', housing: '' },
      effectiveFrom: '2026-09-24',
    });
  });

  it('без условий: суммы пустые, вид оплаты — по графику (оклад), и у рабочих тоже', () => {
    const initial = initialPayrollTermsValues(
      row({ terms_id: null, calc_type: null, hourly_rate: null, bonus_amount: '1.00' }),
      '2026-09-24',
    );
    expect(initial).toEqual({
      calcType: 'salary', amount: '', contractType: 'labor', money: EMPTY_MONEY, effectiveFrom: '2026-09-24',
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

  it('любое поле условий или компенсаций — true; вернули как было — снова false', () => {
    const initial = values();
    expect(isPayrollTermsChanged(values({ amount: '180000' }), initial)).toBe(true);
    expect(isPayrollTermsChanged(values({ calcType: 'hourly' }), initial)).toBe(true);
    expect(isPayrollTermsChanged(values({ effectiveFrom: '2026-10-01' }), initial)).toBe(true);
    expect(isPayrollTermsChanged(values({ money: { ...EMPTY_MONEY, bonus: '2730' } }), initial)).toBe(true);
    expect(isPayrollTermsChanged(values({ money: { ...EMPTY_MONEY } }), initial)).toBe(false);
  });
});

describe('категория в окне сотрудника', () => {
  it('по табелю — как прислал сервер; в форме и в запросе её нет', () => {
    expect(payrollRowCategory(row({ category: 'itr' }))).toBe('itr');
    expect(payrollRowCategory(row({ terms_id: null, category: 'worker' }))).toBe('worker');
    expect(initialPayrollTermsValues(row(), '2026-09-24')).not.toHaveProperty('staffCategory');
    expect(wire(validatePayrollTerms(values()).payload)).not.toHaveProperty('staff_category');
  });
});

describe('payrollTermsTotal: «Итого» = оклад + премия', () => {
  it('сумма с запятой и копейками без ошибки float; пустое поле — 0', () => {
    expect(payrollTermsTotal(values({ amount: '175000', money: { ...EMPTY_MONEY, bonus: '25000,10' } }))).toBe(200000.1);
    expect(payrollTermsTotal(values({ amount: '0.1', money: { ...EMPTY_MONEY, bonus: '0.2' } }))).toBe(0.3);
    expect(payrollTermsTotal(values({ amount: '', money: { ...EMPTY_MONEY, bonus: '15000' } }))).toBe(15000);
    expect(payrollTermsTotal(values({ amount: '175 000,50', money: { ...EMPTY_MONEY, bonus: '' } }))).toBe(175000.5);
  });

  it('оба поля пустые, не число или почасовая оплата — «—» (null)', () => {
    expect(payrollTermsTotal(values({ amount: '' }))).toBeNull();
    expect(payrollTermsTotal(values({ amount: 'abc' }))).toBeNull();
    // третий знак сохранить нельзя — не показываем округлённые 100,01
    expect(payrollTermsTotal(values({ amount: '100,005' }))).toBeNull();
    expect(payrollTermsTotal(values({ amount: '175000', money: { ...EMPTY_MONEY, bonus: '1,001' } }))).toBeNull();
    expect(payrollTermsTotal(values({ calcType: 'hourly', amount: '450' }))).toBeNull();
  });
});
