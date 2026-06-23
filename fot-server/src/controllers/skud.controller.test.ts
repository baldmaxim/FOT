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

const mockedState = vi.hoisted(() => {
  const state = {
    cache: new Map<string, string[]>(),
    isConfigured: vi.fn(() => false),
    getSigurAccessPoints: vi.fn(async () => [] as Record<string, unknown>[]),
    getAccessPointCacheEntry: vi.fn((key: string) => state.cache.get(key) ?? null),
    setAccessPointCacheEntry: vi.fn((key: string, data: string[]) => {
      state.cache.set(key, data);
    }),
  };

  return state;
});

vi.mock('../services/sigur.service.js', () => ({
  sigurService: {
    isConfigured: mockedState.isConfigured,
    getAccessPoints: mockedState.getSigurAccessPoints,
  },
}));

vi.mock('../services/skud-shared.service.js', () => ({
  getSyncFilteredEmployees: vi.fn(async () => null),
  queryEventsByEmployeeId: vi.fn(async () => []),
  searchAndBackfillByName: vi.fn(async () => []),
  getAccessPointCacheEntry: mockedState.getAccessPointCacheEntry,
  setAccessPointCacheEntry: mockedState.setAccessPointCacheEntry,
}));

vi.mock('../services/skud-dashboard.service.js', () => ({
  getDashboardStats: vi.fn(async () => null),
}));

vi.mock('../services/skud-presence.service.js', () => ({
  getPresence: vi.fn(async () => []),
}));

vi.mock('../services/skud-discipline.service.js', () => ({
  getDisciplineViolations: vi.fn(async () => ({ violations: [], employees: {}, departments: {} })),
}));

vi.mock('../services/skud-export.service.js', () => ({
  buildDisciplineWorkbook: vi.fn(),
  buildEmployeeSkudWorkbook: vi.fn(),
  formatMonthRangeLabel: vi.fn(),
  sanitizeExportFileName: vi.fn(),
}));

vi.mock('../services/data-scope.service.js', () => ({
  canAccessEmployeeInScope: vi.fn(async () => true),
  resolveScopedDepartmentId: vi.fn(async () => null),
  resolveRequestDataScope: vi.fn(async () => 'all'),
  resolveManagedDepartmentIds: vi.fn(async () => []),
  resolveAccessibleEmployeeIds: vi.fn(async () => 'all'),
  hasObjectViewScope: vi.fn(async () => false),
}));

vi.mock('../services/employee-skud-object-access.service.js', () => ({
  resolveAccessibleObjectIdsForRequest: vi.fn(async () => ({ is_unrestricted: true, object_ids: [] })),
}));

// getPresenceByObject (data fetch) мокаем; filterPresenceByEmployeeIds и
// mergePresenceResponses (чистые функции) берём настоящие через importActual.
const presenceByObjectMock = vi.hoisted(() => vi.fn());
vi.mock('../services/skud-presence-by-object.service.js', async () => {
  const actual = await vi.importActual<typeof import('../services/skud-presence-by-object.service.js')>(
    '../services/skud-presence-by-object.service.js',
  );
  return { ...actual, getPresenceByObject: presenceByObjectMock };
});

vi.mock('./skud-write.controller.js', () => ({
  skudWriteController: {},
}));

vi.mock('./skud-travel.controller.js', () => ({
  skudTravelController: {},
}));

import { skudController } from './skud.controller.js';
import { getDisciplineViolations } from '../services/skud-discipline.service.js';
import {
  resolveRequestDataScope,
  resolveManagedDepartmentIds,
  resolveAccessibleEmployeeIds,
  hasObjectViewScope,
} from '../services/data-scope.service.js';
import { resolveAccessibleObjectIdsForRequest } from '../services/employee-skud-object-access.service.js';
import type { IPresenceByObjectResponse } from '../services/skud-presence-by-object.service.js';

const mockGetDisciplineViolations = vi.mocked(getDisciplineViolations);
const mockResolveRequestDataScope = vi.mocked(resolveRequestDataScope);
const mockResolveManagedDepartmentIds = vi.mocked(resolveManagedDepartmentIds);
const mockResolveAccessibleEmployeeIds = vi.mocked(resolveAccessibleEmployeeIds);
const mockHasObjectViewScope = vi.mocked(hasObjectViewScope);
const mockResolveAccessibleObjectIds = vi.mocked(resolveAccessibleObjectIdsForRequest);

function makeReq(overrides: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest {
  return {
    params: {},
    query: {},
    body: {},
    user: {
      id: 'user-1',
      email: 'admin@example.com',
      position_type: 'admin',
      employee_id: 1,
      department_id: 'dept-1',
      is_approved: true,
      two_factor_enabled: false,
      two_factor_verified: true,
    },
    ...overrides,
  } as AuthenticatedRequest;
}

function makeRes() {
  const response = {
    statusCode: 200,
    payload: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.payload = body;
      return this;
    },
  };

  return response as Response & { statusCode: number; payload: unknown };
}

