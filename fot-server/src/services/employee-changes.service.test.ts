import { beforeEach, describe, expect, it, vi } from 'vitest';

const { pgQuery, pgQueryOne, pgExecute, pgTx, mockGetEmployeeAssignments, mockGetTransferConfig } = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  pgQueryOne: vi.fn(),
  pgExecute: vi.fn(),
  pgTx: vi.fn(),
  mockGetEmployeeAssignments: vi.fn(),
  mockGetTransferConfig: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: pgQueryOne,
  execute: pgExecute,
  withTransaction: pgTx,
}));

vi.mock('./settings.service.js', () => ({
  settingsService: {
    getEmployeeTransferConfig: mockGetTransferConfig,
  },
}));

vi.mock('./employee-cache.service.js', () => ({
  employeeCache: { invalidate: vi.fn() },
}));

vi.mock('./timesheet-department-assignments.service.js', async () => {
  const actual = await vi.importActual<typeof import('./timesheet-department-assignments.service.js')>(
    './timesheet-department-assignments.service.js',
  );
  return {
    ...actual,
    getEmployeeAssignments: mockGetEmployeeAssignments,
  };
});

vi.mock('./timesheet-transfers.service.js', () => ({
  tryDeleteTransfer: vi.fn().mockResolvedValue({ deleted: false }),
}));

import { employeeChangesService } from './employee-changes.service.js';

interface IExecutedQuery {
  sql: string;
  params: readonly unknown[] | undefined;
}

const createFakeClient = (
  responder: (sql: string, params: readonly unknown[] | undefined) => { rows: unknown[] } | undefined,
) => {
  const queries: IExecutedQuery[] = [];
  const query = vi.fn(async (sql: string, params?: readonly unknown[]) => {
    queries.push({ sql, params });
    const result = responder(sql, params);
    return result ?? { rows: [] };
  });
  return { query, queries };
};

