import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  txQuery: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: h.query,
  queryOne: h.queryOne,
  execute: h.execute,
  withTransaction: async (fn: (client: unknown) => Promise<unknown>) => fn({ query: h.txQuery }),
}));

import {
  assignDirectReport,
  getActiveDirectManagerFor,
  getActiveDirectManagersFor,
} from './employee-direct-reports.service.js';

beforeEach(() => {
  Object.values(h).forEach(fn => fn.mockReset());
});

describe('getActiveDirectManagersFor — маршрут согласований', () => {
  it('уволенный руководитель отсеивается в SQL', async () => {
    h.query.mockResolvedValue([]);

    await getActiveDirectManagersFor([1684]);

    const [sql] = h.query.mock.calls[0];
    // Инцидент: Ситник уволен, но заявления Солдатова продолжали уходить к нему —
    // строка связи сама по себе не гаснет.
    expect(String(sql)).toContain("e.employment_status = 'active'");
    expect(String(sql)).toContain('e.is_archived = false');
  });

  it('живого руководителя возвращает с ФИО', async () => {
    h.query.mockResolvedValue([
      { subordinate_employee_id: 1684, manager_employee_id: 815, manager_full_name: 'Кенгашев У. А.' },
    ]);

    const map = await getActiveDirectManagersFor([1684]);

    expect(map.get(1684)).toEqual({ managerId: 815, managerFullName: 'Кенгашев У. А.' });
  });
});

describe('getActiveDirectManagerFor — guard эксклюзивности', () => {
  it('строку уволенного видит: иначе INSERT упрётся в уникальный индекс вместо already_assigned', async () => {
    h.queryOne.mockResolvedValue({ manager_employee_id: 1656 });

    const managerId = await getActiveDirectManagerFor(1684);

    expect(managerId).toBe(1656);
    const [sql] = h.queryOne.mock.calls[0];
    expect(String(sql)).not.toContain('employment_status');
  });
});

describe('assignDirectReport — гейт на запись', () => {
  const bothEmployeesExist = () => h.query.mockResolvedValue([{ id: 1 }, { id: 2 }]);

  it('уволенного руководителем не назначить', async () => {
    bothEmployeesExist();
    h.txQuery.mockResolvedValue({ rows: [{ employment_status: 'fired', is_archived: false }], rowCount: 1 });

    const result = await assignDirectReport({ managerEmployeeId: 1656, subordinateEmployeeId: 1684 });

    expect(result).toEqual({ ok: false, reason: 'manager_not_active' });
    expect(h.queryOne).not.toHaveBeenCalled();
  });

  it('архивного руководителем не назначить', async () => {
    bothEmployeesExist();
    h.txQuery.mockResolvedValue({ rows: [{ employment_status: 'active', is_archived: true }], rowCount: 1 });

    const result = await assignDirectReport({ managerEmployeeId: 1656, subordinateEmployeeId: 1684 });

    expect(result).toEqual({ ok: false, reason: 'manager_not_active' });
  });

  it('строку руководителя читаем под блокировкой — закрывает гонку с увольнением', async () => {
    bothEmployeesExist();
    h.txQuery.mockResolvedValue({ rows: [{ employment_status: 'active', is_archived: false }], rowCount: 1 });
    h.queryOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'dr-1', subordinate_employee_id: 1684, manager_employee_id: 815,
      assigned_at: '2026-09-08', assigned_by: null, unassigned_at: null, is_active: true, note: null,
    });

    const result = await assignDirectReport({ managerEmployeeId: 815, subordinateEmployeeId: 1684 });

    expect(result.ok).toBe(true);
    expect(String(h.txQuery.mock.calls[0][0])).toContain('FOR UPDATE');
  });

  it('живого руководителя назначает', async () => {
    bothEmployeesExist();
    h.txQuery.mockResolvedValue({ rows: [{ employment_status: 'active', is_archived: false }], rowCount: 1 });
    h.queryOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'dr-2', subordinate_employee_id: 1684, manager_employee_id: 815,
      assigned_at: '2026-09-08', assigned_by: 'admin-1', unassigned_at: null, is_active: true, note: null,
    });

    const result = await assignDirectReport({ managerEmployeeId: 815, subordinateEmployeeId: 1684, assignedBy: 'admin-1' });

    expect(result.ok).toBe(true);
  });

  it('несуществующая карточка руководителя → employee_not_found', async () => {
    bothEmployeesExist();
    h.txQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const result = await assignDirectReport({ managerEmployeeId: 999999, subordinateEmployeeId: 1684 });

    expect(result).toEqual({ ok: false, reason: 'employee_not_found' });
  });
});
