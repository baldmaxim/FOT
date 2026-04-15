import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

type QueryRecord = {
  table: string;
  operations: Array<{ method: string; args: unknown[] }>;
};

type QueryResponse = {
  data?: unknown;
  error?: { message: string } | null;
};

const mockedState = vi.hoisted(() => {
  const state = {
    queryLog: [] as QueryRecord[],
    resolver: (() => ({ data: [], error: null })) as (query: QueryRecord) => QueryResponse | Promise<QueryResponse>,
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

function createBuilder(table: string) {
  const query: QueryRecord = { table, operations: [] };
  mockedState.queryLog.push(query);

  const builder = {
    select: (...args: unknown[]) => {
      query.operations.push({ method: 'select', args });
      return builder;
    },
    not: (...args: unknown[]) => {
      query.operations.push({ method: 'not', args });
      return builder;
    },
    limit: (...args: unknown[]) => {
      query.operations.push({ method: 'limit', args });
      return builder;
    },
    then: (onFulfilled: (value: QueryResponse) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(mockedState.resolver(query)).then(onFulfilled, onRejected),
  };

  return builder;
}

vi.mock('../config/database.js', () => ({
  supabase: {
    from: vi.fn((table: string) => createBuilder(table)),
  },
}));

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
}));

vi.mock('./skud-write.controller.js', () => ({
  skudWriteController: {},
}));

vi.mock('./skud-travel.controller.js', () => ({
  skudTravelController: {},
}));

import { skudController } from './skud.controller.js';

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
    mockedState.queryLog.length = 0;
    mockedState.resolver = () => ({ data: [], error: null });
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
    expect(mockedState.queryLog).toHaveLength(0);
  });

  it('falls back to DB metadata with null ids when Sigur is unavailable', async () => {
    mockedState.isConfigured.mockReturnValue(true);
    mockedState.getSigurAccessPoints.mockRejectedValue(new Error('sigur down'));
    mockedState.resolver = (query) => {
      if (query.table !== 'skud_events') {
        throw new Error(`Unexpected table: ${query.table}`);
      }
      return {
        data: [
          { access_point: ' Главный вход ' },
          { access_point: 'Боковой вход' },
          { access_point: 'Главный вход' },
          { access_point: null },
        ],
        error: null,
      };
    };

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
    expect(mockedState.queryLog).toHaveLength(0);
  });
});