describe('employee-changes.service.changeDepartment — overlap regression', () => {
  beforeEach(() => {
    pgQuery.mockReset();
    pgQueryOne.mockReset();
    pgExecute.mockReset();
    pgTx.mockReset();
    mockGetEmployeeAssignments.mockReset();
    mockGetTransferConfig.mockReset();
  });

  it('freezeHistory=true: переоткрывает самую свежую закрытую запись вместо INSERT с hire_date', async () => {
    mockGetTransferConfig.mockResolvedValue({ freezeHistory: true });

    const employeeId = 2521;
    const closedAssignmentId = 'closed-uuid-1';

    const fake = createFakeClient((sql) => {
      if (/SELECT.+FROM employees WHERE id/i.test(sql)) {
        return { rows: [{ org_department_id: 'archive-dept', position_id: null, hire_date: '2020-03-01' }] };
      }
      if (/SELECT id, effective_from\s+FROM employee_assignments\s+WHERE employee_id = \$1 AND effective_to IS NULL/i.test(sql)) {
        return { rows: [] };
      }
      if (/SELECT id\s+FROM employee_assignments\s+WHERE employee_id = \$1 AND effective_to IS NOT NULL/i.test(sql)) {
        return { rows: [{ id: closedAssignmentId }] };
      }
      return { rows: [] };
    });

    pgTx.mockImplementation(async (fn: (client: typeof fake) => Promise<unknown>) => fn(fake));

    await expect(
      employeeChangesService.changeDepartment(employeeId, 'new-dept', {
        reason: 'Восстановление на работу',
        createdBy: 'user-1',
        effectiveDate: '2026-05-13',
      }),
    ).resolves.toBeUndefined();

    const updates = fake.queries.filter(q => /UPDATE employee_assignments/i.test(q.sql));
    const inserts = fake.queries.filter(q => /INSERT INTO employee_assignments/i.test(q.sql));

    expect(inserts).toHaveLength(0);
    const reopen = updates.find(q => /SET org_department_id\s*=\s*\$1,\s+position_id\s*=\s*\$2,\s+effective_to\s*=\s*NULL/i.test(q.sql));
    expect(reopen).toBeTruthy();
    expect(reopen?.params).toEqual(expect.arrayContaining(['new-dept', null, 'Восстановление на работу']));
    expect(reopen?.params?.slice(-2)).toEqual([closedAssignmentId, employeeId]);
  });

  it('freezeHistory=true: INSERT только если у сотрудника вообще нет ни одной строки', async () => {
    mockGetTransferConfig.mockResolvedValue({ freezeHistory: true });

    const fake = createFakeClient((sql) => {
      if (/SELECT.+FROM employees WHERE id/i.test(sql)) {
        return { rows: [{ org_department_id: null, position_id: null, hire_date: '2025-01-15' }] };
      }
      if (/SELECT id, effective_from\s+FROM employee_assignments\s+WHERE employee_id = \$1 AND effective_to IS NULL/i.test(sql)) {
        return { rows: [] };
      }
      if (/SELECT id\s+FROM employee_assignments\s+WHERE employee_id = \$1 AND effective_to IS NOT NULL/i.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    pgTx.mockImplementation(async (fn: (client: typeof fake) => Promise<unknown>) => fn(fake));

    await employeeChangesService.changeDepartment(2521, 'new-dept', {
      reason: 'Перевод',
      effectiveDate: '2026-05-13',
    });

    const inserts = fake.queries.filter(q => /INSERT INTO employee_assignments/i.test(q.sql));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params?.[3]).toBe('2025-01-15');
  });

  it('freezeHistory=false: single closed-today row → закрывает в today-1 и INSERT [today, null]', async () => {
    mockGetTransferConfig.mockResolvedValue({ freezeHistory: false });

    mockGetEmployeeAssignments.mockResolvedValue([
      { id: 'a-1', effective_from: '2024-01-01', effective_to: '2026-05-13' },
    ]);

    const fake = createFakeClient((sql) => {
      if (/SELECT position_id, org_department_id FROM employees/i.test(sql)) {
        return { rows: [{ position_id: 'pos-1', org_department_id: 'old-dept' }] };
      }
      return { rows: [] };
    });

    pgTx.mockImplementation(async (fn: (client: typeof fake) => Promise<unknown>) => fn(fake));

    await employeeChangesService.changeDepartment(2521, 'new-dept', {
      effectiveDate: '2026-05-13',
    });

    const closeUpdate = fake.queries.find(q =>
      /UPDATE employee_assignments\s+SET effective_to = \$1, updated_at = \$2\s+WHERE id = \$3/i.test(q.sql),
    );
    expect(closeUpdate).toBeTruthy();
    expect(closeUpdate?.params?.[0]).toBe('2026-05-12');
    expect(closeUpdate?.params?.[2]).toBe('a-1');

    const inserts = fake.queries.filter(q => /INSERT INTO employee_assignments/i.test(q.sql));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params?.[3]).toBe('2026-05-13');
  });

  it('freezeHistory=true + forceHistory=true: ведёт полную историю (закрывает старую + INSERT новой)', async () => {
    mockGetTransferConfig.mockResolvedValue({ freezeHistory: true });

    mockGetEmployeeAssignments.mockResolvedValue([
      { id: 'a-1', effective_from: '2024-01-01', effective_to: null },
    ]);

    const fake = createFakeClient((sql) => {
      if (/SELECT position_id, org_department_id FROM employees/i.test(sql)) {
        return { rows: [{ position_id: 'pos-1', org_department_id: 'real-dept' }] };
      }
      return { rows: [] };
    });

    pgTx.mockImplementation(async (fn: (client: typeof fake) => Promise<unknown>) => fn(fake));

    await employeeChangesService.changeDepartment(2521, 'archive-dept', {
      reason: 'Увольнение — перевод в папку "Уволенные"',
      effectiveDate: '2026-05-27',
      forceHistory: true,
    });

    // forceHistory обходит freeze: должна сработать non-freeze ветка
    const closeUpdate = fake.queries.find(q =>
      /UPDATE employee_assignments\s+SET effective_to = \$1, updated_at = \$2\s+WHERE id = \$3/i.test(q.sql),
    );
    expect(closeUpdate).toBeTruthy();
    expect(closeUpdate?.params?.[0]).toBe('2026-05-26'); // date-1
    expect(closeUpdate?.params?.[2]).toBe('a-1');

    const inserts = fake.queries.filter(q => /INSERT INTO employee_assignments/i.test(q.sql));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params?.[1]).toBe('archive-dept');
    expect(inserts[0].params?.[3]).toBe('2026-05-27');

    // НЕ должно быть frozen-перезаписи (reopen с effective_to=NULL)
    const reopen = fake.queries.find(q => /SET org_department_id\s*=\s*\$1,\s+position_id\s*=\s*\$2,\s+effective_to\s*=\s*NULL/i.test(q.sql));
    expect(reopen).toBeFalsy();
  });

  it('freezeHistory=false: closed[X, today-1] + zero-day [today, today] → UPDATE sameDayAssignment, effective_to=null', async () => {
    mockGetTransferConfig.mockResolvedValue({ freezeHistory: false });

    mockGetEmployeeAssignments.mockResolvedValue([
      { id: 'a-1', effective_from: '2024-01-01', effective_to: '2026-05-12' },
      { id: 'a-2', effective_from: '2026-05-13', effective_to: '2026-05-13' },
    ]);

    const fake = createFakeClient((sql) => {
      if (/SELECT position_id, org_department_id FROM employees/i.test(sql)) {
        return { rows: [{ position_id: null, org_department_id: 'archive-dept' }] };
      }
      return { rows: [] };
    });

    pgTx.mockImplementation(async (fn: (client: typeof fake) => Promise<unknown>) => fn(fake));

    await employeeChangesService.changeDepartment(2521, 'new-dept', {
      effectiveDate: '2026-05-13',
    });

    const sameDayUpdate = fake.queries.find(q =>
      /UPDATE employee_assignments\s+SET org_department_id = \$1,\s+position_id = \$2,\s+effective_to = \$3/i.test(q.sql),
    );
    expect(sameDayUpdate).toBeTruthy();
    expect(sameDayUpdate?.params?.[0]).toBe('new-dept');
    expect(sameDayUpdate?.params?.[2]).toBeNull();
    expect(sameDayUpdate?.params?.[6]).toBe('a-2');

    const inserts = fake.queries.filter(q => /INSERT INTO employee_assignments/i.test(q.sql));
    expect(inserts).toHaveLength(0);
  });
});
