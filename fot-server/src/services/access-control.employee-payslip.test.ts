import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * Расчётный лист в ЛК (миграция 353): только список employee_payslip_access или настройка «всем», и только учётке с
 * сотрудником. Решает и за администратора — проверка до обхода is_admin. Роль ключ не открывает; правки нет.
 */

const { hoisted } = vi.hoisted(() => ({
  hoisted: {
    allowed: false,
    error: null as Error | null,
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
const { hasEmployeePayslipAccess } = await import('./employee-payslip-access.service.js');

const PAGE = '/employee/payslip';

const makeReq = (over: Partial<AuthenticatedRequest['user']> = {}): AuthenticatedRequest => ({
  user: { id: 'u1', employee_id: 2520, role_code: 'office', is_admin: false, ...over },
} as unknown as AuthenticatedRequest);

const accessQueries = () => hoisted.query.mock.calls.filter(
  ([sql]) => typeof sql === 'string' && sql.includes('employee_payslip_access'),
);

beforeEach(() => {
  vi.clearAllMocks();
  accessControl.invalidateRolePageAccessCache();
  accessControl.invalidatePageCatalogCache();
  hoisted.allowed = false;
  hoisted.error = null;
  hoisted.roleRows = [];
  hoisted.catalogRows = [];
  hoisted.query.mockImplementation(async (sql: string) => {
    if (sql.includes('employee_payslip_access')) {
      if (hoisted.error) throw hoisted.error;
      return [{ allowed: hoisted.allowed }];
    }
    if (sql.includes('role_page_access')) return hoisted.roleRows;
    if (sql.includes('access_pages')) return hoisted.catalogRows;
    return [];
  });
});

describe('resolveEffectivePageAccess: расчётный лист по списку', () => {
  it('в списке (или «всем») — просмотр есть, правки нет', async () => {
    hoisted.allowed = true;
    await expect(accessControl.resolveEffectivePageAccess(makeReq(), PAGE, 'view')).resolves.toBe(true);
    await expect(accessControl.resolveEffectivePageAccess(makeReq(), PAGE, 'edit')).resolves.toBe(false);
    expect(accessQueries()[0][1]).toEqual([2520, 'employee_payslip_for_all']);
  });

  it('не в списке и не «всем» — нет', async () => {
    await expect(accessControl.resolveEffectivePageAccess(makeReq(), PAGE, 'view')).resolves.toBe(false);
  });

  it('администратор не из списка — нет (до обхода is_admin)', async () => {
    const admin = makeReq({ role_code: 'admin', is_admin: true, employee_id: 7 });
    await expect(accessControl.resolveEffectivePageAccess(admin, PAGE, 'view')).resolves.toBe(false);
  });

  it('учётка без сотрудника — нет даже при «всем», база не читается', async () => {
    hoisted.allowed = true;
    await expect(accessControl.resolveEffectivePageAccess(makeReq({ employee_id: null }), PAGE, 'view')).resolves.toBe(false);
    expect(accessQueries()).toHaveLength(0);
  });

  it('право роли на ключ ничего не даёт', async () => {
    hoisted.roleRows = [{ role_code: 'office', page_path: PAGE, can_view: true, can_edit: true }];
    await expect(accessControl.resolveEffectivePageAccess(makeReq(), PAGE, 'view')).resolves.toBe(false);
  });

  it('ошибка базы — нет доступа, не 500', async () => {
    hoisted.allowed = true;
    hoisted.error = new Error('relation "employee_payslip_access" does not exist');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(accessControl.resolveEffectivePageAccess(makeReq(), PAGE, 'view')).resolves.toBe(false);
    warn.mockRestore();
  });

  it('на чужих страницах список не читаем', async () => {
    await accessControl.resolveEffectivePageAccess(makeReq({ role_code: 'admin', is_admin: true }), '/employees', 'view');
    expect(accessQueries()).toHaveLength(0);
  });

  it('ключа нет в матрице «Роли»', async () => {
    const catalog = await accessControl.loadAccessPageCatalog();
    expect(catalog.map(page => page.key)).not.toContain(PAGE);
  });
});

describe('hasEmployeePayslipAccess', () => {
  it('без сотрудника — false без запроса', async () => {
    await expect(hasEmployeePayslipAccess(null)).resolves.toBe(false);
    await expect(hasEmployeePayslipAccess(undefined)).resolves.toBe(false);
    expect(hoisted.query).not.toHaveBeenCalled();
  });
});
