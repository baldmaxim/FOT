import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PUT /api/timesheet/object-entry/bulk — массовое применение объектных правок.
 *
 * Появился после инцидента 17.08.2026: фронт слал по запросу на ячейку через
 * Promise.all, сотня одновременных PUT по HTTP/2 исчерпывала пул соединений
 * (DATABASE_POOL_MAX=10, connectionTimeoutMillis=5с) и все они падали с 500.
 *
 * Проверяем контракт, на который опирается фронт:
 *  - элементы обрабатываются ПОСЛЕДОВАТЕЛЬНО в детерминированном порядке;
 *  - дубли схлопываются, побеждает последний, но ответ есть на каждый элемент;
 *  - частичный сбой = 200 + непустой failed (иначе api-клиент бросит ApiError);
 *  - насыщение пула до первой записи = 503, после = 200 с db_pool_busy в failed;
 *  - превышение лимита элементов = 400 до любых записей.
 */

const {
  pgQuery, pgExecute, upsertMock, deleteBySourceMock, getByIdMock,
} = vi.hoisted(() => ({
  pgQuery: vi.fn(async () => [] as Array<Record<string, unknown>>),
  pgExecute: vi.fn(async () => 0),
  upsertMock: vi.fn(),
  deleteBySourceMock: vi.fn(async () => [] as number[]),
  getByIdMock: vi.fn(async () => null),
}));

vi.mock('../config/postgres.js', async (importActual) => ({
  ...(await importActual<typeof import('../config/postgres.js')>()),
  query: pgQuery,
  execute: pgExecute,
  queryWith: async (exec: unknown, sql: string, params?: unknown[]) => {
    if (!exec) throw new Error(`queryWith без exec под локом: ${sql}`);
    return pgQuery(sql, params);
  },
  queryOneWith: async (exec: unknown, sql: string, params?: unknown[]) =>
    (await pgQuery(sql, params))[0] ?? null,
  executeWith: async (exec: unknown, sql: string, params?: unknown[]) => {
    if (!exec) throw new Error(`executeWith без exec под локом: ${sql}`);
    return pgExecute(sql, params);
  },
  withTransaction: async (fn: (client: unknown) => Promise<unknown>) => {
    const client = {
      query: async (sql: string, params?: unknown[]) => ({ rows: await pgQuery(sql, params), rowCount: 0 }),
    };
    return fn(client);
  },
}));

const { requiredSet } = vi.hoisted(() => ({ requiredSet: new Set<string>(['D1']) }));
vi.mock('../services/correction-approval-settings.service.js', () => ({
  correctionApprovalSettingsService: { getRequiredDepartmentIds: vi.fn(async () => requiredSet) },
}));

const { schedule, calendar } = vi.hoisted(() => ({
  schedule: {
    pattern_type: '5+2',
    expected_saturdays_per_month: 1,
    expected_sundays_per_month: 0,
    respects_holidays: true,
    work_days: [1, 2, 3, 4, 5],
  },
  calendar: { holidays: [] as string[], mandatory_holidays: [] as string[] },
}));

vi.mock('../services/schedule.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/schedule.service.js')>()),
  resolveSchedulesForPeriod: vi.fn(async () => new Map()),
  isWorkingDay: vi.fn(() => true),
  isHolidayOnWorkday: vi.fn(() => false),
  loadCalendarMonth: vi.fn(async () => calendar),
}));

vi.mock('../services/data-scope.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/data-scope.service.js')>()),
  resolveAccessibleDepartmentIds: vi.fn(async () => 'all'),
}));

vi.mock('../services/attendance.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/attendance.service.js')>()),
  upsertAttendanceAdjustment: upsertMock,
  deleteAttendanceAdjustmentBySource: deleteBySourceMock,
  getAttendanceAdjustmentById: getByIdMock,
}));

vi.mock('../services/correction-restrictions.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/correction-restrictions.service.js')>()),
  assertObjectCorrectionsAllowed: vi.fn(async () => undefined),
  assertCorrectionAllowed: vi.fn(async () => undefined),
}));

vi.mock('../services/audit.service.js', () => ({
  AUDIT_ACTIONS: { UPDATE_TIMESHEET_ENTRY: 'UPDATE_TIMESHEET_ENTRY' },
  auditService: { logFromRequest: vi.fn(async () => undefined) },
}));

