/**
 * Оклад руководителя строительства уходит наружу четырьмя путями: список закреплений,
 * карточка объекта, ответ PATCH и снимки before/after в журнале. Здесь проверяется, что
 * маскирование одно на все четыре и что журнал не выдаёт сумму окольным путём.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./object-kpi-roles-cache.service.js', () => ({
  isEconomicsHead: vi.fn(async () => false),
}));

import { isEconomicsHead } from './object-kpi-roles-cache.service.js';
import {
  canSeeManagerSalary,
  redactAssignmentSalary,
  redactHistorySalary,
} from './object-kpi-salary-access.service.js';
import type { ObjectKpiHistoryRow } from './object-kpi-history.service.js';

const asMock = <T>(fn: T) => fn as unknown as { mockResolvedValueOnce: (v: boolean) => void };

const historyRow = (overrides: Partial<ObjectKpiHistoryRow> = {}): ObjectKpiHistoryRow => ({
  id: 'h-1',
  skud_object_id: 'obj-1',
  entity_kind: 'assignment',
  entity_id: 'as-1',
  action: 'update',
  changed_fields: ['valid_to', 'salary_amount'],
  before_data: { valid_to: null, salary_amount: '300000.00' },
  after_data: { valid_to: '2026-08-31', salary_amount: '350000.00' },
  reason: null,
  changed_by_name: 'Экономист',
  changed_at: '2026-08-18T09:00:00.000Z',
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('canSeeManagerSalary', () => {
  it('админ видит без похода за ролью', async () => {
    expect(await canSeeManagerSalary({ is_admin: true, employee_id: 1 })).toBe(true);
    expect(isEconomicsHead).not.toHaveBeenCalled();
  });

  it('руководитель эк. отдела видит', async () => {
    asMock(isEconomicsHead).mockResolvedValueOnce(true);
    expect(await canSeeManagerSalary({ is_admin: false, employee_id: 42 })).toBe(true);
  });

  it('экономист объекта не видит', async () => {
    expect(await canSeeManagerSalary({ is_admin: false, employee_id: 5 })).toBe(false);
  });
});

describe('redactAssignmentSalary', () => {
  it('без права оклад приходит null, значение из строки не утекает', () => {
    const rows = [{ id: 'as-1', salary_amount: '350000.00' }];
    expect(redactAssignmentSalary(rows, false)).toEqual([{ id: 'as-1', salary_amount: null }]);
    // Исходный массив не мутируется: тот же объект отдаётся и в других ответах.
    expect(rows[0].salary_amount).toBe('350000.00');
  });

  it('с правом строки отдаются как есть', () => {
    const rows = [{ id: 'as-1', salary_amount: '350000.00' }];
    expect(redactAssignmentSalary(rows, true)).toBe(rows);
  });

  it('одиночная строка ответа PATCH маскируется так же', () => {
    expect(redactAssignmentSalary({ id: 'as-1', salary_amount: '350000.00' }, false))
      .toEqual({ id: 'as-1', salary_amount: null });
  });
});

describe('redactHistorySalary', () => {
  it('без права в снимках нет ключа, а имя поля вычищено из changed_fields', () => {
    const [row] = redactHistorySalary([historyRow()], false);

    expect(row.before_data).not.toHaveProperty('salary_amount');
    expect(row.after_data).not.toHaveProperty('salary_amount');
    // Оставленное имя поля не показывает суммы, но выдаёт факт и момент изменения оклада.
    expect(row.changed_fields).toEqual(['valid_to']);
    expect(row.before_data).toMatchObject({ valid_to: null });
  });

  it('записи других сущностей не трогаются', () => {
    const contract = historyRow({
      entity_kind: 'contract',
      changed_fields: ['base_amount'],
      before_data: { base_amount: '1.00' },
      after_data: { base_amount: '2.00' },
    });

    expect(redactHistorySalary([contract], false)[0]).toBe(contract);
  });

  it('с правом журнал отдаётся как есть', () => {
    const rows = [historyRow()];
    expect(redactHistorySalary(rows, true)).toBe(rows);
  });
});
