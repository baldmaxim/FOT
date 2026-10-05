import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Правка и удаление записей истории сотрудника («Управление кадрами» → история).
 *
 * «Перевод/Должность» (assignment) — админ и кадровый админ: canManageAsHrAdmin со смены
 * отдела (глобальный скоуп + edit). Откат перевода из истории кадровый админ делает так же,
 * как админ. «Оклад» (salary) — только админ: раздела «Зарплата» у кадрового админа нет.
 */
const h = vi.hoisted(() => ({
  canWriteEmployeeInScope: vi.fn(),
  canManageAsHrAdmin: vi.fn(),
  deleteAssignment: vi.fn(),
  updateAssignment: vi.fn(),
  deleteSalaryHistory: vi.fn(),
  updateSalaryHistory: vi.fn(),
  logFromRequest: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  queryOne: vi.fn(),
  query: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));
vi.mock('../services/access-control.service.js', () => ({
  canManageAsHrAdmin: h.canManageAsHrAdmin,
  resolveRolePageAccess: vi.fn(),
}));
vi.mock('../services/audit.service.js', () => ({
  auditService: { logFromRequest: h.logFromRequest, log: vi.fn() },
}));
vi.mock('../services/audit-context.helpers.js', () => ({ loadEmployeeFullName: vi.fn(async () => 'Шерхонов С. С.') }));
vi.mock('../services/employee-changes.service.js', () => ({
  DomainValidationError: class extends Error {},
  employeeChangesService: {
    deleteAssignment: h.deleteAssignment,
    updateAssignment: h.updateAssignment,
    deleteSalaryHistory: h.deleteSalaryHistory,
    updateSalaryHistory: h.updateSalaryHistory,
  },
}));
vi.mock('../services/employee-mapper.service.js', () => ({
  loadStructureCache: vi.fn(),
  decryptEmployee: (row: unknown) => row,
}));
vi.mock('../services/employee-cache.service.js', () => ({ employeeCache: { invalidate: vi.fn() } }));
vi.mock('../services/employee-archive-department.service.js', () => ({
  isProtectedArchiveDepartment: vi.fn().mockResolvedValue(false),
}));
vi.mock('../services/sigur-linked-employees.service.js', () => ({ syncLinkedEmployeeFromSigur: vi.fn() }));
vi.mock('../services/sigur.service.js', () => ({ sigurService: {} }));
vi.mock('../services/data-scope.service.js', () => ({
  canAccessEmployeeRecordsInScope: vi.fn().mockResolvedValue(true),
  resolveRequestDataScope: vi.fn().mockResolvedValue('all'),
  canWriteEmployeeInScope: h.canWriteEmployeeInScope,
  canWriteDepartmentInScope: vi.fn().mockResolvedValue(true),
}));
vi.mock('../services/employee-department-access.service.js', () => ({ upsertTechnicalDepartmentAccess: vi.fn() }));
vi.mock('../services/realtime-broadcast.service.js', () => ({ emitDomainChange: vi.fn() }));
vi.mock('../services/recipients.service.js', () => ({
  getEmployeeOwnerAndSupervisor: vi.fn().mockResolvedValue([]),
  getUserIdsByEmployeeIds: vi.fn().mockResolvedValue([]),
}));
vi.mock('../services/employee-lifecycle-operations.service.js', () => ({}));

import { deleteHistoryEvent, updateHistoryEvent } from './employee-lifecycle.controller.js';
import type { AuthenticatedRequest } from '../types/index.js';

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status: vi.fn((c: number) => { res.statusCode = c; return res; }),
    json: vi.fn((b: never) => { res.body = b; return res; }),
  };
  return res;
};

