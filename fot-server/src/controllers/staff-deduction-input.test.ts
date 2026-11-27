import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const employees = vi.hoisted(() => ({ getEmployeeState: vi.fn() }));
vi.mock('../services/dormitory-stays.service.js', () => employees);

const paid = vi.hoisted(() => ({ getPaidAmounts: vi.fn() }));
vi.mock('../services/payroll/payroll-paid.service.js', () => paid);

import {
  dismissedSearchFrom,
  isPayrollMonthLoadedFrom1c,
  staffDeductionAddRefusal,
  staffDeductionFieldsSchema,
  staffDeductionMonthRefusal,
  staffDeductionUpdateRefusal,
} from './staff-deduction-input.js';

const active = { employment_status: 'active', dismissal_date: null };
const fired = (date: string | null) => ({ employment_status: 'fired', dismissal_date: date });

describe('месяц удержания (решение 09.11.2026: уволенному — не позже месяца увольнения)', () => {
  it('работающему — любой месяц', () => {
    expect(staffDeductionMonthRefusal(active, '2026-10')).toBeNull();
    expect(staffDeductionMonthRefusal(active, '2027-12')).toBeNull();
  });

  it('уволенный 23.10: октябрь и раньше — можно, ноябрь — нет', () => {
    expect(staffDeductionMonthRefusal(fired('2026-10-23'), '2026-10')).toBeNull();
    expect(staffDeductionMonthRefusal(fired('2026-10-23'), '2026-03')).toBeNull();
    expect(staffDeductionMonthRefusal(fired('2026-10-23'), '2026-11')).toBe('Уволен 23.10.2026 — удержание не позже октября 2026');
  });

  it('граница года: уволен 31.12.2026 — декабрь можно, январь 2027 нет; уволен 01.01.2027 — январь можно', () => {
    expect(staffDeductionMonthRefusal(fired('2026-12-31'), '2026-12')).toBeNull();
    expect(staffDeductionMonthRefusal(fired('2026-12-31'), '2027-01')).toBe('Уволен 31.12.2026 — удержание не позже декабря 2026');
    expect(staffDeductionMonthRefusal(fired('2027-01-01'), '2027-01')).toBeNull();
    expect(staffDeductionMonthRefusal(fired('2027-01-01'), '2026-12')).toBeNull();
  });

  it('уволенный без даты — нельзя', () => {
    expect(staffDeductionMonthRefusal(fired(null), '2026-10')).toBe('У уволенного нет даты увольнения — удержание не добавить');
  });

  it('правка: месяц не меняется — можно и после увольнения (строки 1С); меняется — по правилу', () => {
    expect(staffDeductionMonthRefusal(fired('2026-06-15'), '2026-09', '2026-09')).toBeNull();
    expect(staffDeductionMonthRefusal(fired(null), '2026-09', '2026-09')).toBeNull();
    expect(staffDeductionMonthRefusal(fired('2026-06-15'), '2026-08', '2026-09')).toBe('Уволен 15.06.2026 — удержание не позже июня 2026');
    expect(staffDeductionMonthRefusal(fired('2026-06-15'), '2026-06', '2026-09')).toBeNull();
  });
});

describe('с какой даты уволенные в поиске: самый ранний месяц выбора — 11 назад', () => {
  it('ноябрь 2026 → декабрь 2025; январь → февраль прошлого года; декабрь → январь того же года', () => {
    expect(dismissedSearchFrom('2026-11-09')).toBe('2025-12-01');
    expect(dismissedSearchFrom('2026-01-31')).toBe('2025-02-01');
    expect(dismissedSearchFrom('2026-12-01')).toBe('2026-01-01');
  });
});

describe('месяц не раньше месяца приёма (решение 27.11.2026: иначе сумма нигде не учтётся)', () => {
  const hired = (date: string | null) => ({ ...active, hire_date: date });

  it('принят 05.11.2026: ноябрь и позже — можно, октябрь — нет', () => {
    expect(staffDeductionMonthRefusal(hired('2026-11-05'), '2026-11')).toBeNull();
    expect(staffDeductionMonthRefusal(hired('2026-11-05'), '2026-12')).toBeNull();
    expect(staffDeductionMonthRefusal(hired('2026-11-05'), '2026-10')).toBe('Принят 05.11.2026 — удержание не раньше ноября 2026');
  });

  it('даты приёма нет — без ограничения; правка без смены месяца — можно', () => {
    expect(staffDeductionMonthRefusal(hired(null), '2020-01')).toBeNull();
    expect(staffDeductionMonthRefusal(hired('2026-11-05'), '2026-10', '2026-10')).toBeNull();
  });

  it('уволенному — и не раньше приёма, и не позже увольнения', () => {
    const employee = { employment_status: 'fired', dismissal_date: '2026-10-23', hire_date: '2026-08-01' };
    expect(staffDeductionMonthRefusal(employee, '2026-07')).toBe('Принят 01.08.2026 — удержание не раньше августа 2026');
    expect(staffDeductionMonthRefusal(employee, '2026-09')).toBeNull();
    expect(staffDeductionMonthRefusal(employee, '2026-11')).toBe('Уволен 23.10.2026 — удержание не позже октября 2026');
  });
});

