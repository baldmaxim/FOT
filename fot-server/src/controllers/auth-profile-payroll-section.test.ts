/**
 * /auth/me и раздел «Зарплата» по списку payroll_section_access (миграция 310).
 *
 * Зеркало ветки resolveEffectivePageAccess: ключи раздела в page_access решает только список —
 * из списка весь раздел с правкой, не из списка ключей нет, даже если их дала роль (и у
 * администратора). Вход в админку (has_admin_access) получает и человек из списка на роли только
 * с личным кабинетом, но админ-ключи самой роли по-прежнему режутся по флагу роли.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

const { pgQuery, pgQueryOne } = vi.hoisted(() => ({
  pgQuery: vi.fn(async () => []),
  pgQueryOne: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: pgQueryOne,
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

type PageAccess = Record<string, { can_view: boolean; can_edit: boolean }>;

const mocked = vi.hoisted(() => ({
  getRoleById: vi.fn(),
  getRolePageAccess: vi.fn(async (): Promise<PageAccess> => ({})),
  hasPayrollSectionAccess: vi.fn(async (): Promise<boolean> => false),
}));

vi.mock('../services/roles-cache.service.js', () => ({
  getRoleById: mocked.getRoleById,
  getRoleByCode: vi.fn(),
}));
vi.mock('../services/access-control.service.js', () => ({
  getRolePageAccess: mocked.getRolePageAccess,
  listDeputyAutoAccessPages: () => [],
}));
vi.mock('../services/payroll/payroll-access.service.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/payroll/payroll-access.service.js')>(),
  hasPayrollSectionAccess: mocked.hasPayrollSectionAccess,
}));
vi.mock('../services/department-access.service.js', () => ({
  listManagedDepartmentIdsForUser: vi.fn(async () => [] as string[]),
  hasActiveDeputyAssignment: vi.fn(async () => false),
}));
vi.mock('../services/employee-direct-reports.service.js', () => ({
  listDirectSubordinates: vi.fn(async () => [] as number[]),
}));
vi.mock('../services/weekend-approval-assignments.service.js', () => ({
  isActiveWeekendResponsible: vi.fn(async () => false),
}));
vi.mock('../services/hiring-access.service.js', () => ({
  hasHiringAutoAccess: vi.fn(async () => false),
  isHiringRequesterRole: vi.fn(() => false),
}));
vi.mock('../services/object-kpi-roles-cache.service.js', () => ({ isEconomicsHead: vi.fn(async () => false) }));

// Побочные зависимости модуля auth.controller — в этом тесте не участвуют.
vi.mock('../services/local-auth.service.js', () => ({
  localAuthService: {}, LocalAuthError: class extends Error {},
}));
vi.mock('../services/audit.service.js', () => ({ auditService: { log: vi.fn() } }));
vi.mock('../services/mailer.service.js', () => ({ mailerService: { send: vi.fn() } }));
vi.mock('../services/notification.service.js', () => ({ notificationService: { create: vi.fn() } }));
vi.mock('../services/push.service.js', () => ({ pushService: { send: vi.fn() } }));
vi.mock('./auth-2fa.controller.js', () => ({ verify2FA: vi.fn(), useRecoveryCode: vi.fn() }));
vi.mock('../utils/auth-session.js', () => ({
  clearSessionCookies: vi.fn(),
  generateAccessToken: vi.fn(() => 'access-token'),
  generateRefreshToken: vi.fn(() => 'refresh-token'),
  getRefreshTokenFromRequest: vi.fn(),
  setSessionCookies: vi.fn(),
  verifyRefreshToken: vi.fn(),
}));

import { authController } from './auth.controller.js';

const baseRole = {
  name: 'Роль',
  employee_variant: 'office',
  show_actual_hours: false,
  hide_sidebar: false,
  view_all_departments: false,
  timesheet_months_back: 1,
  timesheet_months_forward: 1,
  timesheet_show_full_period: true,
  weekend_memo_required: false,
  corrections_disable_object_entries: false,
};

const OFFICE_ROLE = { ...baseRole, id: 'role-office', code: 'office', is_admin: false, admin_access: false, manager_auto_access: true };
const HR_ROLE = { ...baseRole, id: 'role-hr', code: 'hr', is_admin: false, admin_access: true, manager_auto_access: true };
const ADMIN_ROLE = { ...baseRole, id: 'role-admin', code: 'admin', is_admin: true, admin_access: true, manager_auto_access: true };

const PROFILE_ROW = {
  id: 'user-1',
  full_name: 'Бухгалтер Б.Б.',
  system_role_id: 'role-office',
  employee_id: 501,
  supervisor_id: null,
  chat_inbound_mode: 'open',
  imported_position: null,
  is_approved: true,
  created_at: '2026-01-01T00:00:00Z',
};

const makeReq = (): AuthenticatedRequest => ({
  params: {}, query: {}, body: {},
  user: {
    id: 'user-1',
    email: 'buh@example.com',
    role_code: 'office',
    employee_id: 501,
    department_id: null,
    is_approved: true,
    two_factor_enabled: false,
    two_factor_verified: true,
  },
} as unknown as AuthenticatedRequest);

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: undefined as Record<string, unknown> | undefined,
    status(code: number) { res.statusCode = code; return res; },
    json(payload: Record<string, unknown>) { res.body = payload; return res; },
    cookie: vi.fn(),
    clearCookie: vi.fn(),
  };
  return res as unknown as Response & { body?: Record<string, unknown> };
};

const SALARY_KEYS = [
  '/salary/payments',
  '/salary/payments/calculate',
  '/salary/payments/approve',
  '/salary/terms',
  '/salary/sick-leaves',
  '/salary/vacations',
  '/salary/deductions',
];

const salaryAccess = (canEdit: boolean): PageAccess => Object.fromEntries(
  SALARY_KEYS.map(key => [key, { can_view: true, can_edit: canEdit }]),
);

const loadProfile = async () => {
  const res = makeRes();
  await authController.getMe(makeReq(), res);
  return res.body?.profile as {
    page_access: PageAccess;
    has_admin_access: boolean;
    has_brigade_output_access: boolean;
    supervisor_brigade_ids: string[];
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  pgQuery.mockImplementation((async () => []) as never);
  pgQueryOne.mockResolvedValue(PROFILE_ROW);
  mocked.getRoleById.mockResolvedValue(OFFICE_ROLE);
  mocked.getRolePageAccess.mockResolvedValue({ '/employee': { can_view: true, can_edit: true } });
  mocked.hasPayrollSectionAccess.mockResolvedValue(false);
});

describe('/auth/me: раздел «Зарплата» по списку', () => {
  it('не из списка у офисного сотрудника нет ни «Зарплаты», ни входа в админку', async () => {
    const profile = await loadProfile();
    expect(profile.page_access['/salary/terms']).toBeUndefined();
    expect(profile.has_admin_access).toBe(false);
  });

  it('из списка: весь раздел с правкой и вход в админку, посторонних ключей нет', async () => {
    mocked.hasPayrollSectionAccess.mockResolvedValue(true);
    const profile = await loadProfile();
    expect(mocked.hasPayrollSectionAccess).toHaveBeenCalledWith('user-1');
    expect(profile.page_access).toEqual({
      '/employee': { can_view: true, can_edit: true },
      ...salaryAccess(true),
    });
    expect(profile.has_admin_access).toBe(true);
  });

  it('админ-ключи роли без доступа в админку режутся и у человека из списка', async () => {
    mocked.hasPayrollSectionAccess.mockResolvedValue(true);
    mocked.getRolePageAccess.mockResolvedValue({
      '/employee': { can_view: true, can_edit: true },
      '/employees': { can_view: true, can_edit: true },
    });
    const profile = await loadProfile();
    expect(profile.page_access['/employees']).toBeUndefined();
    expect(profile.page_access['/salary/terms']).toEqual({ can_view: true, can_edit: true });
  });

  it('ключи раздела от роли не из списка убираются', async () => {
    mocked.getRoleById.mockResolvedValue(HR_ROLE);
    mocked.getRolePageAccess.mockResolvedValue({
      '/employees': { can_view: true, can_edit: true },
      '/salary/terms': { can_view: true, can_edit: true },
      '/salary/deductions': { can_view: true, can_edit: false },
    });
    const profile = await loadProfile();
    expect(profile.page_access).toEqual({ '/employees': { can_view: true, can_edit: true } });
  });

  it('администратор не из списка: ключей раздела нет, вход в админку по роли', async () => {
    mocked.getRoleById.mockResolvedValue(ADMIN_ROLE);
    mocked.getRolePageAccess.mockResolvedValue(salaryAccess(true));
    const profile = await loadProfile();
    expect(profile.page_access).toEqual({});
    expect(profile.has_admin_access).toBe(true);
  });

  it('администратор из списка: весь раздел', async () => {
    mocked.getRoleById.mockResolvedValue(ADMIN_ROLE);
    mocked.getRolePageAccess.mockResolvedValue({});
    mocked.hasPayrollSectionAccess.mockResolvedValue(true);
    const profile = await loadProfile();
    expect(profile.page_access).toEqual(salaryAccess(true));
  });
});

describe('/auth/me: «Выработка» (миграция 342)', () => {
  const grant = () => pgQuery.mockImplementation((async (sql: string) => (
    String(sql).includes('FROM employee_brigade_output_access') ? [{ employee_id: 501 }] : []
  )) as never);

  it('нет ни списка, ни галочки — флага нет', async () => {
    expect((await loadProfile()).has_brigade_output_access).toBe(false);
  });

  it('галочка: флаг есть, ключей раздела и входа в админку от неё нет', async () => {
    grant();
    const profile = await loadProfile();
    expect(profile.has_brigade_output_access).toBe(true);
    expect(profile.page_access['/salary/terms']).toBeUndefined();
    expect(profile.has_admin_access).toBe(false);
  });

  it('список «Зарплаты» — флаг есть и без галочки', async () => {
    mocked.hasPayrollSectionAccess.mockResolvedValue(true);
    expect((await loadProfile()).has_brigade_output_access).toBe(true);
  });

  it('база недоступна (таблица до миграции) — нет доступа, а не ошибка профиля', async () => {
    pgQuery.mockImplementation((async (sql: string) => {
      if (String(sql).includes('FROM employee_brigade_output_access')) throw new Error('relation does not exist');
      return [];
    }) as never);
    expect((await loadProfile()).has_brigade_output_access).toBe(false);
  });
});

describe('/auth/me: «Ставить КТУ своим бригадам» (миграция 370)', () => {
  const BRIGADES = ['5049c2c9-1334-49e6-8d55-7a04bebcaa8c', '7d3c1e2f-4a5b-4c6d-8e7f-9a0b1c2d3e4f'];
  /** Галочка начальника (queryOne) и его текущие бригады (query) — по тексту SQL. */
  const setup = ({ granted, brigades = BRIGADES, output = false }: {
    granted: boolean | 'error'; brigades?: string[]; output?: boolean;
  }) => {
    pgQueryOne.mockImplementation((async (sql: string) => {
      if (!String(sql).includes('FROM employee_supervisor_ktu_access')) return PROFILE_ROW;
      if (granted === 'error') throw new Error('relation does not exist');
      return granted ? { employee_id: 501 } : null;
    }) as never);
    pgQuery.mockImplementation((async (sql: string) => {
      const text = String(sql);
      if (text.includes('FROM employee_brigade_output_access')) return output ? [{ employee_id: 501 }] : [];
      if (text.includes('WHERE eda.employee_id = $1')) return brigades.map(id => ({ department_id: id }));
      return [];
    }) as never);
  };

  it('галочка и бригады — только свои бригады, «Выработки» нет', async () => {
    setup({ granted: true });
    const profile = await loadProfile();
    expect(profile.supervisor_brigade_ids).toEqual(BRIGADES);
    expect(profile.has_brigade_output_access).toBe(false);
  });

  it('начальник без галочки — [] (кнопка не появится у всех начальников)', async () => {
    setup({ granted: false });
    expect((await loadProfile()).supervisor_brigade_ids).toEqual([]);
  });

  it('галочка без бригад (спящая) — []', async () => {
    setup({ granted: true, brigades: [] });
    expect((await loadProfile()).supervisor_brigade_ids).toEqual([]);
  });

  it('обе галочки — «Выработка» шире: список пуст', async () => {
    setup({ granted: true, output: true });
    const profile = await loadProfile();
    expect(profile.has_brigade_output_access).toBe(true);
    expect(profile.supervisor_brigade_ids).toEqual([]);
  });

  it('база недоступна (таблица до миграции) — [], а не ошибка профиля', async () => {
    setup({ granted: 'error' });
    expect((await loadProfile()).supervisor_brigade_ids).toEqual([]);
  });
});

