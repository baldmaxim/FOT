import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Слияние отдела-дубля: переносим только то, что реально в источнике, историю не
 * дробим, доступы чиним, повтор ничего не меняет.
 */

const h = vi.hoisted(() => ({
  getEmployeeById: vi.fn(),
  updateEmployee: vi.fn(),
}));

vi.mock('./sigur.service.js', () => ({
  sigurService: {
    getEmployeeById: h.getEmployeeById,
    updateEmployee: h.updateEmployee,
  },
}));

import {
  mergeDepartmentEmployeesTx,
  moveEmployeesInSigur,
  planEmployeeMerge,
  rollbackDepartmentMergeTx,
  type IMergeEmployeeRow,
} from './department-merge.service.js';

const SOURCE = '8e47aa23-0650-48bf-97b6-362ca0f67ac4';
const TARGET = '408fc327-94d2-419f-b318-7905b9abbc6a';

const employeeRow = (over: Partial<IMergeEmployeeRow> = {}): IMergeEmployeeRow => ({
  id: 600,
  full_name: 'Жидков Сергей Юрьевич',
  sigur_employee_id: 100261,
  employment_status: 'active',
  dismissal_date: null,
  dismissal_apply_started_at: null,
  is_archived: false,
  open_assignments: 1,
  ...over,
});

/** Заглушка PoolClient: пишет вызовы и отдаёт заданные rowCount по подстроке SQL. */
function createClient(rowCounts: Array<{ match: string; rowCount: number }>) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    const rule = rowCounts.find(item => sql.includes(item.match));
    return { rows: [], rowCount: rule?.rowCount ?? 0 };
  });
  return { client: { query } as never, calls, query };
}

describe('planEmployeeMerge', () => {
  it('пропускает активного сотрудника с одним открытым назначением', () => {
    const plan = planEmployeeMerge([employeeRow()]);
    expect(plan.problems).toEqual([]);
    expect(plan.candidates).toEqual([
      { employeeId: 600, fullName: 'Жидков Сергей Юрьевич', sigurEmployeeId: 100261 },
    ]);
  });

  it('отклоняет архивных, уволенных и запланированных к увольнению', () => {
    const plan = planEmployeeMerge([
      employeeRow({ id: 1, is_archived: true }),
      employeeRow({ id: 2, employment_status: 'fired' }),
      employeeRow({ id: 3, dismissal_date: '2026-09-30' }),
      employeeRow({ id: 4, dismissal_apply_started_at: '2026-09-04T10:00:00Z' }),
    ]);
    expect(plan.candidates).toEqual([]);
    expect(plan.problems).toHaveLength(4);
  });

  it('отклоняет, когда открытых назначений не ровно одно или нет карточки Sigur', () => {
    const plan = planEmployeeMerge([
      employeeRow({ id: 5, open_assignments: 0 }),
      employeeRow({ id: 6, open_assignments: 2 }),
      employeeRow({ id: 7, sigur_employee_id: null }),
    ]);
    expect(plan.candidates).toEqual([]);
    expect(plan.problems[0]).toContain('открытых назначений 0');
    expect(plan.problems[1]).toContain('открытых назначений 2');
    expect(plan.problems[2]).toContain('sigur_employee_id');
  });
});

describe('mergeDepartmentEmployeesTx', () => {
  it('переносит только строки источника и не создаёт назначений', async () => {
    const { client, calls } = createClient([
      { match: 'UPDATE employees', rowCount: 2 },
      { match: 'UPDATE employee_assignments', rowCount: 2 },
      { match: 'INSERT INTO employee_department_access', rowCount: 1 },
      { match: 'AND is_active = false', rowCount: 0 },
      { match: 'WHERE department_id = $1 AND is_active', rowCount: 3 },
    ]);

    const counters = await mergeDepartmentEmployeesTx(client, {
      sourceDepartmentId: SOURCE,
      targetDepartmentId: TARGET,
      employeeIds: [600, 1790],
    });

    expect(counters).toEqual({
      employeesUpdated: 2,
      assignmentsUpdated: 2,
      accessGranted: 1,
      accessReactivated: 0,
      accessRevoked: 3,
    });

    const employeesUpdate = calls.find(call => call.sql.includes('UPDATE employees'))!;
    expect(employeesUpdate.sql).toContain('AND org_department_id = $3');
    expect(employeesUpdate.params).toEqual([TARGET, [600, 1790], SOURCE]);

    const assignmentsUpdate = calls.find(call => call.sql.includes('UPDATE employee_assignments'))!;
    expect(assignmentsUpdate.sql).toContain('effective_to IS NULL');
    expect(assignmentsUpdate.sql).not.toContain('effective_from');
    expect(assignmentsUpdate.sql).not.toContain('change_reason');

    // Ни одной записи в табели и историю подач.
    expect(calls.some(call => /timesheet_/i.test(call.sql))).toBe(false);
    expect(calls.some(call => call.sql.startsWith('INSERT INTO employee_assignments'))).toBe(false);
  });

  it('блокирует сотрудников до записи', async () => {
    const { calls, client } = createClient([]);
    await mergeDepartmentEmployeesTx(client, {
      sourceDepartmentId: SOURCE,
      targetDepartmentId: TARGET,
      employeeIds: [600],
    });
    expect(calls[0].sql).toContain('FOR UPDATE');
  });

  it('повторный прогон даёт нули', async () => {
    const { client } = createClient([]);
    const counters = await mergeDepartmentEmployeesTx(client, {
      sourceDepartmentId: SOURCE,
      targetDepartmentId: TARGET,
      employeeIds: [600, 1790],
    });
    expect(counters).toEqual({
      employeesUpdated: 0,
      assignmentsUpdated: 0,
      accessGranted: 0,
      accessReactivated: 0,
      accessRevoked: 0,
    });
  });

  it('гасит привязки к источнику независимо от их источника', async () => {
    const { client, calls } = createClient([]);
    await mergeDepartmentEmployeesTx(client, {
      sourceDepartmentId: SOURCE,
      targetDepartmentId: TARGET,
      employeeIds: [600],
    });
    const revoke = calls.find(call => call.sql.includes('SET is_active = false'))!;
    expect(revoke.sql).not.toContain('source');
    expect(revoke.params).toEqual([SOURCE]);
  });

  it('отказывается сливать отдел сам в себя', async () => {
    const { client } = createClient([]);
    await expect(mergeDepartmentEmployeesTx(client, {
      sourceDepartmentId: SOURCE,
      targetDepartmentId: SOURCE,
      employeeIds: [600],
    })).rejects.toThrow('совпадает');
  });
});

