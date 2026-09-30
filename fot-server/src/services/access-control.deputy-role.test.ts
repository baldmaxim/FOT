import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * Страницы роли «Заместитель» (deputy_head, миграция 292) решает только её матрица.
 *
 * Авто-гранты назначения 'deputy' (миграция 283) для роли не действуют: иначе старое
 * назначение держало бы доступ, снятый галочкой в «Ролях». Без единого отдела разделы
 * табеля, заявлений и заявок на поиск закрыты — пустой скоуп местами читается как «вся
 * организация».
 */

type TMatrixRow = { role_code: string; page_path: string; can_view: boolean; can_edit: boolean };

const { hoisted } = vi.hoisted(() => ({
  hoisted: {
    matrix: [] as TMatrixRow[],
    adminAccess: true,
    deputyAssignment: vi.fn(async () => false),
    scope: vi.fn(async () => [] as string[] | 'all'),
  },
}));

vi.mock('../config/postgres.js', () => ({
  query: vi.fn(async (sql: string) => (String(sql).includes('FROM role_page_access') ? hoisted.matrix : [])),
}));
vi.mock('./roles-cache.service.js', () => ({
  getRoleByCode: vi.fn(async (code: string) => ({
    code,
    is_admin: false,
    admin_access: hoisted.adminAccess,
    manager_auto_access: false,
  })),
  getRoleById: vi.fn(async () => null),
  invalidateRolesCache: vi.fn(),
}));
vi.mock('./data-scope.service.js', () => ({
  resolveAccessibleDepartmentIds: hoisted.scope,
  hasDeputyAssignment: hoisted.deputyAssignment,
}));
vi.mock('./hiring-access.service.js', () => ({
  hasHiringAutoAccess: vi.fn(async () => false),
  isHiringRequesterRole: () => false,
}));
vi.mock('./object-kpi-roles-cache.service.js', () => ({ isEconomicsHead: vi.fn(async () => false) }));

const accessControl = await import('./access-control.service.js');

const ROLE_DEPT = 'aaaaaaaa-0000-4000-8000-000000000001';

const makeReq = (roleCode = 'deputy_head'): AuthenticatedRequest => ({
  user: { id: 'u1', employee_id: 441, role_code: roleCode, is_admin: false },
} as unknown as AuthenticatedRequest);

const row = (page_path: string, can_view: boolean, can_edit: boolean, role_code = 'deputy_head'): TMatrixRow =>
  ({ role_code, page_path, can_view, can_edit });

const FULL_MATRIX: TMatrixRow[] = [
  row('/employee', true, false),
  row('/employee/requests', true, true),
  row('/timesheet', true, true),
  row('/leave-requests', true, true),
  row('/staff-control/hiring', true, false),
];

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.matrix = [...FULL_MATRIX];
  hoisted.adminAccess = true;
  hoisted.deputyAssignment.mockResolvedValue(false);
  hoisted.scope.mockResolvedValue([ROLE_DEPT]);
  accessControl.invalidateAccessControlCache();
});

describe('матрица роли — единственный источник страниц', () => {
  it('с отделом и галочками разделы открыты', async () => {
    const req = makeReq();
    await expect(accessControl.resolveEffectivePageAccess(req, '/timesheet', 'edit')).resolves.toBe(true);
    await expect(accessControl.resolveEffectivePageAccess(req, '/leave-requests', 'edit')).resolves.toBe(true);
    await expect(accessControl.resolveEffectivePageAccess(req, '/staff-control/hiring', 'view')).resolves.toBe(true);
  });

  it('снятая галочка «Табель → правка» закрывает правку даже при ручном назначении deputy', async () => {
    hoisted.matrix = FULL_MATRIX.map(r => (r.page_path === '/timesheet' ? row('/timesheet', true, false) : r));
    hoisted.deputyAssignment.mockResolvedValue(true);
    const req = makeReq();
    await expect(accessControl.resolveEffectivePageAccess(req, '/timesheet', 'edit')).resolves.toBe(false);
    await expect(accessControl.resolveEffectivePageAccess(req, '/timesheet', 'view')).resolves.toBe(true);
    await expect(accessControl.resolveDeputyPageAccess(req, '/timesheet')).resolves.toBeNull();
  });

  it('снятые «Заявления» и «Заявки на поиск» закрыты, авто-грант назначения не возвращает их', async () => {
    hoisted.matrix = FULL_MATRIX.filter(r => r.page_path !== '/leave-requests' && r.page_path !== '/staff-control/hiring');
    hoisted.deputyAssignment.mockResolvedValue(true);
    const req = makeReq();
    await expect(accessControl.resolveEffectivePageAccess(req, '/leave-requests', 'view')).resolves.toBe(false);
    await expect(accessControl.resolveEffectivePageAccess(req, '/staff-control/hiring', 'view')).resolves.toBe(false);
  });

  it('выключенный «Доступ в админку» закрывает админские разделы роли', async () => {
    hoisted.adminAccess = false;
    const req = makeReq();
    await expect(accessControl.resolveEffectivePageAccess(req, '/timesheet', 'view')).resolves.toBe(false);
    await expect(accessControl.resolveEffectivePageAccess(req, '/employee/requests', 'edit')).resolves.toBe(true);
  });
});

describe('без единого отдела разделы роли закрыты', () => {
  it('пустой скоуп — табель, заявления и заявки на поиск закрыты, личный кабинет открыт', async () => {
    hoisted.scope.mockResolvedValue([]);
    const req = makeReq();
    await expect(accessControl.resolveEffectivePageAccess(req, '/timesheet', 'view')).resolves.toBe(false);
    await expect(accessControl.resolveEffectivePageAccess(req, '/leave-requests', 'view')).resolves.toBe(false);
    await expect(accessControl.resolveEffectivePageAccess(req, '/staff-control/hiring', 'view')).resolves.toBe(false);
    await expect(accessControl.resolveEffectivePageAccess(req, '/employee', 'view')).resolves.toBe(true);
  });

  it('другие роли гейтом не затронуты: назначение deputy по-прежнему открывает табель', async () => {
    hoisted.scope.mockResolvedValue([]);
    hoisted.matrix = [row('/timesheet', true, false, 'security')];
    hoisted.deputyAssignment.mockResolvedValue(true);
    await expect(accessControl.resolveEffectivePageAccess(makeReq('security'), '/timesheet', 'edit')).resolves.toBe(true);
  });
});
