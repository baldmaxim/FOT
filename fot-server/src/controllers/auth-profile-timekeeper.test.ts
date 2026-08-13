/**
 * buildProfileResponse для табельщицы: снимок скоупа берётся ОДИН раз.
 *
 * До правки профиль звал listTimekeeperAccessibleDepartmentIds и
 * listTimekeeperDirectEmployeeIds подряд, и каждый делал свой 90-дневный скан
 * skud_events — логин стоил два полных скана. Тест фиксирует, что теперь снимок
 * один, и что крайние случаи профиля не изменились.
 *
 * timekeeper-scope.service НЕ мокается намеренно: считаем реальные обращения к БД,
 * а не вызовы подменённой функции.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

const { pgQuery, pgQueryOne, pgExecute, pgTx } = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  pgQueryOne: vi.fn(),
  pgExecute: vi.fn(),
  pgTx: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: pgQueryOne,
  execute: pgExecute,
  withTransaction: pgTx,
}));

const mocked = vi.hoisted(() => ({
  getRoleById: vi.fn(),
  getRolePageAccess: vi.fn(async () => ({}) as Record<string, { can_view: boolean; can_edit: boolean }>),
  listManagedDepartmentIdsForUser: vi.fn(async () => [] as string[]),
  listDirectSubordinates: vi.fn(async () => [] as number[]),
  isActiveWeekendResponsible: vi.fn(async () => false),
  hasHiringAutoAccess: vi.fn(async () => false),
  isHiringRequesterRole: vi.fn(() => false),
}));

vi.mock('../services/roles-cache.service.js', () => ({
  getRoleById: mocked.getRoleById,
  getRoleByCode: vi.fn(),
}));
vi.mock('../services/access-control.service.js', () => ({
  getRolePageAccess: mocked.getRolePageAccess,
}));
vi.mock('../services/department-access.service.js', () => ({
  listManagedDepartmentIdsForUser: mocked.listManagedDepartmentIdsForUser,
}));
vi.mock('../services/employee-direct-reports.service.js', () => ({
  listDirectSubordinates: mocked.listDirectSubordinates,
}));
vi.mock('../services/weekend-approval-assignments.service.js', () => ({
  isActiveWeekendResponsible: mocked.isActiveWeekendResponsible,
}));
vi.mock('../services/hiring-access.service.js', () => ({
  hasHiringAutoAccess: mocked.hasHiringAutoAccess,
  isHiringRequesterRole: mocked.isHiringRequesterRole,
}));

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
import {
  LI_OBSHESTROY_DEPARTMENT_ID,
  resetTimekeeperScopeCache,
} from '../services/timekeeper-scope.service.js';

const TIMEKEEPER_ROLE = {
  id: 'role-tk',
  code: 'timekeeper',
  name: 'Табельщица',
  is_admin: false,
  admin_access: false,
  manager_auto_access: true,
  employee_variant: null,
  show_actual_hours: true,
  hide_sidebar: false,
  view_all_departments: false,
  timesheet_months_back: 1,
  timesheet_months_forward: 1,
  timesheet_show_full_period: true,
  weekend_memo_required: false,
  corrections_disable_object_entries: false,
};

const PROFILE_ROW = {
  id: 'tk-1',
  full_name: 'Табельщица Т.Т.',
  system_role_id: 'role-tk',
  employee_id: null,
  supervisor_id: null,
  chat_inbound_mode: 'open',
  imported_position: null,
  is_approved: true,
  created_at: '2026-01-01T00:00:00Z',
};

function makeReq(): AuthenticatedRequest {
  return {
    params: {}, query: {}, body: {},
    user: {
      id: 'tk-1',
      email: 'tk@example.com',
      role_code: 'timekeeper',
      employee_id: null,
      department_id: null,
      is_approved: true,
      two_factor_enabled: false,
      two_factor_verified: true,
    },
  } as unknown as AuthenticatedRequest;
}

function makeRes(): Response & { body?: Record<string, unknown> } {
  const res = {
    statusCode: 200,
    body: undefined as Record<string, unknown> | undefined,
    status(code: number) { res.statusCode = code; return res; },
    json(payload: Record<string, unknown>) { res.body = payload; return res; },
    cookie: vi.fn(),
    clearCookie: vi.fn(),
  };
  return res as unknown as Response & { body?: Record<string, unknown> };
}

/** Строки объединённого statement'а скоупа. */
const scopeRows = (seeds: string[], direct: number[]) => [
  ...seeds.map(val => ({ kind: 'seed', val })),
  ...direct.map(val => ({ kind: 'direct', val: String(val) })),
];

