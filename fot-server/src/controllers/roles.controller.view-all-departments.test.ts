import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest, SystemRole } from '../types/index.js';

/**
 * Флаг system_roles.view_all_departments (миграция 237): сохранение через
 * create/update/clone, серверная нормализация для admin/timekeeper и сброс
 * кешей данных при изменении флага.
 */

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

vi.mock('../services/access-control.service.js', () => ({
  invalidateRoleListCache: vi.fn(),
  invalidateRolePageAccessCache: vi.fn(),
}));

vi.mock('../services/correction-restrictions.service.js', () => ({
  invalidateCorrectionRestrictionsCache: vi.fn(),
}));

vi.mock('../services/access-catalog.service.js', () => ({
  loadAccessCatalog: vi.fn(async () => []),
  normalizeKnownPageAccessModes: vi.fn((modes: Record<string, string>) => modes),
  pageAccessRowsToModes: vi.fn(() => ({})),
  validatePageAccessModes: vi.fn(async () => null),
}));

vi.mock('../services/critical-admin-access.service.js', () => ({
  ensureCriticalAdminAccess: vi.fn(async () => undefined),
}));

vi.mock('../services/scope-cache.service.js', () => ({
  invalidateGlobalReadScopeCaches: vi.fn(),
}));

vi.mock('../socket/io-instance.js', () => ({
  getIo: vi.fn(() => null),
}));

import { rolesController } from './roles.controller.js';
import { invalidateGlobalReadScopeCaches } from '../services/scope-cache.service.js';

const mockInvalidateGlobalRead = vi.mocked(invalidateGlobalReadScopeCaches);

function baseRole(overrides: Partial<SystemRole> = {}): SystemRole {
  return {
    id: 'role-1',
    code: 'security',
    name: 'Отдел безопасности',
    description: null,
    is_admin: false,
    admin_access: false,
    manager_auto_access: true,
    employee_variant: 'office',
    is_active: true,
    show_actual_hours: false,
    hide_sidebar: false,
    view_all_departments: false,
    timesheet_months_back: 1,
    timesheet_months_forward: 1,
    timesheet_show_full_period: true,
    corrections_anomalies_only: false,
    corrections_cap_by_schedule_norm: false,
    corrections_allow_zero_short_attendance: false,
    corrections_disable_bulk: false,
    corrections_disable_object_entries: false,
    max_corrections_per_month: null,
    weekend_memo_required: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const state = {
  currentRole: baseRole(),
  updateSql: '',
  updateParams: [] as unknown[],
  insertSql: '',
  insertParams: [] as unknown[],
};

function extractFlagParam(sql: string, params: unknown[]): unknown {
  const match = sql.match(/view_all_departments = \$(\d+)/);
  if (!match) return undefined;
  return params[Number(match[1]) - 1];
}

function makeReq(body: Record<string, unknown>, code?: string): AuthenticatedRequest {
  return {
    params: code ? { code } : {},
    body,
    user: { id: 'admin-1', role_code: 'admin', is_admin: true },
  } as unknown as AuthenticatedRequest;
}

function makeRes() {
  const response = {
    statusCode: 200,
    payload: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(bodyArg: unknown) {
      this.payload = bodyArg;
      return this;
    },
  };
  return response as Response & { statusCode: number; payload: unknown };
}

beforeEach(() => {
  state.currentRole = baseRole();
  state.updateSql = '';
  state.updateParams = [];
  state.insertSql = '';
  state.insertParams = [];
  mockInvalidateGlobalRead.mockReset();
  pgQuery.mockReset().mockResolvedValue([]);
  pgExecute.mockReset().mockResolvedValue(undefined);
  pgTx.mockReset().mockImplementation(async (fn: (client: unknown) => Promise<unknown>) =>
    fn({ query: vi.fn(async () => ({ rows: [] })) }));
  pgQueryOne.mockReset().mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (/SELECT \* FROM system_roles WHERE code/.test(sql)) {
      return state.currentRole;
    }
    if (/UPDATE system_roles/.test(sql)) {
      state.updateSql = sql;
      state.updateParams = params;
      const flag = extractFlagParam(sql, params);
      return {
        ...state.currentRole,
        view_all_departments: flag === undefined ? state.currentRole.view_all_departments : Boolean(flag),
      };
    }
    if (/INSERT INTO system_roles/.test(sql)) {
      state.insertSql = sql;
      state.insertParams = params;
      const columns = sql.match(/\(([^)]+)\)\s*VALUES/)?.[1] ?? '';
      const idx = columns.split(',').map(s => s.trim()).indexOf('view_all_departments');
      return baseRole({
        code: String(params[0]),
        view_all_departments: idx >= 0 ? Boolean(params[idx]) : false,
      });
    }
    return null;
  });
});

