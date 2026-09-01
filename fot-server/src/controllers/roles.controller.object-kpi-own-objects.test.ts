import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest, SystemRole } from '../types/index.js';

/**
 * Флаг system_roles.object_kpi_own_objects_only (миграция 262): сохранение через
 * create/update/clone и серверная нормализация для админ-ролей — в том числе когда
 * роль становится админской без поля флага в запросе.
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

const FLAG = 'object_kpi_own_objects_only';

function baseRole(overrides: Partial<SystemRole> = {}): SystemRole {
  return {
    id: 'role-1',
    code: 'economist',
    name: 'Экономист',
    description: null,
    is_admin: false,
    admin_access: true,
    manager_auto_access: false,
    employee_variant: 'office',
    is_active: true,
    show_actual_hours: false,
    hide_sidebar: false,
    view_all_departments: false,
    object_kpi_own_objects_only: false,
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
  const match = sql.match(new RegExp(`${FLAG} = \\$(\\d+)`));
  if (!match) return undefined;
  return params[Number(match[1]) - 1];
}

function insertFlagParam(): unknown {
  const columns = state.insertSql.match(/\(([^)]+)\)\s*VALUES/)?.[1] ?? '';
  const idx = columns.split(',').map(s => s.trim()).indexOf(FLAG);
  return idx >= 0 ? state.insertParams[idx] : undefined;
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
        [FLAG]: flag === undefined ? state.currentRole[FLAG] : Boolean(flag),
      };
    }
    if (/INSERT INTO system_roles/.test(sql)) {
      state.insertSql = sql;
      state.insertParams = params;
      return baseRole({ code: String(params[0]), [FLAG]: Boolean(insertFlagParam()) });
    }
    return null;
  });
});

describe('updateRole — object_kpi_own_objects_only', () => {
  it('включение флага обычной роли сохраняется как true', async () => {
    const res = makeRes();
    await rolesController.updateRole(makeReq({ name: 'Экономист', [FLAG]: true }, 'economist'), res);
    expect(res.statusCode).toBe(200);
    expect(extractFlagParam(state.updateSql, state.updateParams)).toBe(true);
  });

  it('выключение флага сохраняется как false', async () => {
    state.currentRole = baseRole({ [FLAG]: true });
    const res = makeRes();
    await rolesController.updateRole(makeReq({ name: 'Экономист', [FLAG]: false }, 'economist'), res);
    expect(res.statusCode).toBe(200);
    expect(extractFlagParam(state.updateSql, state.updateParams)).toBe(false);
  });

  it('admin-роль: значение нормализуется в false', async () => {
    state.currentRole = baseRole({ code: 'admin', name: 'Администратор', is_admin: true });
    const res = makeRes();
    await rolesController.updateRole(makeReq({ name: 'Администратор', [FLAG]: true }, 'admin'), res);
    expect(res.statusCode).toBe(200);
    expect(extractFlagParam(state.updateSql, state.updateParams)).toBe(false);
  });

  it('роль становится админской БЕЗ поля флага в запросе → включённый флаг сбрасывается в false', async () => {
    state.currentRole = baseRole({ [FLAG]: true });
    const res = makeRes();
    await rolesController.updateRole(makeReq({ name: 'Экономист', is_admin: true }, 'economist'), res);
    expect(res.statusCode).toBe(200);
    expect(state.updateSql).toMatch(new RegExp(FLAG));
    expect(extractFlagParam(state.updateSql, state.updateParams)).toBe(false);
  });

  it('обновление без поля флага и без is_admin: set-клауза не добавляется', async () => {
    state.currentRole = baseRole({ [FLAG]: true });
    const res = makeRes();
    await rolesController.updateRole(makeReq({ name: 'Экономист' }, 'economist'), res);
    expect(res.statusCode).toBe(200);
    expect(state.updateSql).not.toMatch(new RegExp(FLAG));
  });
});

describe('createRole — object_kpi_own_objects_only', () => {
  it('без поля в body → в INSERT уходит boolean false (не NULL)', async () => {
    const res = makeRes();
    await rolesController.createRole(makeReq({ code: 'new_role', name: 'Новая роль' }), res);
    expect(res.statusCode).toBe(201);
    expect(state.insertSql).toMatch(new RegExp(FLAG));
    expect(insertFlagParam()).toBe(false);
  });

  it('с флагом true у обычной роли → true; у админ-роли → false', async () => {
    let res = makeRes();
    await rolesController.createRole(makeReq({ code: 'object_economist', name: 'Экономист объекта', [FLAG]: true }), res);
    expect(res.statusCode).toBe(201);
    expect(insertFlagParam()).toBe(true);

    res = makeRes();
    await rolesController.createRole(makeReq({ code: 'super_admin', name: 'Суперадмин', is_admin: true, [FLAG]: true }), res);
    expect(res.statusCode).toBe(201);
    expect(insertFlagParam()).toBe(false);
  });
});

describe('cloneRole — object_kpi_own_objects_only', () => {
  it('клон наследует флаг источника (parsed ?? source ?? false)', async () => {
    state.currentRole = baseRole({ [FLAG]: true });
    const res = makeRes();
    await rolesController.cloneRole(makeReq({ code: 'economist_copy', name: 'Копия' }, 'economist'), res);
    expect(res.statusCode).toBe(201);
    expect(insertFlagParam()).toBe(true);
  });

  it('клон с is_admin=true нормализует флаг в false даже при флаге источника', async () => {
    state.currentRole = baseRole({ [FLAG]: true });
    const res = makeRes();
    await rolesController.cloneRole(makeReq({ code: 'economist_admin', name: 'Эк-админ', is_admin: true }, 'economist'), res);
    expect(res.statusCode).toBe(201);
    expect(insertFlagParam()).toBe(false);
  });
});
