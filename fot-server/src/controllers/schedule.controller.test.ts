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

const mockedState = vi.hoisted(() => ({
  queryLog: [] as QueryRecord[],
  resolver: (() => ({ data: [], error: null })) as (query: QueryRecord) => QueryResponse | Promise<QueryResponse>,
  scope: 'all' as 'all' | 'department' | 'self' | null,
}));

function createBuilder(table: string) {
  const query: QueryRecord = { table, operations: [] };
  mockedState.queryLog.push(query);

  const builder = {
    select: (...args: unknown[]) => {
      query.operations.push({ method: 'select', args });
      return builder;
    },
    in: (...args: unknown[]) => {
      query.operations.push({ method: 'in', args });
      return builder;
    },
    eq: (...args: unknown[]) => {
      query.operations.push({ method: 'eq', args });
      return builder;
    },
    neq: (...args: unknown[]) => {
      query.operations.push({ method: 'neq', args });
      return builder;
    },
    order: (...args: unknown[]) => {
      query.operations.push({ method: 'order', args });
      return builder;
    },
    update: (...args: unknown[]) => {
      query.operations.push({ method: 'update', args });
      return builder;
    },
    delete: (...args: unknown[]) => {
      query.operations.push({ method: 'delete', args });
      return builder;
    },
    insert: (...args: unknown[]) => {
      query.operations.push({ method: 'insert', args });
      return builder;
    },
    limit: (...args: unknown[]) => {
      query.operations.push({ method: 'limit', args });
      return builder;
    },
    lte: (...args: unknown[]) => {
      query.operations.push({ method: 'lte', args });
      return builder;
    },
    or: (...args: unknown[]) => {
      query.operations.push({ method: 'or', args });
      return builder;
    },
    single: async () => mockedState.resolver(query),
    maybeSingle: async () => mockedState.resolver(query),
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

vi.mock('../services/schedule.service.js', () => ({
  resolveSchedule: vi.fn(),
  resolveSchedulesBulk: vi.fn(),
}));

vi.mock('../services/data-scope.service.js', () => ({
  resolveRequestDataScope: vi.fn(async () => mockedState.scope),
  resolveScopedDepartmentIds: vi.fn(async (req: AuthenticatedRequest, departmentIds?: string[] | null) => {
    if (mockedState.scope !== 'department') {
      return departmentIds || [];
    }
    const allowedDepartmentId = req.user.department_id;
    return (departmentIds || []).filter(departmentId => departmentId === allowedDepartmentId);
  }),
}));

import { scheduleController } from './schedule.controller.js';

const BRIGADE_1 = '11111111-1111-4111-8111-111111111111';
const BRIGADE_2 = '22222222-2222-4222-8222-222222222222';
const SCHEDULE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function getOperationArg(query: QueryRecord, method: string, column: string): unknown {
  return query.operations.find(op => op.method === method && op.args[0] === column)?.args[1];
}

function makeReq(overrides: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest {
  return {
    params: {},
    query: {},
    body: {},
    user: {
      id: 'user-1',
      email: 'admin@example.com',
      position_type: 'admin',
      employee_id: 7,
      department_id: BRIGADE_1,
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

describe('scheduleController.bulkApplyToBrigades', () => {
  beforeEach(() => {
    mockedState.queryLog.length = 0;
    mockedState.scope = 'all';
    mockedState.resolver = () => ({ data: [], error: null });
  });

  it('rejects invalid payload before touching the database', async () => {
    const req = makeReq({
      body: {
        department_ids: ['not-a-uuid'],
        action: 'assign',
        schedule_id: SCHEDULE_ID,
        effective_date: '2026-04-20',
      },
    });
    const res = makeRes();

    await scheduleController.bulkApplyToBrigades(req, res);

    expect(res.statusCode).toBe(400);
    expect(mockedState.queryLog).toHaveLength(0);
  });

  it('assigns a schedule to active employees from selected brigades', async () => {
    mockedState.resolver = (query) => {
      if (query.table === 'org_departments') {
        return {
          data: [
            { id: BRIGADE_1, name: 'Бр. Монолит' },
            { id: BRIGADE_2, name: ' бр. Отделка ' },
          ],
          error: null,
        };
      }

      if (query.table === 'employees') {
        return {
          data: [{ id: 101 }, { id: 102 }],
          error: null,
        };
      }

      if (query.table === 'employee_schedule_assignments') {
        if (query.operations.some(op => op.method === 'insert')) {
          return {
            data: { id: 'new-assignment' },
            error: null,
          };
        }

        if (query.operations.some(op => op.method === 'update')) {
          return {
            data: { id: getOperationArg(query, 'eq', 'id') },
            error: null,
          };
        }

        const batchIn = query.operations.find(op => op.method === 'in' && op.args[0] === 'employee_id');
        if (batchIn) {
          return {
            data: [
              {
                id: 'existing-102',
                employee_id: 102,
                schedule_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                effective_from: '2026-04-01',
                effective_to: null,
              },
            ],
            error: null,
          };
        }
      }

      throw new Error(`Unexpected query: ${query.table}`);
    };

    const req = makeReq({
      body: {
        department_ids: [BRIGADE_1, BRIGADE_2],
        action: 'assign',
        schedule_id: SCHEDULE_ID,
        effective_date: '2026-04-20',
      },
    });
    const res = makeRes();

    await scheduleController.bulkApplyToBrigades(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({
      success: true,
      data: {
        departments_processed: 2,
        employees_matched: 2,
        employees_updated: 2,
      },
    });

    const insertQueries = mockedState.queryLog.filter(query => query.table === 'employee_schedule_assignments' && query.operations.some(op => op.method === 'insert'));
    expect(insertQueries).toHaveLength(2);
    const updateQuery = mockedState.queryLog.find(query => (
      query.table === 'employee_schedule_assignments'
      && query.operations.some(op => op.method === 'update')
      && query.operations.some(op => op.method === 'eq' && op.args[1] === 'existing-102')
    ));
    expect(updateQuery?.operations).toEqual(expect.arrayContaining([
      {
        method: 'update',
        args: [expect.objectContaining({ effective_to: '2026-04-19' })],
      },
    ]));
  });

  it('resets personal schedules and reports only actually updated employees', async () => {
    mockedState.resolver = (query) => {
      if (query.table === 'org_departments') {
        return {
          data: [{ id: BRIGADE_1, name: 'Бр. 1' }],
          error: null,
        };
      }

      if (query.table === 'employees') {
        return {
          data: [{ id: 201 }, { id: 202 }],
          error: null,
        };
      }

      if (query.table === 'employee_schedule_assignments') {
        if (query.operations.some(op => op.method === 'update')) {
          return { data: { id: 'existing-201' }, error: null };
        }

        const batchIn = query.operations.find(op => op.method === 'in' && op.args[0] === 'employee_id');
        if (batchIn) {
          return {
            data: [
              {
                id: 'existing-201',
                employee_id: 201,
                schedule_id: SCHEDULE_ID,
                effective_from: '2026-04-01',
                effective_to: null,
              },
            ],
            error: null,
          };
        }
      }

      throw new Error(`Unexpected query: ${query.table}`);
    };

    const req = makeReq({
      body: {
        department_ids: [BRIGADE_1],
        action: 'reset',
        effective_date: '2026-04-25',
      },
    });
    const res = makeRes();

    await scheduleController.bulkApplyToBrigades(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({
      success: true,
      data: {
        departments_processed: 1,
        employees_matched: 2,
        employees_updated: 1,
      },
    });
    const updateQuery = mockedState.queryLog.find(query => (
      query.table === 'employee_schedule_assignments'
      && query.operations.some(op => op.method === 'update')
    ));
    expect(updateQuery?.operations).toEqual(expect.arrayContaining([
      {
        method: 'update',
        args: [expect.objectContaining({ effective_to: '2026-04-24' })],
      },
    ]));
  });

  it('rejects departments that are not brigades', async () => {
    mockedState.resolver = (query) => {
      if (query.table === 'org_departments') {
        return {
          data: [{ id: BRIGADE_1, name: 'Отдел снабжения' }],
          error: null,
        };
      }
      throw new Error(`Unexpected query: ${query.table}`);
    };

    const req = makeReq({
      body: {
        department_ids: [BRIGADE_1],
        action: 'assign',
        schedule_id: SCHEDULE_ID,
        effective_date: '2026-04-20',
      },
    });
    const res = makeRes();

    await scheduleController.bulkApplyToBrigades(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.payload).toEqual({ success: false, error: 'Можно выбирать только отделы-бригады' });
    expect(mockedState.queryLog).toHaveLength(1);
  });

  it('rejects selection outside department scope', async () => {
    mockedState.scope = 'department';
    const req = makeReq({
      body: {
        department_ids: [BRIGADE_2],
        action: 'assign',
        schedule_id: SCHEDULE_ID,
        effective_date: '2026-04-20',
      },
    });
    const res = makeRes();

    await scheduleController.bulkApplyToBrigades(req, res);

    expect(res.statusCode).toBe(403);
    expect(res.payload).toEqual({ success: false, error: 'Можно назначать график только по своей бригаде' });
    expect(mockedState.queryLog).toHaveLength(0);
  });

  it('returns success when selected brigades have no active employees', async () => {
    mockedState.resolver = (query) => {
      if (query.table === 'org_departments') {
        return {
          data: [{ id: BRIGADE_1, name: 'Бр. 1' }],
          error: null,
        };
      }

      if (query.table === 'employees') {
        return {
          data: [],
          error: null,
        };
      }

      throw new Error(`Unexpected query: ${query.table}`);
    };

    const req = makeReq({
      body: {
        department_ids: [BRIGADE_1],
        action: 'assign',
        schedule_id: SCHEDULE_ID,
        effective_date: '2026-04-20',
      },
    });
    const res = makeRes();

    await scheduleController.bulkApplyToBrigades(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({
      success: true,
      data: {
        departments_processed: 1,
        employees_matched: 0,
        employees_updated: 0,
      },
    });
  });
});