const makeReq = (
  isAdmin: boolean,
  eventType: 'salary' | 'assignment',
  method: 'delete' | 'put',
): AuthenticatedRequest => ({
  user: { id: isAdmin ? 'admin-1' : 'hr-admin-1', role_code: isAdmin ? 'admin' : 'hr_admin', is_admin: isAdmin },
  params: { id: '2245', eventId: eventType === 'salary' ? '15' : 'assign-uuid' },
  query: method === 'delete' ? { event_type: eventType } : {},
  body: method === 'put' ? { event_type: eventType, effective_date: '2026-09-01', salary: 100000 } : {},
}) as unknown as AuthenticatedRequest;

beforeEach(() => {
  Object.values(h).forEach(fn => fn.mockReset());
  h.canWriteEmployeeInScope.mockResolvedValue(true);
  h.canManageAsHrAdmin.mockImplementation(async (req: { user: { is_admin?: boolean } }) => !!req.user.is_admin);
  h.deleteAssignment.mockResolvedValue({
    reverted: {
      employee_id: 2245, removed_assignment_id: 'assign-uuid', reopened_assignment_id: 'prev-uuid', restored_department_id: 'd1',
    },
  });
});

describe('история сотрудника: «Перевод/Должность»', () => {
  it('кадровый админ откатывает перевод из истории — как админ, с аудитом', async () => {
    h.canManageAsHrAdmin.mockResolvedValue(true);
    const res = makeRes();

    await deleteHistoryEvent(makeReq(false, 'assignment', 'delete'), res as never);

    expect(h.canManageAsHrAdmin).toHaveBeenCalledWith(expect.anything(), '/staff-control/department');
    expect(res.statusCode).toBe(200);
    expect(h.deleteAssignment).toHaveBeenCalledWith('assign-uuid', 2245);
    expect(h.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'hr-admin-1', 'REVERT_TRANSFER_LOCAL_ONLY', expect.objectContaining({ entityId: '2245' }),
    );
  });

  it('кадровый админ правит запись перевода', async () => {
    h.canManageAsHrAdmin.mockResolvedValue(true);
    const res = makeRes();

    await updateHistoryEvent(makeReq(false, 'assignment', 'put'), res as never);

    expect(res.statusCode).toBe(200);
    expect(h.updateAssignment).toHaveBeenCalledTimes(1);
  });

  it('без права «как админ» (нет глобального скоупа или edit смены отдела) — 403, ничего не трогаем', async () => {
    const res = makeRes();

    await deleteHistoryEvent(makeReq(false, 'assignment', 'delete'), res as never);

    expect(res.statusCode).toBe(403);
    expect(h.deleteAssignment).not.toHaveBeenCalled();
  });

  it('сотрудник вне скоупа записи — 403 до проверки типа записи', async () => {
    h.canWriteEmployeeInScope.mockResolvedValue(false);
    h.canManageAsHrAdmin.mockResolvedValue(true);
    const res = makeRes();

    await deleteHistoryEvent(makeReq(false, 'assignment', 'delete'), res as never);

    expect(res.statusCode).toBe(403);
    expect(h.deleteAssignment).not.toHaveBeenCalled();
  });
});

describe('история сотрудника: «Оклад» — только админ', () => {
  it('кадровый админ не удаляет и не правит оклад — 403', async () => {
    h.canManageAsHrAdmin.mockResolvedValue(true);
    const delRes = makeRes();
    await deleteHistoryEvent(makeReq(false, 'salary', 'delete'), delRes as never);
    expect(delRes.statusCode).toBe(403);

    const putRes = makeRes();
    await updateHistoryEvent(makeReq(false, 'salary', 'put'), putRes as never);
    expect(putRes.statusCode).toBe(403);

    expect(h.deleteSalaryHistory).not.toHaveBeenCalled();
    expect(h.updateSalaryHistory).not.toHaveBeenCalled();
  });

  it('админ удаляет оклад, как раньше', async () => {
    const res = makeRes();

    await deleteHistoryEvent(makeReq(true, 'salary', 'delete'), res as never);

    expect(res.statusCode).toBe(200);
    expect(h.deleteSalaryHistory).toHaveBeenCalledWith(15, 2245);
  });
});
