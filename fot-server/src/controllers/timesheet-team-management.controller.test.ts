import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * Тесты addEmployeeToDepartment — фокус на «возврате из исключения в тот же отдел».
 *
 * Локальные хелперы isTimesheetTeamManagementAvailable / resolveManagedDepartmentId не
 * мокаются (они в том же модуле): доступ открываем через is_admin=true, а целевой отдел —
 * через мок resolveTimesheetScopedDepartmentId (возвращает запрошенный id).
 *
 * changeDepartment здесь замокан, поэтому freeze_history и отсутствие пересечений в
 * employee_assignments — свойства самого changeDepartment + БД-триггера — проверяются в
 * E2E-верификации (см. план), а не в этом unit-тесте. На уровне контроллера мы фиксируем
 * ключевой контракт: forceHistory:true и effective_from прокидываются в changeDepartment.
 */

const {
  pgQueryOne, pgExecute,
  isAssignedMock, moveInternalMock, changeDepartmentMock,
  loadEmployeeRowMock, loadTargetDeptMock,
  resolveScopeMock, resolveScopedDeptMock,
} = vi.hoisted(() => ({
  pgQueryOne: vi.fn(),
  pgExecute: vi.fn(async () => undefined),
  isAssignedMock: vi.fn(async () => false),
  moveInternalMock: vi.fn(async () => 'portal' as const),
  changeDepartmentMock: vi.fn(async () => undefined),
  loadEmployeeRowMock: vi.fn(),
  loadTargetDeptMock: vi.fn(),
  resolveScopeMock: vi.fn(async () => 'all' as const),
  resolveScopedDeptMock: vi.fn(async (_req: unknown, id: string) => id),
}));

vi.mock('../config/postgres.js', () => ({
  query: vi.fn(),
  queryOne: pgQueryOne,
  execute: pgExecute,
  withTransaction: vi.fn(),
}));

vi.mock('../services/timesheet-department-assignments.service.js', () => ({
  formatDateShift: vi.fn((d: string) => d),
  isEmployeeAssignedToDepartmentOnDate: isAssignedMock,
}));

vi.mock('./employee-lifecycle.controller.js', () => ({
  getErrorMessage: (_e: unknown, fallback: string) => fallback,
  getHttpErrorCode: () => null,
  getHttpErrorStatus: () => null,
  loadEmployeeLifecycleRow: loadEmployeeRowMock,
  loadTargetDepartment: loadTargetDeptMock,
  moveEmployeeToDepartmentInternal: moveInternalMock,
}));

vi.mock('../services/employee-changes.service.js', () => ({
  DomainValidationError: class extends Error {},
  employeeChangesService: { changeDepartment: changeDepartmentMock },
}));

vi.mock('./timesheet.controller.js', () => ({
  hasManagedTimesheetAccess: vi.fn(async () => true),
  resolveTimesheetScope: resolveScopeMock,
  resolveTimesheetScopedDepartmentId: resolveScopedDeptMock,
}));

vi.mock('../services/data-scope.service.js', () => ({
  resolveCompanyScope: vi.fn(async () => ({ roots: 'all' })),
}));

vi.mock('../services/timesheet-transfers.service.js', () => ({
  deleteExclusion: vi.fn(), deleteTransfer: vi.fn(), listAllTransfersAndExclusions: vi.fn(),
  listDepartmentTransfers: vi.fn(), loadAssignmentEmployeeId: vi.fn(),
  updateExclusionDate: vi.fn(), updateTransfer: vi.fn(),
}));

vi.mock('../services/audit-context.helpers.js', () => ({
  loadEmployeeFullName: vi.fn(async () => null),
  loadDepartmentName: vi.fn(async () => 'Отдел'),
}));

vi.mock('../services/audit.service.js', () => ({
  auditService: { logFromRequest: vi.fn(async () => undefined) },
}));

vi.mock('../services/employee-cache.service.js', () => ({
  employeeCache: { invalidate: vi.fn() },
}));

vi.mock('../services/access-control.service.js', () => ({
  hasPageEdit: vi.fn(async () => true),
}));

const { timesheetTeamManagementController } = await import('./timesheet-team-management.controller.js');

const SAME_DEPT = '11111111-1111-1111-1111-111111111111';
const OTHER_DEPT = '22222222-2222-2222-2222-222222222222';
const EMP_ID = 718;

const makeReq = (body: Record<string, unknown>): AuthenticatedRequest => ({
  user: { id: 'admin-uuid', is_admin: true, role_code: 'admin' },
  body,
} as unknown as AuthenticatedRequest);

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status: vi.fn(function (this: typeof res, code: number) { this.statusCode = code; return this; }),
    json: vi.fn(function (this: typeof res, payload: unknown) { this.body = payload; return this; }),
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
};

beforeEach(() => {
  vi.clearAllMocks();
  isAssignedMock.mockResolvedValue(false);
  moveInternalMock.mockResolvedValue('portal');
  changeDepartmentMock.mockResolvedValue(undefined);
  resolveScopeMock.mockResolvedValue('all');
  resolveScopedDeptMock.mockImplementation(async (_req: unknown, id: string) => id);
  loadTargetDeptMock.mockImplementation(async (id: string) => ({ id, name: 'Отдел', sigur_department_id: null }));
  pgExecute.mockResolvedValue(undefined);
});