describe('месяц, зарплата за который загружена из 1С (решение 27.11.2026: не принимать)', () => {
  const ACTIVE_STATE = {
    id: 42, employment_status: 'active', dismissal_date: null, hire_date: '2025-03-01', is_archived: false, is_contractor: false,
  };
  const LOADED = 'Зарплата за сентябрь 2026 уже загружена из 1С — укажите текущий или следующий месяц';

  beforeEach(() => {
    vi.clearAllMocks();
    employees.getEmployeeState.mockResolvedValue(ACTIVE_STATE);
    paid.getPaidAmounts.mockResolvedValue([]);
  });

  it('«Зарплата» или ГПХ 1С — загружен; только удержания или иные статьи 1С — нет (правило «Свода»)', async () => {
    paid.getPaidAmounts.mockResolvedValueOnce([{ month: '2026-09', item: 'contract', amount: '50000.00' }]);
    await expect(isPayrollMonthLoadedFrom1c(42, '2026-09')).resolves.toBe(true);
    paid.getPaidAmounts.mockResolvedValueOnce([{ month: '2026-09', item: 'gph', amount: '10000.00' }]);
    await expect(isPayrollMonthLoadedFrom1c(42, '2026-09')).resolves.toBe(true);
    paid.getPaidAmounts.mockResolvedValueOnce([{ month: '2026-09', item: 'safety_fine', amount: '3000.00' }]);
    await expect(isPayrollMonthLoadedFrom1c(42, '2026-09')).resolves.toBe(false);
    paid.getPaidAmounts.mockResolvedValueOnce([]);
    await expect(isPayrollMonthLoadedFrom1c(42, '2026-10')).resolves.toBe(false);
    expect(paid.getPaidAmounts).toHaveBeenLastCalledWith(42, '2026-10', '2026-10');
  });

  it('добавить в загруженный месяц — 400 с месяцем; в незагруженный — можно', async () => {
    paid.getPaidAmounts.mockResolvedValueOnce([{ month: '2026-09', item: 'contract', amount: '50000.00' }]);
    await expect(staffDeductionAddRefusal(42, '2026-09')).resolves.toEqual({ status: 400, body: { success: false, error: LOADED } });
    await expect(staffDeductionAddRefusal(42, '2026-10')).resolves.toBeNull();
  });

  it('правка: тот же месяц — можно без запроса 1С; перенос в загруженный — 400, в незагруженный — можно', async () => {
    await expect(staffDeductionUpdateRefusal(42, '2026-09', '2026-09')).resolves.toBeNull();
    expect(paid.getPaidAmounts).not.toHaveBeenCalled();
    paid.getPaidAmounts.mockResolvedValueOnce([{ month: '2026-09', item: 'contract', amount: '50000.00' }]);
    await expect(staffDeductionUpdateRefusal(42, '2026-09', '2026-10')).resolves.toEqual({ status: 400, body: { success: false, error: LOADED } });
    await expect(staffDeductionUpdateRefusal(42, '2026-11', '2026-10')).resolves.toBeNull();
  });

  it('месяц до приёма отказывает раньше запроса 1С', async () => {
    employees.getEmployeeState.mockResolvedValue({ ...ACTIVE_STATE, hire_date: '2026-11-05' });
    const refusal = await staffDeductionAddRefusal(42, '2026-10');
    expect(refusal?.body.error).toBe('Принят 05.11.2026 — удержание не раньше ноября 2026');
    expect(paid.getPaidAmounts).not.toHaveBeenCalled();
  });
});

describe('поля нарушения (миграция 383)', () => {
  const BASE = { kind_id: 7, month: '2026-11', amount: 5000 };
  const OBJECT_ID = '0b8e6c1e-4f53-4f0b-9a3c-2a1f7b9d8e10';

  beforeEach(() => {
    vi.useFakeTimers();
    // 27.11.2026 22:30 UTC — по МСК уже 28.11.
    vi.setSystemTime(new Date('2026-11-27T22:30:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('старый клиент без полей — все null', () => {
    expect(staffDeductionFieldsSchema.parse(BASE)).toMatchObject({
      violation_object_id: null, violation_place: null, violation_date: null,
    });
  });

  it('объект, уточнение (пробелы сжимаются, пустое — null) и дата', () => {
    expect(staffDeductionFieldsSchema.parse({
      ...BASE, violation_object_id: OBJECT_ID, violation_place: '  корпус 2,   5 этаж ', violation_date: '2026-11-25',
    })).toMatchObject({ violation_object_id: OBJECT_ID, violation_place: 'корпус 2, 5 этаж', violation_date: '2026-11-25' });
    expect(staffDeductionFieldsSchema.parse({ ...BASE, violation_place: '   ' }).violation_place).toBeNull();
  });

  it('дата: сегодня по МСК — можно, завтра — нет, несуществующая — нет', () => {
    expect(staffDeductionFieldsSchema.parse({ ...BASE, violation_date: '2026-11-28' }).violation_date).toBe('2026-11-28');
    expect(() => staffDeductionFieldsSchema.parse({ ...BASE, violation_date: '2026-11-29' }))
      .toThrow('Дата нарушения не может быть позже сегодняшней');
    expect(() => staffDeductionFieldsSchema.parse({ ...BASE, violation_date: '2026-02-30' })).toThrow('Укажите дату нарушения');
    expect(() => staffDeductionFieldsSchema.parse({ ...BASE, violation_date: '25.11.2026' })).toThrow('Укажите дату нарушения');
  });

  it('объект — uuid; уточнение — не длиннее 200 символов', () => {
    expect(() => staffDeductionFieldsSchema.parse({ ...BASE, violation_object_id: 'ЖК Сад 69' })).toThrow('Выберите место нарушения');
    expect(staffDeductionFieldsSchema.parse({ ...BASE, violation_place: 'я'.repeat(200) }).violation_place).toHaveLength(200);
    expect(() => staffDeductionFieldsSchema.parse({ ...BASE, violation_place: 'я'.repeat(201) }))
      .toThrow('Уточнение места — не длиннее 200 символов');
  });
});
