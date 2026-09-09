import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * Доступ к разделу «Переводы и исключения» (canManageTransfers).
 *
 * Ручки правят членство в отделах напрямую и НЕ фильтруют выборку по скоупу,
 * поэтому доступ требует ДВУХ условий сразу: глобального скоупа данных роли
 * (all_departments_scope) и ключа страницы /admin/timesheet-transfers.
 * Каждая страховка проверяется отдельно — ни ключ без скоупа, ни скоуп без
 * ключа раздел открывать не должны.
 */
const h = vi.hoisted(() => ({
  resolveCompanyScope: vi.fn(),
  hasAllDepartmentsScope: vi.fn(),
  resolveEffectivePageAccess: vi.fn(),
  listAllTransfersAndExclusions: vi.fn(),
  listDepartmentTransfers: vi.fn(),
  updateTransfer: vi.fn(),
  deleteTransfer: vi.fn(),
  updateExclusionDate: vi.fn(),
  deleteExclusion: vi.fn(),
  loadAssignmentEmployeeId: vi.fn(),
  loadAssignmentLockContext: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(async () => null),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));
vi.mock('../services/data-scope.service.js', () => ({
  resolveCompanyScope: h.resolveCompanyScope,
  hasAllDepartmentsScope: h.hasAllDepartmentsScope,
}));
vi.mock('../services/access-control.service.js', () => ({
  hasPageEdit: vi.fn(async () => false),
  resolveEffectivePageAccess: h.resolveEffectivePageAccess,
}));
vi.mock('../services/timesheet-transfers.service.js', () => ({
  listAllTransfersAndExclusions: h.listAllTransfersAndExclusions,
  listDepartmentTransfers: h.listDepartmentTransfers,
  updateTransfer: h.updateTransfer,
  deleteTransfer: h.deleteTransfer,
  updateExclusionDate: h.updateExclusionDate,
  deleteExclusion: h.deleteExclusion,
  loadAssignmentEmployeeId: h.loadAssignmentEmployeeId,
  loadAssignmentLockContext: h.loadAssignmentLockContext,
}));
vi.mock('../services/timesheet-lock.service.js', () => ({
  findApprovalLockForMembershipChange: vi.fn(async () => null),
}));
vi.mock('./timesheet.controller.js', () => ({
  hasManagedTimesheetAccess: vi.fn(async () => true),
  resolveTimesheetScope: vi.fn(async () => 'all'),
  resolveTimesheetScopedDepartmentId: vi.fn(async (_r: unknown, id: string) => id),
}));
vi.mock('../services/timesheet-department-assignments.service.js', () => ({
  formatDateShift: vi.fn((d: string) => d),
  isEmployeeAssignedToDepartmentOnDate: vi.fn(async () => false),
}));
vi.mock('./employee-lifecycle.controller.js', () => ({
  getErrorMessage: (_e: unknown, fallback: string) => fallback,
  getHttpErrorCode: () => null,
  getHttpErrorStatus: () => null,
  loadEmployeeLifecycleRow: vi.fn(),
  loadTargetDepartment: vi.fn(),
  moveEmployeeToDepartmentInternal: vi.fn(),
}));
vi.mock('../services/department-assignability.service.js', () => ({
  loadAssignableTargetDepartment: vi.fn(),
}));
vi.mock('../services/employee-changes.service.js', () => ({
  DomainValidationError: class extends Error {},
  employeeChangesService: { changeDepartment: vi.fn() },
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

const { timesheetTeamManagementController: tm } = await import('./timesheet-team-management.controller.js');

const ASSIGNMENT_ID = '33333333-3333-3333-3333-333333333333';

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status: vi.fn(function (this: typeof res, code: number) { this.statusCode = code; return this; }),
    json: vi.fn(function (this: typeof res, payload: unknown) { this.body = payload; return this; }),
  };
  return res;
};

const makeReq = (user: Record<string, unknown>): AuthenticatedRequest => ({
  user: { id: 'u-1', ...user },
  params: { assignmentId: ASSIGNMENT_ID, employeeId: '718' },
  query: {},
  body: { effective_from: '2026-09-01', effective_date: '2026-09-01', assignment_old_id: ASSIGNMENT_ID },
  ip: '127.0.0.1',
  headers: {},
  socket: {},
}) as unknown as AuthenticatedRequest;

const SYSTEM_ADMIN = { is_admin: true, role_code: 'admin' };
const COMPANY_ADMIN = { is_admin: true, role_code: 'admin' };
const HR_ADMIN = { is_admin: false, role_code: 'hr_admin' };

/** Все шесть ручек раздела: две на чтение, четыре на запись. */
const READ_HANDLERS = [
  ['listAdminTransfers', () => tm.listAdminTransfers],
  ['listTransfers', () => tm.listTransfers],
] as const;
const WRITE_HANDLERS = [
  ['patchTransfer', () => tm.patchTransfer],
  ['deleteTransferEntry', () => tm.deleteTransferEntry],
  ['patchExclusion', () => tm.patchExclusion],
  ['deleteExclusionEntry', () => tm.deleteExclusionEntry],
] as const;
const ALL_HANDLERS = [...READ_HANDLERS, ...WRITE_HANDLERS];

const callAll = async (user: Record<string, unknown>) => {
  const codes: Record<string, number> = {};
  for (const [name, get] of ALL_HANDLERS) {
    const res = makeRes();
    await get().call(tm, makeReq(user), res as never);
    codes[name] = res.statusCode;
  }
  return codes;
};

beforeEach(() => {
  vi.clearAllMocks();
  h.resolveCompanyScope.mockResolvedValue({ roots: 'all' });
  h.hasAllDepartmentsScope.mockResolvedValue(false);
  h.resolveEffectivePageAccess.mockResolvedValue(false);
  h.listAllTransfersAndExclusions.mockResolvedValue({ transfers: [], exclusions: [] });
  h.listDepartmentTransfers.mockResolvedValue([]);
  h.loadAssignmentLockContext.mockResolvedValue(null);
  h.loadAssignmentEmployeeId.mockResolvedValue(718);
  h.updateTransfer.mockResolvedValue({ employee_id: 718, changed: true });
  h.deleteTransfer.mockResolvedValue({ employee_id: 718 });
  h.updateExclusionDate.mockResolvedValue({ excluded_from_timesheet_date: '2026-09-01' });
  h.deleteExclusion.mockResolvedValue({ employee_id: 718 });
});

describe('системный админ — поведение не изменилось', () => {
  it('проходит все шесть ручек без единого ключа страницы', async () => {
    const codes = await callAll(SYSTEM_ADMIN);
    for (const [name] of ALL_HANDLERS) expect(codes[name], name).not.toBe(403);
    // Ключи и скоуп для него вообще не спрашиваются.
    expect(h.resolveEffectivePageAccess).not.toHaveBeenCalled();
    expect(h.hasAllDepartmentsScope).not.toHaveBeenCalled();
  });
});

describe('админ компании — по-прежнему без доступа', () => {
  it('403 на всех шести, даже если page-access открыт', async () => {
    h.resolveCompanyScope.mockResolvedValue({ roots: ['root-1'] });
    h.resolveEffectivePageAccess.mockResolvedValue(true);
    h.hasAllDepartmentsScope.mockResolvedValue(true);
    const codes = await callAll(COMPANY_ADMIN);
    for (const [name] of ALL_HANDLERS) expect(codes[name], name).toBe(403);
  });
});

describe('кадровый админ — нужны и скоуп, и ключ', () => {
  beforeEach(() => {
    // Не системный админ: company-scope пустой.
    h.resolveCompanyScope.mockResolvedValue({ roots: [] });
  });

  it('скоуп + ключ edit → проходит и чтение, и запись', async () => {
    h.hasAllDepartmentsScope.mockResolvedValue(true);
    h.resolveEffectivePageAccess.mockResolvedValue(true);
    const codes = await callAll(HR_ADMIN);
    for (const [name] of ALL_HANDLERS) expect(codes[name], name).not.toBe(403);
  });

  it('ключ только на view → список отдаётся, запись 403', async () => {
    h.hasAllDepartmentsScope.mockResolvedValue(true);
    h.resolveEffectivePageAccess.mockImplementation(
      async (_req: unknown, _page: string, action: string) => action === 'view',
    );
    const codes = await callAll(HR_ADMIN);
    for (const [name] of READ_HANDLERS) expect(codes[name], name).not.toBe(403);
    for (const [name] of WRITE_HANDLERS) expect(codes[name], name).toBe(403);
  });

  it('ключ есть, глобального скоупа нет → 403 на всех шести', async () => {
    h.hasAllDepartmentsScope.mockResolvedValue(false);
    h.resolveEffectivePageAccess.mockResolvedValue(true);
    const codes = await callAll(HR_ADMIN);
    for (const [name] of ALL_HANDLERS) expect(codes[name], name).toBe(403);
  });

  it('скоуп есть, ключа нет → 403 на всех шести', async () => {
    h.hasAllDepartmentsScope.mockResolvedValue(true);
    h.resolveEffectivePageAccess.mockResolvedValue(false);
    const codes = await callAll(HR_ADMIN);
    for (const [name] of ALL_HANDLERS) expect(codes[name], name).toBe(403);
  });

  it('проверяется именно ключ раздела «Переводы и исключения»', async () => {
    h.hasAllDepartmentsScope.mockResolvedValue(true);
    h.resolveEffectivePageAccess.mockResolvedValue(true);
    const res = makeRes();
    await tm.listAdminTransfers(makeReq(HR_ADMIN), res as never);
    expect(h.resolveEffectivePageAccess).toHaveBeenCalledWith(
      expect.anything(), '/admin/timesheet-transfers', 'view',
    );
  });
});
