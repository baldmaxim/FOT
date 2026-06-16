import { beforeEach, describe, expect, it, vi } from 'vitest';

// Мокаем источники данных resolvePersonalSubmissionContext: pg-query (выборка
// активных сотрудников) и list прямых подчинённых.
const { pgQuery } = vi.hoisted(() => ({ pgQuery: vi.fn() }));
vi.mock('../config/postgres.js', async (importActual) => ({
  ...(await importActual<typeof import('../config/postgres.js')>()),
  query: pgQuery,
}));

const { listDirectSubordinatesMock } = vi.hoisted(() => ({ listDirectSubordinatesMock: vi.fn() }));
vi.mock('../services/employee-direct-reports.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/employee-direct-reports.service.js')>()),
  listDirectSubordinates: listDirectSubordinatesMock,
}));

import { resolvePersonalSubmissionContext } from './timesheet-approval.controller.js';
import type { AuthenticatedRequest } from '../types/index.js';

const MANAGER = 233;
const SUB_A = 501;
const SUB_B = 502;

const makeReq = (employeeId: number | null): AuthenticatedRequest =>
  ({ user: { employee_id: employeeId } } as unknown as AuthenticatedRequest);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolvePersonalSubmissionContext — состав персональной подачи', () => {
  it('включает самого руководителя вместе с активными подчинёнными', async () => {
    listDirectSubordinatesMock.mockResolvedValue([SUB_A, SUB_B]);
    pgQuery.mockResolvedValue([
      { id: MANAGER, org_department_id: 'DM' },
      { id: SUB_A, org_department_id: 'D1' },
      { id: SUB_B, org_department_id: 'D1' },
    ]);

    const ctx = await resolvePersonalSubmissionContext(makeReq(MANAGER));

    expect(ctx).not.toBeNull();
    expect(ctx?.managerEmployeeId).toBe(MANAGER);
    // Руководитель присутствует ровно один раз.
    expect(ctx?.employeeIds.filter(id => id === MANAGER)).toEqual([MANAGER]);
    expect(ctx?.employeeIds).toEqual(expect.arrayContaining([MANAGER, SUB_A, SUB_B]));
    // Кандидаты переданы в query без дублей: руководитель + подчинённые.
    expect(pgQuery.mock.calls[0][1]).toEqual([[MANAGER, SUB_A, SUB_B]]);
  });

  it('если руководитель неактивен (нет в выборке) — состав без него, не падает', async () => {
    listDirectSubordinatesMock.mockResolvedValue([SUB_A]);
    pgQuery.mockResolvedValue([{ id: SUB_A, org_department_id: 'D1' }]);

    const ctx = await resolvePersonalSubmissionContext(makeReq(MANAGER));

    expect(ctx?.employeeIds).toEqual([SUB_A]);
  });

  it('нет employee_id → null (query не вызывается)', async () => {
    const ctx = await resolvePersonalSubmissionContext(makeReq(null));
    expect(ctx).toBeNull();
    expect(listDirectSubordinatesMock).not.toHaveBeenCalled();
  });

  it('нет подчинённых → null', async () => {
    listDirectSubordinatesMock.mockResolvedValue([]);
    const ctx = await resolvePersonalSubmissionContext(makeReq(MANAGER));
    expect(ctx).toBeNull();
    expect(pgQuery).not.toHaveBeenCalled();
  });
});
