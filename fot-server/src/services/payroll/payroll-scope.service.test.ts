import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../../types/index.js';

/**
 * Охват «Зарплаты»: персональный грант (миграция 288) открывает не-админу весь штат, свои
 * условия оплаты не-админ не правит, а админ компании с оставшимся грантом не выходит
 * за свою компанию.
 */

const h = vi.hoisted(() => ({
  grant: vi.fn(async (): Promise<'view' | 'edit' | null> => null),
  resolveAccessibleDepartmentIds: vi.fn(async (): Promise<string[] | 'all'> => ['own-dept']),
  canAccessEmployeeInScope: vi.fn(async () => false),
  canEditEmployeeInScope: vi.fn(async () => false),
  resolveEditableEmployeeIds: vi.fn(async (): Promise<Set<number> | 'all'> => new Set<number>()),
}));

vi.mock('./payroll-access.service.js', () => ({ getRequestPayrollAccessLevel: h.grant }));
vi.mock('../data-scope.service.js', () => ({
  resolveAccessibleDepartmentIds: h.resolveAccessibleDepartmentIds,
  canAccessEmployeeInScope: h.canAccessEmployeeInScope,
  canEditEmployeeInScope: h.canEditEmployeeInScope,
  resolveEditableEmployeeIds: h.resolveEditableEmployeeIds,
}));

import {
  canEditPayrollEmployee,
  canReadPayrollEmployee,
  resolvePayrollEditPredicate,
  resolvePayrollReadableDepartmentIds,
} from './payroll-scope.service.js';

const SELF = 501;
const OTHER = 777;

const makeReq = (isAdmin = false): AuthenticatedRequest => ({
  user: { id: 'u1', employee_id: SELF, role_code: isAdmin ? 'admin' : 'office', is_admin: isAdmin },
} as unknown as AuthenticatedRequest);

beforeEach(() => {
  vi.clearAllMocks();
  h.grant.mockResolvedValue(null);
  h.resolveAccessibleDepartmentIds.mockResolvedValue(['own-dept']);
  h.canAccessEmployeeInScope.mockResolvedValue(false);
  h.canEditEmployeeInScope.mockResolvedValue(false);
  h.resolveEditableEmployeeIds.mockResolvedValue(new Set<number>());
});

describe('персональный грант: весь штат', () => {
  it('«Просмотр» — список по всему штату и карточка любого сотрудника', async () => {
    h.grant.mockResolvedValue('view');
    const req = makeReq();

    await expect(resolvePayrollReadableDepartmentIds(req)).resolves.toBe('all');
    await expect(canReadPayrollEmployee(req, OTHER)).resolves.toBe(true);
    expect(h.resolveAccessibleDepartmentIds).not.toHaveBeenCalled();
  });

  it('«Просмотр» правку не даёт: решает обычный скоуп (здесь пустой)', async () => {
    h.grant.mockResolvedValue('view');
    const req = makeReq();

    await expect(canEditPayrollEmployee(req, OTHER)).resolves.toBe(false);
    const canEditRow = await resolvePayrollEditPredicate(req);
    expect(canEditRow(OTHER)).toBe(false);
  });

  it('«Редактирование» — правка любого сотрудника, кроме себя', async () => {
    h.grant.mockResolvedValue('edit');
    const req = makeReq();

    await expect(canEditPayrollEmployee(req, OTHER)).resolves.toBe(true);
    await expect(canEditPayrollEmployee(req, SELF)).resolves.toBe(false);
    const canEditRow = await resolvePayrollEditPredicate(req);
    expect(canEditRow(OTHER)).toBe(true);
    expect(canEditRow(SELF)).toBe(false);
  });
});

describe('без гранта — как раньше, но без правки себя', () => {
  it('список и карточки — по отделам пользователя', async () => {
    h.canAccessEmployeeInScope.mockResolvedValue(true);
    const req = makeReq();

    await expect(resolvePayrollReadableDepartmentIds(req)).resolves.toEqual(['own-dept']);
    await expect(canReadPayrollEmployee(req, OTHER)).resolves.toBe(true);
    expect(h.canAccessEmployeeInScope).toHaveBeenCalledWith(req, OTHER);
  });

  it('свою запись не-админ не правит, даже если скоуп её пропускает', async () => {
    h.canEditEmployeeInScope.mockResolvedValue(true);
    h.resolveEditableEmployeeIds.mockResolvedValue('all');
    const req = makeReq();

    await expect(canEditPayrollEmployee(req, SELF)).resolves.toBe(false);
    await expect(canEditPayrollEmployee(req, OTHER)).resolves.toBe(true);
    const canEditRow = await resolvePayrollEditPredicate(req);
    expect(canEditRow(SELF)).toBe(false);
    expect(canEditRow(OTHER)).toBe(true);
  });
});

describe('администратор', () => {
  it('админ компании с оставшимся грантом не выходит за свою компанию', async () => {
    h.grant.mockResolvedValue('edit');
    h.resolveAccessibleDepartmentIds.mockResolvedValue(['company-dept']);
    const req = makeReq(true);

    await expect(resolvePayrollReadableDepartmentIds(req)).resolves.toEqual(['company-dept']);
    await expect(canReadPayrollEmployee(req, OTHER)).resolves.toBe(false);
    await expect(canEditPayrollEmployee(req, OTHER)).resolves.toBe(false);
    expect(h.grant).not.toHaveBeenCalled();
  });

  it('системный админ правит и свою запись — как раньше', async () => {
    h.resolveAccessibleDepartmentIds.mockResolvedValue('all');
    h.canEditEmployeeInScope.mockResolvedValue(true);
    h.resolveEditableEmployeeIds.mockResolvedValue('all');
    const req = makeReq(true);

    await expect(resolvePayrollReadableDepartmentIds(req)).resolves.toBe('all');
    await expect(canEditPayrollEmployee(req, SELF)).resolves.toBe(true);
    const canEditRow = await resolvePayrollEditPredicate(req);
    expect(canEditRow(SELF)).toBe(true);
  });
});
