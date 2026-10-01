import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Уровень назначения «заместитель начальника отдела» (access_level='deputy', миграция 283).
 *
 * Ключевые инварианты, которые здесь закрепляются:
 *  - начальник отдела везде остаётся строго 'full' — заместитель не уходит в 1С,
 *    в маршруты согласований и в «начальника участка» экспортов;
 *  - табель отдела заместитель ведёт: он владелец подачи и попадает в timesheet-скоуп;
 *  - нетабельные записи (кадры, документы, графики) по deputy-отделу закрыты.
 */

const { pgQuery } = vi.hoisted(() => ({ pgQuery: vi.fn() }));
vi.mock('../config/postgres.js', () => ({ query: pgQuery }));

const { hasPageEditMock } = vi.hoisted(() => ({ hasPageEditMock: vi.fn(async () => true) }));
vi.mock('./access-control.service.js', () => ({ hasPageEdit: hasPageEditMock }));

const {
  listAssignedDepartmentDeputies,
  listDepartmentManagers,
  listDepartmentTimesheetOwners,
  DEPARTMENT_MANAGER_CONDITION_SQL,
} = await import('./department-managers.service.js');
const { SUPERVISOR_IDS_SQL_FOR_TESTS } = await import('../controllers/timesheet-assigned-export.controller.js');

const DEPT = '0b24809e-5f04-45e1-bbe2-8a82990d6bdd';

beforeEach(() => {
  vi.clearAllMocks();
  hasPageEditMock.mockResolvedValue(true);
  pgQuery.mockResolvedValue([]);
});

describe('начальник отдела — только full', () => {
  it('listDepartmentManagers не видит заместителя: условие отбора требует access_level = full', async () => {
    expect(DEPARTMENT_MANAGER_CONDITION_SQL).toContain("access_level = 'full'");
    await listDepartmentManagers([DEPT]);
    expect(String(pgQuery.mock.calls[0]![0])).toContain("access_level = 'full'");
  });

  it('строка «Начальник участка» бригады (в т.ч. exempt-список 1С) тоже требует full', () => {
    // Без этого фильтра заместитель на бригаде стал бы начальником участка и
    // остался бы в выгрузке для 1С даже без проходов.
    expect(SUPERVISOR_IDS_SQL_FOR_TESTS()).toContain("access_level = 'full'");
  });
});

describe('listDepartmentTimesheetOwners', () => {
  it('добавляет к начальникам активных заместителей — отдел с одним замом покрыт', async () => {
    pgQuery
      // эффективные начальники (full + профиль + роль)
      .mockResolvedValueOnce([])
      // заместители
      .mockResolvedValueOnce([{ employee_id: 777, department_id: DEPT }]);

    const owners = await listDepartmentTimesheetOwners([DEPT]);

    expect(owners.get(DEPT)).toEqual([777]);
    expect(String(pgQuery.mock.calls[1]![0])).toContain("access_level = 'deputy'");
  });

  it('заместитель и начальник не дублируются', async () => {
    pgQuery
      .mockResolvedValueOnce([{ employee_id: 501, department_id: DEPT, role_code: 'manager', is_admin: false }])
      .mockResolvedValueOnce([{ employee_id: 501, department_id: DEPT }]);

    const owners = await listDepartmentTimesheetOwners([DEPT]);

    expect(owners.get(DEPT)).toEqual([501]);
  });

  it('уволенный или неодобренный заместитель отдел не покрывает (фильтры в SQL)', async () => {
    await listDepartmentTimesheetOwners([DEPT]);
    const deputySql = String(pgQuery.mock.calls[1]![0]);
    expect(deputySql).toContain('up.is_approved = true');
    expect(deputySql).toContain("e.employment_status = 'active'");
    expect(deputySql).toContain('e.is_archived = false');
  });
});

describe('listAssignedDepartmentDeputies (маршрут заявлений)', () => {
  it('пустой список отделов — без запроса', async () => {
    const res = await listAssignedDepartmentDeputies([]);
    expect(res.size).toBe(0);
    expect(pgQuery).not.toHaveBeenCalled();
  });

  it('id по отделу уникальны и отсортированы', async () => {
    pgQuery.mockResolvedValue([
      { employee_id: '9', department_id: DEPT },
      { employee_id: 3, department_id: DEPT },
      { employee_id: 9, department_id: DEPT },
    ]);
    const res = await listAssignedDepartmentDeputies([DEPT, DEPT]);
    expect(res.get(DEPT)).toEqual([3, 9]);
    expect(pgQuery.mock.calls[0]![1]).toEqual([[DEPT], 'deputy_head']);
  });

  it('только живые ручные заместители и без роли «Заместитель»', async () => {
    await listAssignedDepartmentDeputies([DEPT]);
    const sql = String(pgQuery.mock.calls[0]![0]);
    expect(sql).toContain("eda.access_level = 'deputy'");
    expect(sql).toContain('eda.is_active = true');
    expect(sql).toContain("eda.source <> 'sigur_sync'");
    expect(sql).toContain('up.is_approved = true');
    expect(sql).toContain('e.is_archived = false');
    expect(sql).toContain("e.employment_status = 'active'");
    // Роль «Заместитель» (deputy_head) исключается параметром $2.
    expect(sql).toContain("COALESCE(sr.code, '') <> $2");
  });
});