describe('/auth/me: расчётный лист в ЛК (миграция 353)', () => {
  const PAYSLIP = '/employee/payslip';
  const allow = () => pgQuery.mockImplementation((async (sql: string) => (
    String(sql).includes('employee_payslip_access') ? [{ allowed: true }] : []
  )) as never);
  const payslipQueries = () => pgQuery.mock.calls.filter(
    (call: unknown[]) => String(call[0]).includes('employee_payslip_access'),
  );

  it('не в списке — ключа нет, даже если его дала роль', async () => {
    mocked.getRolePageAccess.mockResolvedValue({ [PAYSLIP]: { can_view: true, can_edit: true } });
    expect((await loadProfile()).page_access[PAYSLIP]).toBeUndefined();
  });

  it('в списке или «всем» — только просмотр, по сотруднику учётки', async () => {
    allow();
    expect((await loadProfile()).page_access[PAYSLIP]).toEqual({ can_view: true, can_edit: false });
    expect(payslipQueries()[0][1]).toEqual([501, 'employee_payslip_for_all']);
  });

  it('администратор не из списка — ключа нет', async () => {
    mocked.getRoleById.mockResolvedValue(ADMIN_ROLE);
    mocked.getRolePageAccess.mockResolvedValue({ [PAYSLIP]: { can_view: true, can_edit: true } });
    expect((await loadProfile()).page_access[PAYSLIP]).toBeUndefined();
  });

  it('учётка без сотрудника — ключа нет даже при «всем», база не читается', async () => {
    allow();
    pgQueryOne.mockResolvedValue({ ...PROFILE_ROW, employee_id: null });
    expect((await loadProfile()).page_access[PAYSLIP]).toBeUndefined();
    expect(payslipQueries()).toHaveLength(0);
  });
});