describe('skudController.getAccessPoints', () => {
  beforeEach(() => {
    pgQuery.mockReset();
    pgQueryOne.mockReset();
    pgExecute.mockReset();
    pgTx.mockReset();
    mockedState.cache.clear();
    mockedState.isConfigured.mockReset();
    mockedState.isConfigured.mockReturnValue(false);
    mockedState.getSigurAccessPoints.mockReset();
    mockedState.getSigurAccessPoints.mockResolvedValue([]);
    mockedState.getAccessPointCacheEntry.mockClear();
    mockedState.setAccessPointCacheEntry.mockClear();
  });

  it('returns access point metadata with ids from Sigur when includeMeta=1', async () => {
    mockedState.isConfigured.mockReturnValue(true);
    mockedState.getSigurAccessPoints.mockResolvedValue([
      { id: '112', name: 'Главный вход' },
      { id: 5, name: 'Боковой вход' },
      { id: 112, name: 'Главный вход' },
    ]);

    const req = makeReq({ query: { includeMeta: '1' } });
    const res = makeRes();

    await skudController.getAccessPoints(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({
      success: true,
      data: [
        { name: 'Боковой вход', id: 5 },
        { name: 'Главный вход', id: 112 },
      ],
    });
    expect(pgQuery).not.toHaveBeenCalled();
  });

  it('falls back to DB metadata with null ids when Sigur is unavailable', async () => {
    mockedState.isConfigured.mockReturnValue(true);
    mockedState.getSigurAccessPoints.mockRejectedValue(new Error('sigur down'));
    pgQuery.mockImplementation(async (sql: string) => {
      if (!/FROM skud_events/i.test(sql)) {
        throw new Error(`Unexpected SQL: ${sql}`);
      }
      return [
        { access_point: ' Главный вход ' },
        { access_point: 'Боковой вход' },
        { access_point: 'Главный вход' },
        { access_point: null },
      ];
    });

    const req = makeReq({ query: { includeMeta: '1' } });
    const res = makeRes();

    await skudController.getAccessPoints(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({
      success: true,
      data: [
        { name: 'Боковой вход', id: null },
        { name: 'Главный вход', id: null },
      ],
    });
    expect(mockedState.setAccessPointCacheEntry).toHaveBeenCalledWith('__all__', ['Боковой вход', 'Главный вход']);
  });

  it('keeps the legacy string[] response when includeMeta is not requested', async () => {
    mockedState.cache.set('__all__', ['Боковой вход', 'Главный вход']);

    const req = makeReq();
    const res = makeRes();

    await skudController.getAccessPoints(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({
      success: true,
      data: ['Боковой вход', 'Главный вход'],
    });
    expect(pgQuery).not.toHaveBeenCalled();
  });
});

describe('skudController.getDisciplineViolations (data-scope)', () => {
  const fullData = {
    violations: [
      { employee_id: 1, date: '2026-05-01', type: 'late', first_entry: '09:30:00', last_exit: '18:00:00', total_hours: 7, deviation: '-1' },
      { employee_id: 2, date: '2026-05-02', type: 'late', first_entry: '09:40:00', last_exit: '18:00:00', total_hours: 6, deviation: '-2' },
    ],
    employees: {
      1: { full_name: 'Иванов И.И.', position: null, department_id: 'dept-1' },
      2: { full_name: 'Петров П.П.', position: null, department_id: 'dept-2' },
    },
    departments: { 'dept-1': 'Отдел 1', 'dept-2': 'Отдел 2' },
  };

  beforeEach(() => {
    mockGetDisciplineViolations.mockReset();
    mockGetDisciplineViolations.mockResolvedValue(structuredClone(fullData) as never);
    mockResolveRequestDataScope.mockReset();
    mockResolveManagedDepartmentIds.mockReset();
    mockResolveManagedDepartmentIds.mockResolvedValue([]);
  });

  it('returns empty employees/violations for self scope (user without department)', async () => {
    mockResolveRequestDataScope.mockResolvedValue('self');

    const req = makeReq({ query: { startMonth: '2026-05' } });
    const res = makeRes();

    await skudController.getDisciplineViolations(req, res);

    expect(res.statusCode).toBe(200);
    const payload = res.payload as { success: boolean; data: typeof fullData };
    expect(payload.success).toBe(true);
    expect(payload.data.employees).toEqual({});
    expect(payload.data.violations).toEqual([]);
    expect(payload.data.departments).toEqual(fullData.departments);
  });

  it('returns the full dataset for system admin (all scope)', async () => {
    mockResolveRequestDataScope.mockResolvedValue('all');

    const req = makeReq({ query: { startMonth: '2026-05' } });
    const res = makeRes();

    await skudController.getDisciplineViolations(req, res);

    expect(res.statusCode).toBe(200);
    const payload = res.payload as { success: boolean; data: typeof fullData };
    expect(Object.keys(payload.data.employees)).toEqual(['1', '2']);
    expect(payload.data.violations).toHaveLength(2);
  });

  it('filters to managed departments for department scope', async () => {
    mockResolveRequestDataScope.mockResolvedValue('department');
    mockResolveManagedDepartmentIds.mockResolvedValue(['dept-1']);

    const req = makeReq({ query: { startMonth: '2026-05' } });
    const res = makeRes();

    await skudController.getDisciplineViolations(req, res);

    expect(res.statusCode).toBe(200);
    const payload = res.payload as { success: boolean; data: typeof fullData };
    expect(Object.keys(payload.data.employees)).toEqual(['1']);
    expect(payload.data.violations).toEqual([fullData.violations[0]]);
  });
});

describe('skudController.getPresenceByObject (object + employee union)', () => {
  function emp(id: number) {
    return {
      employee_id: id,
      full_name: `Сотрудник ${id}`,
      position_name: null,
      department_name: null,
      first_entry: '09:00:00',
      last_access_point: 'ap',
      since: '09:00:00',
      is_unsynced: false,
    };
  }

  function bucket(objectId: string, name: string, employees: ReturnType<typeof emp>[]) {
    return {
      object_id: objectId,
      object_name: name,
      has_map: false,
      online_count: employees.length,
      companies: [{ company_id: 'c', company_name: 'К', online_count: employees.length, employees }],
    };
  }

  // Снимок всех объектов: на ЖК Инжой — чужие (id 1,2), на Стройке-2 — его люди (10,11).
  const allSnapshot: IPresenceByObjectResponse = {
    generated_at: '2026-06-22T09:00:00Z',
    total_online: 4,
    scope_mode: 'all',
    buckets: [
      bucket('obj-assigned', 'ЖК Инжой', [emp(1), emp(2)]),
      bucket('obj-other', 'Стройка-2', [emp(10), emp(11)]),
    ],
  };
  const assignedSnapshot: IPresenceByObjectResponse = {
    generated_at: '2026-06-22T09:00:00Z',
    total_online: 2,
    scope_mode: 'object',
    buckets: [bucket('obj-assigned', 'ЖК Инжой', [emp(1), emp(2)])],
  };

  beforeEach(() => {
    presenceByObjectMock.mockReset();
    mockResolveAccessibleObjectIds.mockReset();
    mockResolveAccessibleEmployeeIds.mockReset();
    mockHasObjectViewScope.mockReset();
    mockHasObjectViewScope.mockResolvedValue(false);
    presenceByObjectMock.mockImplementation(async (opts?: { allowedObjectIds?: string[] | 'all' }) => {
      const ids = opts?.allowedObjectIds ?? 'all';
      if (ids === 'all') return structuredClone(allSnapshot);
      return structuredClone(assignedSnapshot);
    });
  });

  it('union: назначенный объект целиком + свои сотрудники на другом объекте (object_employee)', async () => {
    mockResolveAccessibleObjectIds.mockResolvedValue({ is_unrestricted: false, object_ids: ['obj-assigned'] });
    mockResolveAccessibleEmployeeIds.mockResolvedValue(new Set([10, 11]));

    const req = makeReq({ user: { id: 'u', position_type: 'site_supervisor', employee_id: 2521 } as never });
    const res = makeRes();
    await skudController.getPresenceByObject(req, res);

    expect(res.statusCode).toBe(200);
    const data = (res.payload as { data: IPresenceByObjectResponse & { scope_mode: string; assigned_object_ids: string[] } }).data;
    expect(data.scope_mode).toBe('object_employee');
    expect(data.assigned_object_ids).toEqual(['obj-assigned']);

    const assigned = data.buckets.find(b => b.object_id === 'obj-assigned')!;
    const other = data.buckets.find(b => b.object_id === 'obj-other')!;
    // Назначенный объект — целиком (2 чужих), без is_partial.
    expect(assigned.online_count).toBe(2);
    expect(assigned.is_partial).toBeUndefined();
    // Чужой объект — только его люди, помечен частичным.
    expect(other.online_count).toBe(2);
    expect(other.is_partial).toBe(true);
    expect(data.total_online).toBe(4);
  });

  it('без сотрудников на других объектах остаётся чистый object', async () => {
    mockResolveAccessibleObjectIds.mockResolvedValue({ is_unrestricted: false, object_ids: ['obj-assigned'] });
    // Его единственный доступный сотрудник присутствует только на назначенном объекте.
    mockResolveAccessibleEmployeeIds.mockResolvedValue(new Set([1]));

    const req = makeReq({ user: { id: 'u', position_type: 'site_supervisor', employee_id: 2521 } as never });
    const res = makeRes();
    await skudController.getPresenceByObject(req, res);

    const data = (res.payload as { data: IPresenceByObjectResponse & { scope_mode: string } }).data;
    expect(data.scope_mode).toBe('object');
    expect(data.buckets.every(b => !b.is_partial)).toBe(true);
    expect(data.buckets.find(b => b.object_id === 'obj-other')).toBeUndefined();
  });
});
