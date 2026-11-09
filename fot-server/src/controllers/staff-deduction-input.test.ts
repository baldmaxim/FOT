import { describe, expect, it, vi } from 'vitest';

vi.mock('../services/dormitory-stays.service.js', () => ({ getEmployeeState: vi.fn() }));

import { dismissedSearchFrom, staffDeductionMonthRefusal } from './staff-deduction-input.js';

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
