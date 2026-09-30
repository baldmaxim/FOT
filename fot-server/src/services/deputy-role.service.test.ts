import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * Листовой модуль роли «Заместитель» (миграция 292): резолвер отделов по правилу А и
 * проверка топологии ручных назначений «Заместитель».
 */

const { pgQuery } = vi.hoisted(() => ({ pgQuery: vi.fn() }));
vi.mock('../config/postgres.js', () => ({ query: pgQuery }));

const {
  DEPUTY_ROLE_CODE,
  isDeputyRole,
  resolveDeputyHeadDepartmentIds,
  loadDeputyHeadDepartmentIds,
  findDeputyTopologyViolations,
  formatDeputyTopologyError,
} = await import('./deputy-role.service.js');

const DEPT_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const DEPT_B = 'bbbbbbbb-0000-4000-8000-000000000002';

const makeReq = (roleCode: string, employeeId: number | null = 441): AuthenticatedRequest => ({
  user: { id: 'u1', employee_id: employeeId, role_code: roleCode, is_admin: false },
} as unknown as AuthenticatedRequest);

beforeEach(() => {
  vi.clearAllMocks();
  pgQuery.mockResolvedValue([]);
});

describe('резолвер отделов роли', () => {
  it('код роли', () => {
    expect(DEPUTY_ROLE_CODE).toBe('deputy_head');
    expect(isDeputyRole('deputy_head')).toBe(true);
    expect(isDeputyRole('office')).toBe(false);
    expect(isDeputyRole(null)).toBe(false);
  });

  it('другие роли — без запроса в БД', async () => {
    await expect(resolveDeputyHeadDepartmentIds(makeReq('office'))).resolves.toEqual([]);
    expect(pgQuery).not.toHaveBeenCalled();
  });

  it('роль — один запрос на HTTP-запрос, отделы без дублей', async () => {
    pgQuery.mockResolvedValue([{ department_id: DEPT_A }, { department_id: DEPT_B }, { department_id: DEPT_A }]);
    const req = makeReq('deputy_head');
    await expect(resolveDeputyHeadDepartmentIds(req)).resolves.toEqual([DEPT_A, DEPT_B]);
    await expect(resolveDeputyHeadDepartmentIds(req)).resolves.toEqual([DEPT_A, DEPT_B]);
    expect(pgQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = pgQuery.mock.calls[0]!;
    expect(params).toEqual(['deputy_head', 441]);
    // Кандидаты — свой отдел и ручные deputy; отдел читается из БД, не из токена.
    expect(String(sql)).toContain('h.org_department_id AS department_id');
    expect(String(sql)).toContain("eda.access_level = 'deputy'");
    expect(String(sql)).toContain('e.id = $2::bigint');
  });

  it('без карточки сотрудника — пусто', async () => {
    await expect(resolveDeputyHeadDepartmentIds(makeReq('deputy_head', null))).resolves.toEqual([]);
    await expect(loadDeputyHeadDepartmentIds(0)).resolves.toEqual([]);
    expect(pgQuery).not.toHaveBeenCalled();
  });
});

describe('проверка топологии ручных назначений', () => {
  it('нечего проверять — без запроса', async () => {
    await expect(findDeputyTopologyViolations({
      employeeId: 1, checkDepartmentIds: [], finalOwnedDepartmentIds: [DEPT_A],
    })).resolves.toEqual([]);
    expect(pgQuery).not.toHaveBeenCalled();
  });

  it('причины: подотделы, владелец выше, неактивный отдел; лист без владельца — ок', async () => {
    pgQuery.mockResolvedValue([
      { department_id: 'd1', department_name: 'Корень', is_active: true, in_archive: false, has_children: true, owner_department_name: null },
      { department_id: 'd2', department_name: 'Лист под начальником', is_active: true, in_archive: false, has_children: false, owner_department_name: 'Родитель' },
      { department_id: 'd3', department_name: 'Архивный', is_active: true, in_archive: true, has_children: false, owner_department_name: null },
      { department_id: 'd4', department_name: 'Годный лист', is_active: true, in_archive: false, has_children: false, owner_department_name: null },
    ]);
    const violations = await findDeputyTopologyViolations({
      employeeId: 7, checkDepartmentIds: ['d1', 'd2', 'd3', 'd4'], finalOwnedDepartmentIds: ['p1'],
    });
    expect(violations.map(v => [v.department_id, v.reason])).toEqual([
      ['d1', 'has_children'],
      ['d2', 'owner_above'],
      ['d3', 'inactive'],
    ]);
    const [sql, params] = pgQuery.mock.calls[0]!;
    // Чужие владельцы — без собственных текущих строк сотрудника; свои — из итогового состояния.
    expect(String(sql)).toContain('o.employee_id <> $2::bigint');
    expect(String(sql)).toContain('ch.anc_id = ANY($3::uuid[])');
    expect(params).toEqual([['d1', 'd2', 'd3', 'd4'], 7, ['p1']]);
  });

  it('текст 409 с названиями отделов и причинами', () => {
    const text = formatDeputyTopologyError([
      { department_id: 'd1', department_name: 'Корень', reason: 'has_children', owner_department_name: null },
      { department_id: 'd2', department_name: 'Лист', reason: 'owner_above', owner_department_name: 'Родитель' },
    ]);
    expect(text).toContain('«Корень» — есть подотделы');
    expect(text).toContain('«Лист» — выше уже есть владелец табеля («Родитель»)');
  });
});