describe('moveEmployeesInSigur', () => {
  beforeEach(() => {
    h.getEmployeeById.mockReset();
    h.updateEmployee.mockReset();
  });

  it('пропускает уже переведённых и переводит остальных', async () => {
    h.getEmployeeById
      .mockResolvedValueOnce({ id: 100261, departmentId: 142649 })
      .mockResolvedValueOnce({ id: 61832, departmentId: 142642 })
      .mockResolvedValueOnce({ id: 61832, departmentId: 142649 });

    const result = await moveEmployeesInSigur([
      { employeeId: 600, fullName: 'Жидков', sigurEmployeeId: 100261 },
      { employeeId: 1790, fullName: 'Трофимов', sigurEmployeeId: 61832 },
    ], 142649);

    expect(result).toEqual({ moved: 1, skipped: 1 });
    expect(h.updateEmployee).toHaveBeenCalledTimes(1);
    expect(h.updateEmployee).toHaveBeenCalledWith(61832, { departmentId: 142649 }, undefined);
  });

  it('падает, если Sigur не применил перевод', async () => {
    h.getEmployeeById
      .mockResolvedValueOnce({ id: 61832, departmentId: 142642 })
      .mockResolvedValueOnce({ id: 61832, departmentId: 142642 });

    await expect(moveEmployeesInSigur(
      [{ employeeId: 1790, fullName: 'Трофимов', sigurEmployeeId: 61832 }],
      142649,
    )).rejects.toThrow('не применил перевод');
  });
});

describe('rollbackDepartmentMergeTx', () => {
  it('возвращает отдел, открытые назначения и доступы', async () => {
    const { client, calls } = createClient([
      { match: 'UPDATE employees', rowCount: 1 },
      { match: 'UPDATE employee_assignments', rowCount: 1 },
      { match: 'UPDATE employee_department_access', rowCount: 1 },
    ]);

    const result = await rollbackDepartmentMergeTx(client, {
      targetDepartmentId: TARGET,
      employees: [{
        employeeId: 600,
        fullName: 'Жидков',
        sigurEmployeeId: 100261,
        orgDepartmentId: SOURCE,
        openAssignmentIds: ['29984565-af85-4a9f-a989-a89e4b6c8c4f'],
      }],
      access: [{ id: 'bb27eebb-844e-48e5-a1af-4e0fce702ad2', employeeId: 600, departmentId: SOURCE, isActive: true }],
    });

    expect(result).toMatchObject({ employeesRestored: 1, assignmentsRestored: 1, accessRestored: 1, skipped: [] });
    const restore = calls.find(call => call.sql.includes('UPDATE employees'))!;
    expect(restore.params).toEqual([SOURCE, 600, TARGET]);
  });

  it('пропускает строку, которую уже поменяли после операции', async () => {
    const { client } = createClient([]);
    const result = await rollbackDepartmentMergeTx(client, {
      targetDepartmentId: TARGET,
      employees: [{
        employeeId: 600,
        fullName: 'Жидков',
        sigurEmployeeId: 100261,
        orgDepartmentId: SOURCE,
        openAssignmentIds: [],
      }],
      access: [],
    });
    expect(result.employeesRestored).toBe(0);
    expect(result.skipped).toHaveLength(1);
  });
});
