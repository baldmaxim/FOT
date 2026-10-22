import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * «Повышение зарплаты» → кандидаты: ФИО — ё = е, раскладка; точных в скоупе нет — с одной ошибкой.
 */

const { h } = vi.hoisted(() => ({ h: { query: vi.fn() } }));

vi.mock('../config/postgres.js', () => ({ query: h.query, queryOne: vi.fn() }));
vi.mock('../services/data-scope.service.js', () => ({
  resolveRequestDataScope: vi.fn(async () => 'all'),
  resolveManagedDepartmentIds: vi.fn(async () => []),
}));
vi.mock('../services/attendance.service.js', () => ({}));
vi.mock('../services/employee-changes.service.js', () => ({ employeeChangesService: {} }));
vi.mock('../services/notification.service.js', () => ({ notificationService: {} }));
vi.mock('../services/push.service.js', () => ({ pushService: {} }));
vi.mock('../services/realtime-broadcast.service.js', () => ({ emitDomainChange: vi.fn() }));
vi.mock('../services/schedule.service.js', () => ({}));
vi.mock('../services/skud-discipline.service.js', () => ({}));
vi.mock('../services/skud-travel.service.js', () => ({}));
vi.mock('../services/timesheet-department-assignments.service.js', () => ({ listEmployeeIdsAssignedToDepartmentPeriod: vi.fn() }));
vi.mock('../socket/io-instance.js', () => ({ getIo: () => null }));

const { salaryRaiseController } = await import('./salary-raise.controller.js');

const call = async (q: string) => {
  const res = {
    body: null as unknown as { data: Array<{ employee_id: number }> },
    status() { return res; },
    json(body: unknown) { res.body = body as typeof res.body; return res; },
  };
  await salaryRaiseController.getCandidates({ query: { q }, user: { id: 'u', employee_id: 1 } } as unknown as AuthenticatedRequest, res as unknown as Response);
  return res.body.data.map(row => row.employee_id);
};

const searchCalls = () => h.query.mock.calls.filter(([sql]) => String(sql).includes('id = ANY($1::int[])'));

beforeEach(() => {
  h.query.mockReset();
});

describe('salaryRaiseController.getCandidates', () => {
  it('точного нет в скоупе — второй запрос с одной ошибкой; скоуп — внутри запроса', async () => {
    h.query.mockImplementation(async (sql: string) => {
      if (String(sql).startsWith('SELECT id FROM employees')) return [{ id: 7 }, { id: 8 }];
      if (String(sql).includes('unnest(')) return [{ id: 7, full_name: 'Гринёв', position_id: null, org_department_id: null }];
      return [];
    });
    expect(await call('грнев')).toEqual([7]);
    const [exactSql, exactParams] = searchCalls()[0] as [string, unknown[]];
    expect(exactSql).toContain('AND (full_name ~* $2)');
    expect(exactParams).toEqual([[7, 8], 'грн[её]в']);
    expect(searchCalls()).toHaveLength(2);
  });

  it('без поиска — без условия ФИО', async () => {
    h.query.mockImplementation(async (sql: string) => (String(sql).startsWith('SELECT id FROM employees') ? [{ id: 7 }] : []));
    await call('');
    expect(searchCalls()).toHaveLength(1);
    expect(String(searchCalls()[0][0])).not.toContain('~*');
  });
});
