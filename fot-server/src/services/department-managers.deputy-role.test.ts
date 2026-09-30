import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Владельцы табеля и роль «Заместитель» (deputy_head, миграция 292).
 *
 * Ручные deputy роли убраны из общей выборки (там владелец без проверки галочки), а её
 * заместительские отделы по правилу А идут отдельным набором и считаются владением только
 * при эффективной «Табель → правка». Иначе при снятой галочке дни отдела «держал» бы тот,
 * кто не может их подать, и личная подача руководителя их бы не взяла.
 */

const { pgQuery } = vi.hoisted(() => ({ pgQuery: vi.fn() }));
vi.mock('../config/postgres.js', () => ({ query: pgQuery }));

const { hasPageEditMock, adminAccessMock } = vi.hoisted(() => ({
  hasPageEditMock: vi.fn(async () => true),
  adminAccessMock: vi.fn(async () => true),
}));
vi.mock('./access-control.service.js', () => ({
  hasPageEdit: hasPageEditMock,
  roleHasAdminAccess: adminAccessMock,
}));

const { listDepartmentTimesheetOwners } = await import('./department-managers.service.js');

const DEPT = '0b24809e-5f04-45e1-bbe2-8a82990d6bdd';
const ROLE_DEPUTY = 900;

beforeEach(() => {
  vi.clearAllMocks();
  hasPageEditMock.mockResolvedValue(true);
  adminAccessMock.mockResolvedValue(true);
  pgQuery.mockResolvedValue([]);
});

const withOwnerRows = (rows: Array<{ employee_id: number; department_id: string; via_role: boolean }>): void => {
  pgQuery
    .mockResolvedValueOnce([]) // эффективные начальники (full)
    .mockResolvedValueOnce(rows); // ручные deputy (не роль) ∪ отделы роли по правилу А
};

describe('владельцы табеля по роли', () => {
  it('с галочкой «Табель → правка» заместитель по роли — владелец отдела', async () => {
    withOwnerRows([{ employee_id: ROLE_DEPUTY, department_id: DEPT, via_role: true }]);
    const owners = await listDepartmentTimesheetOwners([DEPT]);
    expect(owners.get(DEPT)).toEqual([ROLE_DEPUTY]);
    expect(hasPageEditMock).toHaveBeenCalledWith('deputy_head', '/timesheet');
  });

  it('без «Табель → правка» — не владелец: дни остаются личной подаче или начальнику', async () => {
    hasPageEditMock.mockResolvedValue(false);
    withOwnerRows([{ employee_id: ROLE_DEPUTY, department_id: DEPT, via_role: true }]);
    const owners = await listDepartmentTimesheetOwners([DEPT]);
    expect(owners.get(DEPT)).toBeUndefined();
  });

  it('без «Доступа в админку» — не владелец', async () => {
    adminAccessMock.mockResolvedValue(false);
    withOwnerRows([{ employee_id: ROLE_DEPUTY, department_id: DEPT, via_role: true }]);
    const owners = await listDepartmentTimesheetOwners([DEPT]);
    expect(owners.get(DEPT)).toBeUndefined();
  });

  it('галочка роли не влияет на ручных заместителей других ролей', async () => {
    hasPageEditMock.mockResolvedValue(false);
    withOwnerRows([{ employee_id: 777, department_id: DEPT, via_role: false }]);
    const owners = await listDepartmentTimesheetOwners([DEPT]);
    expect(owners.get(DEPT)).toEqual([777]);
    expect(adminAccessMock).not.toHaveBeenCalled();
  });

  it('дубль (ручное назначение + роль) схлопывается', async () => {
    withOwnerRows([
      { employee_id: ROLE_DEPUTY, department_id: DEPT, via_role: true },
      { employee_id: ROLE_DEPUTY, department_id: DEPT, via_role: true },
    ]);
    const owners = await listDepartmentTimesheetOwners([DEPT]);
    expect(owners.get(DEPT)).toEqual([ROLE_DEPUTY]);
  });

  it('SQL: общая выборка исключает роль, набор роли — по правилу А и живым учёткам', async () => {
    await listDepartmentTimesheetOwners([DEPT]);
    const [sql, params] = pgQuery.mock.calls[1]!;
    const text = String(sql);
    expect(params).toEqual([[DEPT], 'deputy_head']);
    expect(text).toContain("COALESCE(sr.code, '') <> $2");
    // Правило А: лист, не «Уволенные», без владельца выше.
    expect(text).toContain('k.parent_id = f.department_id');
    expect(text).toContain('archive_tree');
    expect(text).toContain("o.access_level IN ('full', 'deputy')");
    // Держатель роли: активная роль, одобренный профиль, учётка не отключена.
    expect(text).toContain('sr.is_active = true');
    expect(text).toContain('COALESCE(au.is_disabled, false) = false');
    expect(text).toContain('c.department_id = ANY($1::uuid[])');
  });
});
