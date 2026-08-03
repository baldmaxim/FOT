import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Скоуп табеля для глобального read-флага (view_all_departments, миграция 237):
 * просмотр всей организации, запись не расширяется, «self»-деградации нет.
 */

vi.mock('./data-scope.service.js', () => ({
  hasGlobalDepartmentReadScope: vi.fn().mockResolvedValue(false),
  hasObjectViewScope: vi.fn().mockResolvedValue(false),
  normalizeUuidParam: (value: unknown): string | null => {
    if (value == null || typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed === '' || trimmed === 'null' || trimmed === 'undefined' ? null : trimmed;
  },
  resolveAccessibleDepartmentIds: vi.fn().mockResolvedValue([]),
  resolveAccessibleEmployeeIds: vi.fn().mockResolvedValue(new Set<number>()),
  resolveEditableDepartmentIds: vi.fn().mockResolvedValue([]),
  resolveEffectiveDirectSubordinates: vi.fn().mockResolvedValue([]),
  resolveManagedDepartmentIds: vi.fn().mockResolvedValue([]),
  resolveScopedDepartmentId: vi.fn().mockResolvedValue(null),
}));

vi.mock('./access-control.service.js', () => ({
  hasPageView: vi.fn().mockResolvedValue(false),
  hasPageEdit: vi.fn().mockResolvedValue(false),
}));

vi.mock('./timekeeper-scope.service.js', () => ({
  isTimekeeper: vi.fn().mockReturnValue(false),
  resolveTimekeeperEditableLiIds: vi.fn().mockResolvedValue(new Set<number>()),
  LI_OBSHESTROY_DEPARTMENT_ID: 'li-obshestroy',
}));

vi.mock('./timesheet-department-assignments.service.js', () => ({
  listEmployeeIdsAssignedToDepartmentPeriod: vi.fn().mockResolvedValue([]),
}));

import {
  canAccessEmployeeForTimesheetPeriod,
  filterAdditionalEmployeeIdsForTimesheetPeriod,
  filterEmployeeIdsByTimesheetScope,
  resolveTimesheetReadableDepartmentId,
  resolveTimesheetScope,
} from './timesheet-scope.service.js';
import {
  hasGlobalDepartmentReadScope,
  resolveScopedDepartmentId,
} from './data-scope.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

function buildReq(overrides: Partial<AuthenticatedRequest['user']> = {}): AuthenticatedRequest {
  return {
    user: {
      id: 'user-sec',
      role_code: 'security',
      is_admin: false,
      employee_id: 500,
      department_id: null,
      timesheet_months_back: 1,
      timesheet_months_forward: 1,
      ...overrides,
    },
  } as unknown as AuthenticatedRequest;
}

beforeEach(() => {
  vi.mocked(hasGlobalDepartmentReadScope).mockReset().mockResolvedValue(false);
  vi.mocked(resolveScopedDepartmentId).mockReset().mockResolvedValue(null);
});

describe('resolveTimesheetScope — глобальный read-флаг', () => {
  it("флаг включён → 'department' (не 'all': wide-edit закрыт)", async () => {
    vi.mocked(hasGlobalDepartmentReadScope).mockResolvedValue(true);
    expect(await resolveTimesheetScope(buildReq())).toBe('department');
  });

  it("флаг выключен, назначений нет → 'self' (прежнее поведение)", async () => {
    expect(await resolveTimesheetScope(buildReq())).toBe('self');
  });
});

describe('canAccessEmployeeForTimesheetPeriod — глобальный read-флаг', () => {
  it('чужой сотрудник, requireEdit=false → true (short-circuit до accessible-набора)', async () => {
    vi.mocked(hasGlobalDepartmentReadScope).mockResolvedValue(true);
    const ok = await canAccessEmployeeForTimesheetPeriod(buildReq(), 999, '2026-08-01', '2026-08-15', false);
    expect(ok).toBe(true);
  });

  it('чужой сотрудник, requireEdit=true → false (editable-scope не расширен)', async () => {
    vi.mocked(hasGlobalDepartmentReadScope).mockResolvedValue(true);
    const ok = await canAccessEmployeeForTimesheetPeriod(buildReq(), 999, '2026-08-01', '2026-08-15', true);
    expect(ok).toBe(false);
  });

  it('без флага чужой сотрудник → false', async () => {
    const ok = await canAccessEmployeeForTimesheetPeriod(buildReq(), 999, '2026-08-01', '2026-08-15', false);
    expect(ok).toBe(false);
  });
});

describe('фильтры состава — глобальный read-флаг не срезает ids', () => {
  it('filterEmployeeIdsByTimesheetScope возвращает ids без изменений', async () => {
    vi.mocked(hasGlobalDepartmentReadScope).mockResolvedValue(true);
    const ids = [1, 2, 3];
    expect(await filterEmployeeIdsByTimesheetScope(buildReq(), ids)).toEqual(ids);
  });

  it('filterAdditionalEmployeeIdsForTimesheetPeriod возвращает ids без изменений', async () => {
    vi.mocked(hasGlobalDepartmentReadScope).mockResolvedValue(true);
    const ids = [10, 20];
    const result = await filterAdditionalEmployeeIdsForTimesheetPeriod(buildReq(), ids, '2026-08-01', '2026-08-15');
    expect(result).toEqual(ids);
  });
});

describe('resolveTimesheetReadableDepartmentId', () => {
  it('флаг включён → запрошенный отдел как есть (без resolveScopedDepartmentId)', async () => {
    vi.mocked(hasGlobalDepartmentReadScope).mockResolvedValue(true);
    const result = await resolveTimesheetReadableDepartmentId(buildReq(), 'dept-any');
    expect(result).toBe('dept-any');
    expect(vi.mocked(resolveScopedDepartmentId)).not.toHaveBeenCalled();
  });

  it('флаг выключен → делегирует обычному резолверу (scope=self → null)', async () => {
    const result = await resolveTimesheetReadableDepartmentId(buildReq(), 'dept-any');
    expect(result).toBeNull();
  });
});