beforeEach(() => {
  pgQuery.mockReset();
  pgQueryOne.mockReset();
  // Кэш скоупа модульный: без сброса второй кейс получил бы снимок первого.
  resetTimekeeperScopeCache();
  mocked.getRoleById.mockReset();
  mocked.getRoleById.mockResolvedValue(TIMEKEEPER_ROLE);
  mocked.getRolePageAccess.mockResolvedValue({});
  pgQueryOne.mockResolvedValue(PROFILE_ROW);
});

describe('buildProfileResponse для табельщицы: один снимок скоупа', () => {
  it('снапшот запрашивается ровно один раз, не дважды', async () => {
    pgQuery
      .mockResolvedValueOnce(scopeRows(['br-A'], [5, 7])) // объединённый statement
      .mockResolvedValueOnce([{ id: 'br-A' }, { id: 'child-1' }]); // поддерево

    const res = makeRes();
    await authController.getMe(makeReq(), res);

    const snapshotCalls = pgQuery.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes('event_emp AS MATERIALIZED'),
    );
    expect(snapshotCalls).toHaveLength(1);
    expect(pgQuery).toHaveBeenCalledTimes(2); // снапшот + поддерево
  });

  it('managed_department_ids = seeds + поддерево + ЛИНИЯ-Общестрой', async () => {
    pgQuery
      .mockResolvedValueOnce(scopeRows(['br-A'], [5]))
      .mockResolvedValueOnce([{ id: 'br-A' }, { id: 'child-1' }]);

    const res = makeRes();
    await authController.getMe(makeReq(), res);

    const profile = res.body?.profile as { managed_department_ids: string[] };
    expect(profile.managed_department_ids).toEqual(['br-A', 'child-1', LI_OBSHESTROY_DEPARTMENT_ID]);
  });

  it('пустые seeds → managed_department_ids = [], ЛИНИЯ-Общестрой НЕ добавляется', async () => {
    pgQuery.mockResolvedValueOnce(scopeRows([], [5])); // seeds пусто, direct есть

    const res = makeRes();
    await authController.getMe(makeReq(), res);

    const profile = res.body?.profile as { managed_department_ids: string[] };
    expect(profile.managed_department_ids).toEqual([]);
    expect(profile.managed_department_ids).not.toContain(LI_OBSHESTROY_DEPARTMENT_ID);
    // Поддерево не запрашивается вовсе — ранний return сохранён.
    expect(pgQuery).toHaveBeenCalledTimes(1);
  });

  it('has_direct_reports = true, когда в снимке есть сотрудники', async () => {
    pgQuery
      .mockResolvedValueOnce(scopeRows(['br-A'], [5]))
      .mockResolvedValueOnce([{ id: 'br-A' }]);

    const res = makeRes();
    await authController.getMe(makeReq(), res);

    const profile = res.body?.profile as { has_direct_reports: boolean };
    expect(profile.has_direct_reports).toBe(true);
  });

  it('has_direct_reports = false при пустом direct; listDirectSubordinates не зовётся', async () => {
    pgQuery.mockResolvedValueOnce(scopeRows([], []));

    const res = makeRes();
    await authController.getMe(makeReq(), res);

    const profile = res.body?.profile as { has_direct_reports: boolean };
    expect(profile.has_direct_reports).toBe(false);
    // Ветка табельщицы не должна проваливаться в общий путь руководителя.
    expect(mocked.listDirectSubordinates).not.toHaveBeenCalled();
    expect(mocked.listManagedDepartmentIdsForUser).not.toHaveBeenCalled();
  });
});