describe('updateRole — view_all_departments', () => {
  it('включение флага обычной роли: сохраняется true и сбрасываются кеши данных', async () => {
    const res = makeRes();
    await rolesController.updateRole(makeReq({ name: 'Отдел безопасности', view_all_departments: true }, 'security'), res);
    expect(res.statusCode).toBe(200);
    expect(extractFlagParam(state.updateSql, state.updateParams)).toBe(true);
    expect(mockInvalidateGlobalRead).toHaveBeenCalledTimes(1);
  });

  it('роль timekeeper: значение нормализуется в false, кеши не сбрасываются', async () => {
    state.currentRole = baseRole({ code: 'timekeeper', name: 'Табельщица' });
    const res = makeRes();
    await rolesController.updateRole(makeReq({ name: 'Табельщица', view_all_departments: true }, 'timekeeper'), res);
    expect(res.statusCode).toBe(200);
    expect(extractFlagParam(state.updateSql, state.updateParams)).toBe(false);
    expect(mockInvalidateGlobalRead).not.toHaveBeenCalled();
  });

  it('admin-роль: значение нормализуется в false', async () => {
    state.currentRole = baseRole({ code: 'admin', name: 'Администратор', is_admin: true, admin_access: true });
    const res = makeRes();
    await rolesController.updateRole(makeReq({ name: 'Администратор', view_all_departments: true }, 'admin'), res);
    expect(res.statusCode).toBe(200);
    expect(extractFlagParam(state.updateSql, state.updateParams)).toBe(false);
  });

  it('обновление без поля: set-клауза не добавляется, кеши не сбрасываются', async () => {
    const res = makeRes();
    await rolesController.updateRole(makeReq({ name: 'Отдел безопасности' }, 'security'), res);
    expect(res.statusCode).toBe(200);
    expect(state.updateSql).not.toMatch(/view_all_departments/);
    expect(mockInvalidateGlobalRead).not.toHaveBeenCalled();
  });

  it('выключение включённого флага тоже сбрасывает кеши', async () => {
    state.currentRole = baseRole({ view_all_departments: true });
    const res = makeRes();
    await rolesController.updateRole(makeReq({ name: 'Отдел безопасности', view_all_departments: false }, 'security'), res);
    expect(res.statusCode).toBe(200);
    expect(extractFlagParam(state.updateSql, state.updateParams)).toBe(false);
    expect(mockInvalidateGlobalRead).toHaveBeenCalledTimes(1);
  });
});

describe('createRole — view_all_departments', () => {
  it('без поля в body → в INSERT уходит boolean false (не NULL)', async () => {
    const res = makeRes();
    await rolesController.createRole(makeReq({ code: 'new_role', name: 'Новая роль' }), res);
    expect(res.statusCode).toBe(201);
    expect(state.insertSql).toMatch(/view_all_departments/);
    const columns = state.insertSql.match(/\(([^)]+)\)\s*VALUES/)?.[1] ?? '';
    const idx = columns.split(',').map(s => s.trim()).indexOf('view_all_departments');
    expect(state.insertParams[idx]).toBe(false);
  });

  it('с флагом true у обычной роли → true', async () => {
    const res = makeRes();
    await rolesController.createRole(makeReq({ code: 'watcher', name: 'Наблюдатель', view_all_departments: true }), res);
    expect(res.statusCode).toBe(201);
    const columns = state.insertSql.match(/\(([^)]+)\)\s*VALUES/)?.[1] ?? '';
    const idx = columns.split(',').map(s => s.trim()).indexOf('view_all_departments');
    expect(state.insertParams[idx]).toBe(true);
  });
});

describe('cloneRole — view_all_departments', () => {
  it('клон наследует флаг источника (parsed ?? source ?? false)', async () => {
    state.currentRole = baseRole({ view_all_departments: true });
    const res = makeRes();
    await rolesController.cloneRole(
      makeReq({ code: 'security_copy', name: 'Копия СБ' }, 'security'),
      res,
    );
    expect(res.statusCode).toBe(201);
    const columns = state.insertSql.match(/\(([^)]+)\)\s*VALUES/)?.[1] ?? '';
    const idx = columns.split(',').map(s => s.trim()).indexOf('view_all_departments');
    expect(state.insertParams[idx]).toBe(true);
  });

  it('клон с is_admin=true нормализует флаг в false даже при флаге источника', async () => {
    state.currentRole = baseRole({ view_all_departments: true });
    const res = makeRes();
    await rolesController.cloneRole(
      makeReq({ code: 'security_admin', name: 'СБ-админ', is_admin: true }, 'security'),
      res,
    );
    expect(res.statusCode).toBe(201);
    const columns = state.insertSql.match(/\(([^)]+)\)\s*VALUES/)?.[1] ?? '';
    const idx = columns.split(',').map(s => s.trim()).indexOf('view_all_departments');
    expect(state.insertParams[idx]).toBe(false);
  });
});