// Хелпер: настроить сотрудника (excluded-флаг + текущий отдел)
const setEmployee = (opts: { excluded: boolean; dept: string; status?: string }) => {
  loadEmployeeRowMock.mockResolvedValue({
    id: EMP_ID,
    org_department_id: opts.dept,
    employment_status: opts.status ?? 'active',
    sigur_employee_id: null,
  });
  // queryOne → excludedFlagRow
  pgQueryOne.mockResolvedValue({ excluded_from_timesheet: opts.excluded });
};

describe('addEmployeeToDepartment — возврат из исключения в тот же отдел', () => {
  it('исключённый + тот же отдел → 200, создаёт сегмент, снимает флаг, без 409', async () => {
    setEmployee({ excluded: true, dept: SAME_DEPT });
    const req = makeReq({ employee_id: EMP_ID, department_id: SAME_DEPT, effective_from: '2026-06-01' });
    const res = makeRes();

    await timesheetTeamManagementController.addEmployeeToDepartment(req, res);

    // 409-проверка пропущена
    expect(isAssignedMock).not.toHaveBeenCalled();
    // сегмент создан через changeDepartment с правильной датой и forceHistory
    expect(changeDepartmentMock).toHaveBeenCalledTimes(1);
    expect(changeDepartmentMock).toHaveBeenCalledWith(
      EMP_ID,
      SAME_DEPT,
      expect.objectContaining({ effectiveDate: '2026-06-01', forceHistory: true, lockDepartment: false }),
    );
    // move-noop-ветка не задействована
    expect(moveInternalMock).not.toHaveBeenCalled();
    // флаг снят
    expect(pgExecute).toHaveBeenCalledTimes(1);
    expect(pgExecute.mock.calls[0][0]).toContain('excluded_from_timesheet = false');
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true });
  });

  it('активный НЕ исключённый + тот же отдел → 409 (прежнее поведение)', async () => {
    setEmployee({ excluded: false, dept: SAME_DEPT });
    isAssignedMock.mockResolvedValue(true); // числится в отделе
    const req = makeReq({ employee_id: EMP_ID, department_id: SAME_DEPT, effective_from: '2026-06-01' });
    const res = makeRes();

    await timesheetTeamManagementController.addEmployeeToDepartment(req, res);

    expect(isAssignedMock).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(409);
    expect(changeDepartmentMock).not.toHaveBeenCalled();
    expect(moveInternalMock).not.toHaveBeenCalled();
    expect(pgExecute).not.toHaveBeenCalled();
  });

  it('возврат в ДРУГОЙ отдел → обычный перевод (move) + снятие флага', async () => {
    setEmployee({ excluded: true, dept: SAME_DEPT });
    isAssignedMock.mockResolvedValue(false); // в другом отделе не числится
    const req = makeReq({ employee_id: EMP_ID, department_id: OTHER_DEPT, effective_from: '2026-06-01' });
    const res = makeRes();

    await timesheetTeamManagementController.addEmployeeToDepartment(req, res);

    // для другого отдела 409-проверка выполняется
    expect(isAssignedMock).toHaveBeenCalledTimes(1);
    expect(moveInternalMock).toHaveBeenCalledTimes(1);
    expect(changeDepartmentMock).not.toHaveBeenCalled();
    expect(pgExecute).toHaveBeenCalledTimes(1); // флаг снят
    expect(res.statusCode).toBe(200);
  });

  it('effective_from прокидывается как есть (эффективная дата ≠ время операции)', async () => {
    setEmployee({ excluded: true, dept: SAME_DEPT });
    const req = makeReq({ employee_id: EMP_ID, department_id: SAME_DEPT, effective_from: '2026-06-30' });
    const res = makeRes();

    await timesheetTeamManagementController.addEmployeeToDepartment(req, res);

    expect(changeDepartmentMock).toHaveBeenCalledWith(
      EMP_ID,
      SAME_DEPT,
      expect.objectContaining({ effectiveDate: '2026-06-30' }),
    );
    expect(res.statusCode).toBe(200);
  });

  it('обычный перевод активного в ДРУГОЙ отдел (не исключён) → move, без снятия флага', async () => {
    setEmployee({ excluded: false, dept: SAME_DEPT });
    isAssignedMock.mockResolvedValue(false);
    const req = makeReq({ employee_id: EMP_ID, department_id: OTHER_DEPT, effective_from: '2026-06-01' });
    const res = makeRes();

    await timesheetTeamManagementController.addEmployeeToDepartment(req, res);

    expect(moveInternalMock).toHaveBeenCalledTimes(1);
    expect(changeDepartmentMock).not.toHaveBeenCalled();
    expect(pgExecute).not.toHaveBeenCalled(); // флаг не трогаем — сотрудник не был исключён
    expect(res.statusCode).toBe(200);
  });

  it('если changeDepartment упал — флаг НЕ снимается (нет «наполовину возвращён»)', async () => {
    setEmployee({ excluded: true, dept: SAME_DEPT });
    changeDepartmentMock.mockRejectedValue(new Error('db fail'));
    const req = makeReq({ employee_id: EMP_ID, department_id: SAME_DEPT, effective_from: '2026-06-01' });
    const res = makeRes();

    await timesheetTeamManagementController.addEmployeeToDepartment(req, res);

    expect(changeDepartmentMock).toHaveBeenCalledTimes(1);
    expect(pgExecute).not.toHaveBeenCalled(); // флаг остался true
    expect(res.statusCode).toBe(500);
  });
});
