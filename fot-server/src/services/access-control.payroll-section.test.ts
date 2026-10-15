import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * Раздел «Зарплата» — только учёткам из списка payroll_section_access (миграция 310).
 *
 * Список решает и за администратора: проверка стоит до обхода is_admin. Роль ключи раздела
 * не открывает. Чужие страницы и незнакомые /salary/* ключи список не открывает, а
 * resolveRolePageAccess (кадровые экраны вне раздела) его не видит вовсе.
 */

const { hoisted } = vi.hoisted(() => ({
  hoisted: {
    listRows: [] as Array<{ user_id: string }>,
    listError: null as Error | null,
    roleRows: [] as Array<Record<string, unknown>>,
    catalogRows: [] as Array<Record<string, unknown>>,
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
const { validatePageAccessModes } = await import('./access-catalog.service.js');
const { PAYROLL_SECTION_PAGES } = await import('./payroll/payroll-access.service.js');
const { DEFAULT_ACCESS_PAGE_CATALOG } = await import('../config/access-control.js');

const SALARY_KEYS = [
  '/salary/payments',
  '/salary/payments/calculate',
  '/salary/payments/approve',
  '/salary/terms',
  '/salary/sick-leaves',
  '/salary/vacations',
  '/salary/deductions',
];

const makeReq = (over: Partial<AuthenticatedRequest['user']> = {}): AuthenticatedRequest => ({
  user: { id: 'u1', employee_id: 501, role_code: 'office', is_admin: false, ...over },
} as unknown as AuthenticatedRequest);

const listQueries = () => hoisted.query.mock.calls.filter(
  ([sql]) => typeof sql === 'string' && sql.includes('payroll_section_access'),
);

beforeEach(() => {
  vi.clearAllMocks();
  accessControl.invalidateRolePageAccessCache();
  accessControl.invalidatePageCatalogCache();
  hoisted.listRows = [];
  hoisted.listError = null;
  hoisted.roleRows = [];
  hoisted.catalogRows = [];
  hoisted.query.mockImplementation(async (sql: string) => {
    if (sql.includes('payroll_section_access')) {
      if (hoisted.listError) throw hoisted.listError;
      return hoisted.listRows;
    }
    if (sql.includes('role_page_access')) return hoisted.roleRows;
    if (sql.includes('access_pages')) return hoisted.catalogRows;
    return [];
  });
});

describe('resolveEffectivePageAccess: раздел «Зарплата» по списку', () => {
  it('офисный сотрудник не из списка раздел не видит', async () => {
    await expect(accessControl.resolveEffectivePageAccess(makeReq(), '/salary/terms', 'view')).resolves.toBe(false);
  });

  it('из списка — весь раздел на чтение и правку (роль без доступа в админку не мешает)', async () => {
    hoisted.listRows = [{ user_id: 'u1' }];
    for (const page of SALARY_KEYS) {
      await expect(accessControl.resolveEffectivePageAccess(makeReq(), page, 'view')).resolves.toBe(true);
      await expect(accessControl.resolveEffectivePageAccess(makeReq(), page, 'edit')).resolves.toBe(true);
    }
    expect(listQueries()[0][1]).toEqual(['u1']);
  });

  it('администратор не из списка раздел не видит', async () => {
    const admin = makeReq({ role_code: 'admin', is_admin: true });
    for (const page of SALARY_KEYS) {
      await expect(accessControl.resolveEffectivePageAccess(admin, page, 'view')).resolves.toBe(false);
    }
  });

  it('администратор из списка — весь раздел', async () => {
    hoisted.listRows = [{ user_id: 'u1' }];
    const admin = makeReq({ role_code: 'admin', is_admin: true });
    await expect(accessControl.resolveEffectivePageAccess(admin, '/salary/terms', 'edit')).resolves.toBe(true);
  });

  it('право роли на ключ раздела ничего не даёт', async () => {
    hoisted.roleRows = [{ role_code: 'hr', page_path: '/salary/terms', can_view: true, can_edit: true }];
    const hr = makeReq({ role_code: 'hr' });
    await expect(accessControl.resolveEffectivePageAccess(hr, '/salary/terms', 'view')).resolves.toBe(false);
  });

  it('незнакомый /salary/* ключ и чужие страницы список не открывает', async () => {
    hoisted.listRows = [{ user_id: 'u1' }];
    for (const page of ['/salary/unknown', '/salary', '/employees', '/admin/users']) {
      await expect(accessControl.resolveEffectivePageAccess(makeReq(), page, 'view')).resolves.toBe(false);
    }
  });

  it('админу чужие страницы — по is_admin, список не читаем', async () => {
    const admin = makeReq({ role_code: 'admin', is_admin: true });
    await expect(accessControl.resolveEffectivePageAccess(admin, '/employees', 'edit')).resolves.toBe(true);
    expect(listQueries()).toHaveLength(0);
  });

  it('контракт: список открывает ровно все /salary/* ключи каталога (новый ключ раздела — явное решение)', () => {
    const catalogSalaryKeys = DEFAULT_ACCESS_PAGE_CATALOG
      .map(page => page.key)
      .filter(key => key.startsWith('/salary/'));
    expect([...PAYROLL_SECTION_PAGES].sort()).toEqual([...catalogSalaryKeys].sort());
    expect([...PAYROLL_SECTION_PAGES].sort()).toEqual([...SALARY_KEYS].sort());
  });

  it('на чужих страницах список не читаем', async () => {
    await accessControl.resolveEffectivePageAccess(makeReq(), '/employees', 'view');
    expect(listQueries()).toHaveLength(0);
  });

  it('список читается один раз на запрос (кэш на req.user)', async () => {
    hoisted.listRows = [{ user_id: 'u1' }];
    const req = makeReq();
    await accessControl.resolveEffectivePageAccess(req, '/salary/terms', 'view');
    await accessControl.resolveEffectivePageAccess(req, '/salary/payments', 'edit');
    expect(listQueries()).toHaveLength(1);
  });

  it('ошибка БД (например, до миграции 310) — доступа нет, а не 500', async () => {
    hoisted.listError = new Error('relation "payroll_section_access" does not exist');
    const admin = makeReq({ role_code: 'admin', is_admin: true });
    await expect(accessControl.resolveEffectivePageAccess(admin, '/salary/terms', 'view')).resolves.toBe(false);
  });
});

describe('resolveRolePageAccess: только право роли', () => {
  it('список не учитывается — кадровые экраны вне «Зарплаты» его не видят', async () => {
    hoisted.listRows = [{ user_id: 'u1' }];
    const req = makeReq();
    await expect(accessControl.resolveRolePageAccess(req, '/salary/terms', 'view')).resolves.toBe(false);
    await expect(accessControl.resolveEffectivePageAccess(req, '/salary/terms', 'view')).resolves.toBe(true);
  });

  it('is_admin — всегда да', async () => {
    const admin = makeReq({ role_code: 'admin', is_admin: true });
    await expect(accessControl.resolveRolePageAccess(admin, '/salary/terms', 'edit')).resolves.toBe(true);
  });
});

describe('матрица «Роли»: ключей раздела нет', () => {
  it('каталог страниц без ключей «Зарплаты», даже если они есть в access_pages', async () => {
    hoisted.catalogRows = [{
      key: '/salary/terms', label: 'Зарплата — условия оплаты', group_code: 'admin', group_label: 'Администрирование',
      surface: 'technical', supports_edit: true, sort_order: 274, is_active: true,
    }];
    const keys = (await accessControl.loadAccessPageCatalog()).map(page => page.key);
    for (const key of SALARY_KEYS) expect(keys).not.toContain(key);
    expect(keys).toContain('/salary-raise-review');
    expect(keys).toContain('/employees');
  });

  it('сохранить роль с ключом раздела нельзя — «Неизвестная страница»', async () => {
    await expect(validatePageAccessModes({ '/salary/terms': 'view' }))
      .resolves.toBe('Неизвестная страница в матрице доступа: /salary/terms');
    await expect(validatePageAccessModes({ '/employees': 'view' })).resolves.toBeNull();
  });
});
