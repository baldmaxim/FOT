import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * Страницы заместителя выдаёт НАЗНАЧЕНИЕ, а не роль (миграция 283).
 *
 * Кейс Гладкой: роль «Отдел безопасности» остаётся прежней (в ней /timesheet только
 * просмотр, а manager_auto_access выключен), но назначение уровня 'deputy' открывает
 * ведение табеля. Второй пользователь той же роли без назначения ничего не получает.
 */

const { hoisted } = vi.hoisted(() => ({
  hoisted: {
    roleAccess: vi.fn(async () => ({} as Record<string, { can_view: boolean; can_edit: boolean }>)),
    role: vi.fn(async () => ({
      code: 'security',
      is_admin: false,
      admin_access: true,
      manager_auto_access: false,
    })),
    deputy: vi.fn(async () => false),
  },
}));

vi.mock('../config/postgres.js', () => ({ query: vi.fn(async () => []) }));
vi.mock('./roles-cache.service.js', () => ({
  getRoleByCode: hoisted.role,
  getRoleById: vi.fn(async () => null),
  invalidateRolesCache: vi.fn(),
}));
vi.mock('./data-scope.service.js', () => ({
  resolveAccessibleDepartmentIds: vi.fn(async () => [] as string[]),
  hasDeputyAssignment: hoisted.deputy,
}));
vi.mock('./hiring-access.service.js', () => ({
  hasHiringAutoAccess: vi.fn(async () => false),
  isHiringRequesterRole: () => false,
}));
vi.mock('./object-kpi-roles-cache.service.js', () => ({ isEconomicsHead: vi.fn(async () => false) }));

const accessControl = await import('./access-control.service.js');
vi.spyOn(accessControl, 'hasPageEdit').mockImplementation(async () => false);

const req = {
  user: { id: 'u1', employee_id: 441, role_code: 'security', is_admin: false },
} as unknown as AuthenticatedRequest;

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.deputy.mockResolvedValue(false);
  hoisted.roleAccess.mockResolvedValue({});
});

describe('resolveEffectivePageAccess: авто-грант заместителя', () => {
  it('без назначения роль «Отдел безопасности» табель не редактирует', async () => {
    await expect(accessControl.resolveEffectivePageAccess(req, '/timesheet', 'edit')).resolves.toBe(false);
  });

  it('с назначением заместителя открываются табель и заявления', async () => {
    hoisted.deputy.mockResolvedValue(true);

    await expect(accessControl.resolveEffectivePageAccess(req, '/timesheet', 'edit')).resolves.toBe(true);
    await expect(accessControl.resolveEffectivePageAccess(req, '/leave-requests', 'edit')).resolves.toBe(true);
    await expect(accessControl.resolveEffectivePageAccess(req, '/staff-control/hiring', 'view')).resolves.toBe(true);
  });

  it('вкладку заявок на поиск заместителю не открываем на запись', async () => {
    hoisted.deputy.mockResolvedValue(true);
    await expect(accessControl.resolveEffectivePageAccess(req, '/staff-control/hiring', 'edit')).resolves.toBe(false);
  });

  it('чужих страниц назначение не открывает: согласования HR остаются закрытыми', async () => {
    hoisted.deputy.mockResolvedValue(true);
    await expect(accessControl.resolveEffectivePageAccess(req, '/timesheet-hr', 'edit')).resolves.toBe(false);
    await expect(accessControl.resolveEffectivePageAccess(req, '/employees', 'edit')).resolves.toBe(false);
  });
});