vi.mock('../services/r2.service.js', () => ({
  r2Service: { isEnabledAsync: vi.fn(async () => false), deleteObject: vi.fn(async () => undefined) },
}));

vi.mock('../services/correction-attachments.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/correction-attachments.service.js')>()),
  purgeCorrectionAttachments: vi.fn(async () => [] as string[]),
}));

vi.mock('../services/audit-context.helpers.js', () => ({
  loadEmployeeFullName: vi.fn(async () => 'Тестов Т. Т.'),
  loadEmployeeFullNamesMap: vi.fn(async () => new Map<number, string>()),
}));

vi.mock('../services/skud-realtime.service.js', () => ({
  notifySkudRealtimeChanged: vi.fn(),
  invalidateSkudRealtimeCaches: vi.fn(),
}));

import { timesheetController } from './timesheet.controller.js';
import { auditService } from '../services/audit.service.js';
import { DB_POOL_BUSY_CODE } from '../utils/pg-errors.js';
import type { AuthenticatedRequest } from '../types/index.js';

const buildReq = (body: Record<string, unknown>): AuthenticatedRequest => ({
  body,
  user: {
    id: 'USER-UUID',
    system_role_id: 'ROLE-UUID',
    role_code: 'admin',
    is_admin: true,
    employee_id: 345,
  },
  headers: {},
} as unknown as AuthenticatedRequest);

const buildRes = () => {
  const res: Record<string, unknown> = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res as {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
    setHeader: ReturnType<typeof vi.fn>;
  };
};

const item = (overrides: Record<string, unknown>) => ({
  client_item_id: 'cell-1',
  employee_id: 6006,
  work_date: '2026-08-03',
  object_key: 'obj-1',
  object_name: 'ЖК Stories',
  hours_worked: 8,
  ...overrides,
});

/** Полезная нагрузка последнего res.json. */
const payload = (res: ReturnType<typeof buildRes>) =>
  res.json.mock.calls[res.json.mock.calls.length - 1]![0] as {
    success: boolean;
    error?: string;
    code?: string;
    data?: {
      total_items: number;
      processed: number;
      succeeded: Array<{ client_item_id: string | null; adjustment_id: number | null }>;
      failed: Array<{ client_item_id: string | null; status: number; code: string | null }>;
      duplicates: Array<{ client_item_id: string | null; applied_client_item_id: string | null; adjustment_id: number | null }>;
    };
  };

let nextId = 1;

beforeEach(() => {
  vi.clearAllMocks();
  nextId = 1;
  upsertMock.mockImplementation(async (input: Record<string, unknown>) => ({
    id: nextId++, ...input, approval_status: input.approval_status ?? 'auto_approved',
  }));
  deleteBySourceMock.mockResolvedValue([]);
  pgQuery.mockImplementation(async (sql: string) => {
    if (/FOR UPDATE/i.test(sql)) return [];
    if (/FROM\s+employees/i.test(sql)) return [{ id: 6006, org_department_id: 'D1' }];
    return [];
  });
});

