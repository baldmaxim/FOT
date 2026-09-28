import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * Персональный доступ к «Зарплате» выдаёт НАЗНАЧЕНИЕ, а не роль (миграция 288).
 *
 * Бухгалтер на роли «Офисный сотрудник» (без доступа в админку) по гранту получает ровно
 * /salary/terms — экран «Условия оплаты». Будущие ключи раздела и чужие страницы грант не
 * открывает, а resolveRolePageAccess (кадровые экраны вне раздела) его не видит вовсе.
 */

const { hoisted } = vi.hoisted(() => ({
  hoisted: {
    grantRows: [] as Array<{ access_level: string }>,
    grantError: null as Error | null,
    query: vi.fn(),
    role: vi.fn(async (code: string) => ({
      code,
      is_admin: code === 'admin',
      admin_access: code !== 'office',
      manager_auto_access: true,
    })),
  },
}));

vi.mock('../config/postgres.js', () => ({ query: hoisted.query, withTransaction: vi.fn() }));
vi.mock('./roles-cache.service.js', () => ({
  getRoleByCode: hoisted.role,
  getRoleById: vi.fn(async () => null),
  invalidateRolesCache: vi.fn(),
}));
vi.mock('./data-scope.service.js', () => ({
  resolveAccessibleDepartmentIds: vi.fn(async () => [] as string[]),
  hasDeputyAssignment: vi.fn(async () => false),
}));
vi.mock('./hiring-access.service.js', () => ({
  hasHiringAutoAccess: vi.fn(async () => false),
  isHiringRequesterRole: () => false,
}));
vi.mock('./object-kpi-roles-cache.service.js', () => ({ isEconomicsHead: vi.fn(async () => false) }));

const accessControl = await import('./access-control.service.js');

const makeReq = (over: Partial<AuthenticatedRequest['user']> = {}): AuthenticatedRequest => ({
  user: { id: 'u1', employee_id: 501, role_code: 'office', is_admin: false, ...over },
} as unknown as AuthenticatedRequest);

const grantQueries = () => hoisted.query.mock.calls.filter(
  ([sql]) => typeof sql === 'string' && sql.includes('payroll_access_grants'),
);

beforeEach(() => {
  vi.clearAllMocks();
  accessControl.invalidateRolePageAccessCache();
  hoisted.grantRows = [];
  hoisted.grantError = null;
  hoisted.query.mockImplementation(async (sql: string) => {
    if (sql.includes('payroll_access_grants')) {
      if (hoisted.grantError) throw hoisted.grantError;
      return hoisted.grantRows;
    }
    return []; // role_page_access: у роли прав нет
  });
});

describe('resolveEffectivePageAccess: персональный доступ к «Зарплате»', () => {
  it('без гранта офисный сотрудник «Условия оплаты» не видит', async () => {
    await expect(accessControl.resolveEffectivePageAccess(makeReq(), '/salary/terms', 'view')).resolves.toBe(false);
  });

  it('«Просмотр»: чтение открыто, правка — нет (роль без доступа в админку не мешает)', async () => {
    hoisted.grantRows = [{ access_level: 'view' }];
    await expect(accessControl.resolveEffectivePageAccess(makeReq(), '/salary/terms', 'view')).resolves.toBe(true);
    await expect(accessControl.resolveEffectivePageAccess(makeReq(), '/salary/terms', 'edit')).resolves.toBe(false);
  });

  it('«Редактирование»: и чтение, и правка', async () => {
    hoisted.grantRows = [{ access_level: 'edit' }];
    await expect(accessControl.resolveEffectivePageAccess(makeReq(), '/salary/terms', 'view')).resolves.toBe(true);
    await expect(accessControl.resolveEffectivePageAccess(makeReq(), '/salary/terms', 'edit')).resolves.toBe(true);
  });

  it('грант открывает только /salary/terms: будущие ключи раздела и чужие страницы закрыты', async () => {
    hoisted.grantRows = [{ access_level: 'edit' }];
    for (const page of [
      '/salary/payments',
      '/salary/payments/calculate',
      '/salary/payments/approve',
      '/salary/sick-leaves',
      '/salary/vacations',
      '/salary/deductions',
      '/employees',
      '/admin/users',
    ]) {
      await expect(accessControl.resolveEffectivePageAccess(makeReq(), page, 'view')).resolves.toBe(false);
    }
  });

  it('на чужих страницах таблицу грантов не читаем', async () => {
    await accessControl.resolveEffectivePageAccess(makeReq(), '/employees', 'view');
    expect(grantQueries()).toHaveLength(0);
  });

  it('грант читается один раз на запрос (кэш на req.user)', async () => {
    hoisted.grantRows = [{ access_level: 'view' }];
    const req = makeReq();
    await accessControl.resolveEffectivePageAccess(req, '/salary/terms', 'view');
    await accessControl.resolveEffectivePageAccess(req, '/salary/terms', 'edit');
    expect(grantQueries()).toHaveLength(1);
  });

  it('ошибка БД (например, до миграции 288) — доступа нет, а не 500', async () => {
    hoisted.grantError = new Error('relation "payroll_access_grants" does not exist');
    await expect(accessControl.resolveEffectivePageAccess(makeReq(), '/salary/terms', 'view')).resolves.toBe(false);
  });

  it('администратору грант не нужен: таблицу не читаем, доступ по is_admin', async () => {
    const admin = makeReq({ role_code: 'admin', is_admin: true });
    await expect(accessControl.resolveEffectivePageAccess(admin, '/salary/terms', 'edit')).resolves.toBe(true);
    expect(grantQueries()).toHaveLength(0);
  });
});

describe('resolveRolePageAccess: только право роли', () => {
  it('персональный грант не учитывается — кадровые экраны вне «Зарплаты» его не видят', async () => {
    hoisted.grantRows = [{ access_level: 'edit' }];
    const req = makeReq();
    await expect(accessControl.resolveRolePageAccess(req, '/salary/terms', 'view')).resolves.toBe(false);
    await expect(accessControl.resolveEffectivePageAccess(req, '/salary/terms', 'view')).resolves.toBe(true);
  });

  it('право роли по-прежнему работает (роль с доступом в админку и ключом в матрице)', async () => {
    hoisted.query.mockImplementation(async (sql: string) => (
      sql.includes('role_page_access')
        ? [{ role_code: 'hr', page_path: '/salary/terms', can_view: true, can_edit: false }]
        : []
    ));
    const hr = makeReq({ role_code: 'hr' });
    await expect(accessControl.resolveRolePageAccess(hr, '/salary/terms', 'view')).resolves.toBe(true);
    await expect(accessControl.resolveRolePageAccess(hr, '/salary/terms', 'edit')).resolves.toBe(false);
  });

  it('is_admin — всегда да', async () => {
    const admin = makeReq({ role_code: 'admin', is_admin: true });
    await expect(accessControl.resolveRolePageAccess(admin, '/salary/terms', 'edit')).resolves.toBe(true);
  });
});
