import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Гард закрытого табеля на изменении состава отдела. Проверяем не сам SQL замка
 * (он покрыт в timesheet-lock.service.test.ts), а то, что гард стоит ДО перемещения
 * сотрудника и видит оба отдела — исходный и целевой.
 */

const { pgQuery, pgQueryOne, pgExecute } = vi.hoisted(() => ({
  pgQuery: vi.fn(async () => [] as unknown[]),
  pgQueryOne: vi.fn(async () => null as unknown),
  pgExecute: vi.fn(async () => 0),
}));

vi.mock('../config/postgres.js', async (importActual) => ({
  ...(await importActual<typeof import('../config/postgres.js')>()),
  query: pgQuery,
  queryOne: pgQueryOne,
  execute: pgExecute,
}));

const { lockMock } = vi.hoisted(() => ({ lockMock: vi.fn(async () => null as unknown) }));
vi.mock('../services/timesheet-lock.service.js', () => ({
  findApprovalLockForMembershipChange: lockMock,
}));

const { moveMock, lifecycleRowMock, targetDeptMock } = vi.hoisted(() => ({
  moveMock: vi.fn(async () => 'portal' as const),
  lifecycleRowMock: vi.fn(async () => ({
    id: 501, full_name: 'Иванов И.И.', org_department_id: DEPT_OLD, employment_status: 'active',
  } as unknown)),
  targetDeptMock: vi.fn(async () => ({ id: DEPT_NEW, name: 'Бригада 2' } as unknown)),
}));
vi.mock('./employee-lifecycle.controller.js', async (importActual) => ({
  ...(await importActual<typeof import('./employee-lifecycle.controller.js')>()),
  loadEmployeeLifecycleRow: lifecycleRowMock,
  loadTargetDepartment: targetDeptMock,
  moveEmployeeToDepartmentInternal: moveMock,
}));

vi.mock('../services/department-assignability.service.js', () => ({
  loadAssignableTargetDepartment: targetDeptMock,
}));

vi.mock('../services/access-control.service.js', () => ({ hasPageEdit: vi.fn(async () => true) }));

const { assignedOnDateMock } = vi.hoisted(() => ({ assignedOnDateMock: vi.fn(async () => false) }));
vi.mock('../services/timesheet-department-assignments.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/timesheet-department-assignments.service.js')>()),
  isEmployeeAssignedToDepartmentOnDate: assignedOnDateMock,
}));

vi.mock('./timesheet.controller.js', async (importActual) => ({
  ...(await importActual<typeof import('./timesheet.controller.js')>()),
  hasManagedTimesheetAccess: vi.fn(async () => true),
  resolveTimesheetScope: vi.fn(async () => 'department'),
  resolveTimesheetScopedDepartmentId: vi.fn(async () => DEPT_NEW),
}));

vi.mock('../services/audit.service.js', () => ({
  auditService: { logFromRequest: vi.fn(async () => undefined) },
  AUDIT_ACTIONS: {},
}));
vi.mock('../services/employee-cache.service.js', () => ({
  employeeCache: { invalidate: vi.fn() },
}));

import { timesheetTeamManagementController } from './timesheet-team-management.controller.js';
import type { AuthenticatedRequest } from '../types/index.js';
import type { Response } from 'express';

const DEPT_OLD = '11111111-1111-4111-8111-111111111111';
const DEPT_NEW = '22222222-2222-4222-8222-222222222222';

const makeRes = (): Response & { _status: number; _json: unknown } => {
  const res = {
    _status: 200,
    _json: undefined as unknown,
    status(code: number) { this._status = code; return this; },
    json(payload: unknown) { this._json = payload; return this; },
  };
  return res as unknown as Response & { _status: number; _json: unknown };
};

const makeReq = (isAdmin = false): AuthenticatedRequest => ({
  params: {},
  query: {},
  body: { employee_id: 501, department_id: DEPT_NEW, effective_from: '2026-06-05' },
  user: { id: 'user-uuid', employee_id: 7, is_admin: isAdmin, role_code: 'manager' },
} as unknown as AuthenticatedRequest);

beforeEach(() => {
  vi.clearAllMocks();
  lockMock.mockResolvedValue(null);
  lifecycleRowMock.mockResolvedValue({
    id: 501, full_name: 'Иванов И.И.', org_department_id: DEPT_OLD, employment_status: 'active',
  });
  targetDeptMock.mockResolvedValue({ id: DEPT_NEW, name: 'Бригада 2' });
  assignedOnDateMock.mockResolvedValue(false);
  moveMock.mockResolvedValue('portal');
  pgQueryOne.mockResolvedValue({ excluded_from_timesheet: false });
});

describe('addEmployeeToDepartment — гард закрытого табеля', () => {
  it('409 и НИ ОДНОГО перемещения, если период закрыт', async () => {
    lockMock.mockResolvedValue({ id: 5, start_date: '2026-06-01', end_date: '2026-06-15', status: 'approved' });
    const res = makeRes();

    await timesheetTeamManagementController.addEmployeeToDepartment(makeReq(), res);

    expect(res._status).toBe(409);
    expect((res._json as { error: string }).error).toContain('Редактирование закрыто');
    // Ключевое: гард сработал ДО перемещения.
    expect(moveMock).not.toHaveBeenCalled();
  });

  it('проверяет исходный И целевой отдел на весь интервал от даты', async () => {
    const res = makeRes();

    await timesheetTeamManagementController.addEmployeeToDepartment(makeReq(), res);

    expect(lockMock).toHaveBeenCalledWith({
      employeeId: 501,
      departmentIds: [DEPT_OLD, DEPT_NEW],
      fromDate: '2026-06-05',
    });
  });

  it('админ гард ПРОХОДИТ наравне со всеми — состав закрытого табеля не меняет', async () => {
    // Раньше is_admin проходил насквозь, и это молча переигрывало уже сданный период:
    // от членства и excluded_from_timesheet_date зависят cutoff-дни в содержимом табеля.
    lockMock.mockResolvedValue({ id: 5, start_date: '2026-06-01', end_date: '2026-06-15', status: 'approved' });
    const res = makeRes();

    await timesheetTeamManagementController.addEmployeeToDepartment(makeReq(true), res);

    expect(lockMock).toHaveBeenCalledTimes(1);
    expect(res._status).toBe(409);
    expect(moveMock).not.toHaveBeenCalled();
  });

  it('админу в тексте 409 подсказан штатный путь — «Открыть табель»', async () => {
    lockMock.mockResolvedValue({ id: 5, start_date: '2026-06-01', end_date: '2026-06-15', status: 'approved' });
    const res = makeRes();

    await timesheetTeamManagementController.addEmployeeToDepartment(makeReq(true), res);

    const payload = res._json as { error: string; code: string };
    expect(payload.code).toBe('TIMESHEET_PERIOD_CLOSED');
    expect(payload.error).toContain('Открыть табель');
  });

  it('руководителю подсказку про кнопку не показываем — её у него нет', async () => {
    lockMock.mockResolvedValue({ id: 5, start_date: '2026-06-01', end_date: '2026-06-15', status: 'approved' });
    const res = makeRes();

    await timesheetTeamManagementController.addEmployeeToDepartment(makeReq(false), res);

    expect((res._json as { error: string }).error).not.toContain('Открыть табель');
  });
});