describe('upsertObjectEntriesBulk', () => {
  it('сохраняет все элементы последовательно и в порядке (employee_id, work_date)', async () => {
    const res = buildRes();
    await timesheetController.upsertObjectEntriesBulk(
      buildReq({
        items: [
          item({ client_item_id: 'c3', employee_id: 6007, work_date: '2026-08-04' }),
          item({ client_item_id: 'c1', employee_id: 6006, work_date: '2026-08-05' }),
          item({ client_item_id: 'c2', employee_id: 6006, work_date: '2026-08-03' }),
        ],
      }),
      res as never,
    );

    const body = payload(res);
    expect(body.success).toBe(true);
    expect(body.data!.processed).toBe(3);
    expect(body.data!.failed).toHaveLength(0);
    expect(upsertMock).toHaveBeenCalledTimes(3);
    expect(upsertMock.mock.calls.map(call => [call[0].employee_id, call[0].work_date])).toEqual([
      [6006, '2026-08-03'],
      [6006, '2026-08-05'],
      [6007, '2026-08-04'],
    ]);
    // Ответ есть на каждый исходный элемент — фронт цепляет вложения по client_item_id.
    expect(body.data!.succeeded.map(s => s.client_item_id).sort()).toEqual(['c1', 'c2', 'c3']);
  });

  it('дубль ячейки: побеждает последний, вытесненный получает id победителя', async () => {
    const res = buildRes();
    await timesheetController.upsertObjectEntriesBulk(
      buildReq({
        items: [
          item({ client_item_id: 'first', hours_worked: 4 }),
          item({ client_item_id: 'last', hours_worked: 9 }),
        ],
      }),
      res as never,
    );

    const body = payload(res);
    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(upsertMock.mock.calls[0]![0].hours_override).toBe(9);
    expect(body.data!.total_items).toBe(2);
    expect(body.data!.processed).toBe(1);
    expect(body.data!.succeeded).toHaveLength(1);
    expect(body.data!.succeeded[0]!.client_item_id).toBe('last');
    expect(body.data!.duplicates).toHaveLength(1);
    expect(body.data!.duplicates[0]).toMatchObject({
      client_item_id: 'first',
      applied_client_item_id: 'last',
      adjustment_id: body.data!.succeeded[0]!.adjustment_id,
    });
  });

  it('сбой одного элемента: 200 с непустым failed, остальные сохранены', async () => {
    upsertMock.mockImplementation(async (input: Record<string, unknown>) => {
      if (input.work_date === '2026-08-04') throw new Error('boom');
      return { id: nextId++, ...input, approval_status: 'auto_approved' };
    });

    const res = buildRes();
    await timesheetController.upsertObjectEntriesBulk(
      buildReq({
        items: [
          item({ client_item_id: 'ok', work_date: '2026-08-03' }),
          item({ client_item_id: 'bad', work_date: '2026-08-04' }),
        ],
      }),
      res as never,
    );

    const body = payload(res);
    expect(res.status).not.toHaveBeenCalled(); // именно 200, а не 4xx/5xx
    expect(body.success).toBe(true);
    expect(body.data!.succeeded.map(s => s.client_item_id)).toEqual(['ok']);
    expect(body.data!.failed).toHaveLength(1);
    expect(body.data!.failed[0]).toMatchObject({ client_item_id: 'bad', status: 500 });
  });

  it('насыщение пула до первой записи: 503 db_pool_busy, аудит не пишется', async () => {
    upsertMock.mockImplementation(async () => {
      throw new Error('timeout exceeded when trying to connect');
    });

    const res = buildRes();
    await timesheetController.upsertObjectEntriesBulk(
      buildReq({ items: [item({ client_item_id: 'a' }), item({ client_item_id: 'b', work_date: '2026-08-04' })] }),
      res as never,
    );

    expect(res.status).toHaveBeenCalledWith(503);
    expect(payload(res).code).toBe(DB_POOL_BUSY_CODE);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '1');
    expect(auditService.logFromRequest).not.toHaveBeenCalled();
  });

  it('насыщение пула в середине: 200, остаток батча помечен db_pool_busy', async () => {
    upsertMock.mockImplementation(async (input: Record<string, unknown>) => {
      if (input.work_date !== '2026-08-03') throw new Error('timeout exceeded when trying to connect');
      return { id: nextId++, ...input, approval_status: 'auto_approved' };
    });

    const res = buildRes();
    await timesheetController.upsertObjectEntriesBulk(
      buildReq({
        items: [
          item({ client_item_id: 'ok', work_date: '2026-08-03' }),
          item({ client_item_id: 'busy1', work_date: '2026-08-04' }),
          item({ client_item_id: 'busy2', work_date: '2026-08-05' }),
        ],
      }),
      res as never,
    );

    const body = payload(res);
    expect(res.status).not.toHaveBeenCalled();
    expect(body.data!.succeeded.map(s => s.client_item_id)).toEqual(['ok']);
    expect(body.data!.failed.map(f => f.client_item_id)).toEqual(['busy1', 'busy2']);
    expect(body.data!.failed.every(f => f.code === DB_POOL_BUSY_CODE)).toBe(true);
    // Второй элемент упал на аренде коннекта, третий даже не пытался.
    expect(upsertMock).toHaveBeenCalledTimes(2);
  });

  it('превышение лимита элементов: 400 до единой записи', async () => {
    const res = buildRes();
    await timesheetController.upsertObjectEntriesBulk(
      buildReq({
        items: Array.from({ length: 201 }, (_, i) => item({
          client_item_id: `c${i}`,
          work_date: `2026-08-${String((i % 28) + 1).padStart(2, '0')}`,
        })),
      }),
      res as never,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(upsertMock).not.toHaveBeenCalled();
  });
});
