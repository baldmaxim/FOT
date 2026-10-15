import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PUT /api/timesheet/object-entry — путь, которым руководитель вносит часы по объекту.
 * До фикса он вообще не вызывал резолвер согласования: строка писалась с DB-дефолтом
 * auto_approved, а статус менялся только при чьём-то ручном «Обновить» (кейс Павленкова
 * 18.07: первая отработанная суббота уехала в pending и была отклонена).
 *
 * Проверяем контракт маршрута: резолвер отрабатывает, значимое изменение снимает решение
 * согласующего, правка одного примечания — нет, записи идут через транзакционный exec под
 * advisory-lock, после мутации пересчитывается хвост месяца.
 *
 * Пользователь — админ (scope='all'): гарды доступа и окна периода не мешают проверке
 * самого маршрута, они покрыты отдельно.
 */

const {
  pgQuery, pgExecute, txQueries, upsertMock, deleteBySourceMock, getByIdMock, auditLogMock, purgeMock,
} = vi.hoisted(() => ({
  pgQuery: vi.fn(async () => [] as Array<Record<string, unknown>>),
  pgExecute: vi.fn(async () => 0),
  txQueries: [] as Array<{ sql: string; params: unknown[] }>,
  upsertMock: vi.fn(),
  deleteBySourceMock: vi.fn(async () => [] as number[]),
  getByIdMock: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
  auditLogMock: vi.fn(async () => undefined),
  purgeMock: vi.fn(async () => [] as string[]),
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
      query: async (sql: string, params?: unknown[]) => {
        txQueries.push({ sql, params: params ?? [] });
        return { rows: await pgQuery(sql, params), rowCount: 0 };
      },
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
  resolveSchedulesForPeriod: vi.fn(async () => new Map([[6006, { get: () => schedule }]])),
  isWorkingDay: vi.fn(() => false), // 18.07.2026 — суббота
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
  auditService: { logFromRequest: auditLogMock },
}));

vi.mock('../services/r2.service.js', () => ({
  r2Service: { isEnabledAsync: vi.fn(async () => false), deleteObject: vi.fn(async () => undefined) },
}));

vi.mock('../services/correction-attachments.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/correction-attachments.service.js')>()),
  purgeCorrectionAttachments: purgeMock,
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
import type { AuthenticatedRequest } from '../types/index.js';

const EMP = 6006;
const DATE = '2026-07-18'; // суббота
const OBJECT_KEY = 'obj-1';

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
  return res as { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
};

/** Существующая объектная строка, которую вернёт SELECT ... FOR UPDATE внутри лока. */
let existingRow: Record<string, unknown> | null = null;
/** Уже отработанные субботы месяца — кандидаты квоты (loadWorkedSaturdaysForQuota). */
let workedSaturdays: string[] = [];
/** Запись «на весь день» на (EMP, DATE), которую найдёт проверка в deleteObjectEntry. */
let dayLevelRow: Record<string, unknown> | null = null;
/** Строка, которую вернёт `DELETE ... WHERE id = $1 RETURNING id` в deleteEntry. */
let deletedById: Record<string, unknown> | null = null;

/** Пересчёт хвоста месяца (computeReapprovalTransitions) — выборка корректировок за месяц. */
const isTailReapprovalSql = (sql: string): boolean =>
  /work_date >= \$1 AND work_date <= \$2/.test(sql);
const tailReapprovalCalls = () => pgQuery.mock.calls.filter(c => isTailReapprovalSql(String(c[0])));

beforeEach(() => {
  vi.clearAllMocks();
  txQueries.length = 0;
  existingRow = null;
  workedSaturdays = [];
  dayLevelRow = null;
  deletedById = null;
  schedule.expected_saturdays_per_month = 1;
  upsertMock.mockImplementation(async (input: Record<string, unknown>) => ({
    id: 1085379, ...input, approval_status: input.approval_status ?? 'auto_approved',
  }));
  deleteBySourceMock.mockResolvedValue([]);
  pgQuery.mockImplementation(async (sql: string) => {
    if (/FOR UPDATE/i.test(sql)) return existingRow ? [existingRow] : [];
    if (/source_type IN \('manual', 'leave_request'\)/i.test(sql)) return dayLevelRow ? [dayLevelRow] : [];
    if (/DELETE FROM attendance_adjustments WHERE id = \$1/i.test(sql)) return deletedById ? [deletedById] : [];
    // Замок закрытого периода: период открыт. Ветку держим ПЕРЕД проверкой на
    // employees — SQL замка содержит подзапрос «FROM employees e», и без этого
    // условия он получил бы чужую строку и был бы прочитан как закрытый период.
    if (/WITH RECURSIVE pairs/i.test(sql)) return [];
    if (/FROM\s+employees/i.test(sql)) return [{ id: EMP, org_department_id: 'D1' }];
    if (/status = 'manual' AND hours_override > 0/i.test(sql)) {
      return workedSaturdays.map(d => ({ employee_id: EMP, work_date: d }));
    }
    return [];
  });
});

describe('upsertObjectEntry — резолвер согласования и advisory-lock', () => {
  it('первая отработанная суббота: строка получает auto_approved от резолвера (кейс Павленкова)', async () => {
    const res = buildRes();
    await timesheetController.upsertObjectEntry(
      buildReq({ employee_id: EMP, work_date: DATE, object_key: OBJECT_KEY, object_name: 'ЖК Stories', hours_worked: 8 }),
      res as never,
    );

    expect(upsertMock).toHaveBeenCalledTimes(1);
    const [input, exec] = upsertMock.mock.calls[0]!;
    expect(input.approval_status).toBe('auto_approved');
    expect(exec).toBeDefined(); // запись идёт через клиент транзакции, не через пул
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('вторая суббота месяца: строка уходит в pending', async () => {
    workedSaturdays = ['2026-07-04'];
    await timesheetController.upsertObjectEntry(
      buildReq({ employee_id: EMP, work_date: DATE, object_key: OBJECT_KEY, object_name: 'ЖК Stories', hours_worked: 8 }),
      buildRes() as never,
    );
    expect(upsertMock.mock.calls[0]![0].approval_status).toBe('pending');
  });

  it('advisory-lock (employee, YYYYMM) берётся до записи', async () => {
    await timesheetController.upsertObjectEntry(
      buildReq({ employee_id: EMP, work_date: DATE, object_key: OBJECT_KEY, object_name: 'ЖК Stories', hours_worked: 8 }),
      buildRes() as never,
    );
    const lock = txQueries.find(q => /pg_advisory_xact_lock/.test(q.sql));
    expect(lock).toBeDefined();
    expect(lock!.params).toEqual([EMP, 202607]);
  });

  it('пересохранение с ДРУГИМИ часами: статус пересчитывается, себя основанием не считает', async () => {
    // Квоту исчерпываем (04.07 уже занята), чтобы дойти до ветки «день уже согласован».
    workedSaturdays = ['2026-07-04'];
    existingRow = { id: 1085379, status: 'manual', hours_override: '8.00' };
    await timesheetController.upsertObjectEntry(
      buildReq({ employee_id: EMP, work_date: DATE, object_key: OBJECT_KEY, object_name: 'ЖК Stories', hours_worked: 7 }),
      buildRes() as never,
    );
    expect(upsertMock.mock.calls[0]![0]).toHaveProperty('approval_status');
    // hasApprovedWorkOnDate вызван с excludeAdjustmentId = id переписываемой строки.
    const workCall = pgQuery.mock.calls.find(c => /status = 'work'/i.test(String(c[0])));
    expect(workCall).toBeDefined();
    expect((workCall![1] as unknown[])[2]).toBe(1085379);
  });

  it('правка только примечания: approval_status не передаётся, решение согласующего живёт', async () => {
    existingRow = { id: 1085379, status: 'manual', hours_override: '8.00' };
    await timesheetController.upsertObjectEntry(
      buildReq({
        employee_id: EMP, work_date: DATE, object_key: OBJECT_KEY,
        object_name: 'ЖК Stories', hours_worked: 8, notes: 'уточнил формулировку',
      }),
      buildRes() as never,
    );
    expect(upsertMock.mock.calls[0]![0]).not.toHaveProperty('approval_status');
  });

  it('0 часов = удаление строки под тем же exec', async () => {
    deleteBySourceMock.mockResolvedValue([1085379]);
    const res = buildRes();
    await timesheetController.upsertObjectEntry(
      buildReq({ employee_id: EMP, work_date: DATE, object_key: OBJECT_KEY, object_name: 'ЖК Stories', hours_worked: 0 }),
      res as never,
    );
    expect(deleteBySourceMock).toHaveBeenCalledTimes(1);
    expect(deleteBySourceMock.mock.calls[0]![1]).toBeDefined();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ removed: true }) }),
    );
  });
});

/**
 * DELETE /api/timesheet/object-entry. Кейс Костроминой (Бозоров 13.10): корзина «эха»
 * корректировки на весь день слала сюда запрос, сервер удалял 0 строк manual_object
 * и отвечал «успехом» с аудитом — часы оставались на месте.
 */
describe('deleteObjectEntry — пустое удаление не выдаётся за успех', () => {
  const deleteBody = { employee_id: EMP, work_date: DATE, object_key: OBJECT_KEY };

  it.each(['manual', 'leave_request'])(
    'ничего не удалено, на день есть запись %s → 409, без аудита и пересчёта хвоста',
    async () => {
      dayLevelRow = { id: 1129176 };
      const res = buildRes();
      await timesheetController.deleteObjectEntry(buildReq(deleteBody), res as never);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false, code: 'DAY_LEVEL_CORRECTION',
      }));
      expect(auditLogMock).not.toHaveBeenCalled();
      expect(purgeMock).not.toHaveBeenCalled();
      expect(tailReapprovalCalls()).toHaveLength(0);
    },
  );

  it('ничего не удалено и дневной записи нет → 200 без аудита (повторный клик)', async () => {
    const res = buildRes();
    await timesheetController.deleteObjectEntry(buildReq(deleteBody), res as never);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ success: true, data: null });
    expect(auditLogMock).not.toHaveBeenCalled();
    expect(tailReapprovalCalls()).toHaveLength(0);
  });

  it('удалена строка manual_object → 200, чистка файлов, пересчёт хвоста и один аудит', async () => {
    deleteBySourceMock.mockResolvedValue([1085379]);
    const res = buildRes();
    await timesheetController.deleteObjectEntry(buildReq(deleteBody), res as never);

    expect(res.json).toHaveBeenCalledWith({ success: true, data: null });
    expect(purgeMock).toHaveBeenCalledWith(1085379);
    expect(tailReapprovalCalls().length).toBeGreaterThan(0);
    expect(auditLogMock).toHaveBeenCalledTimes(1);
    expect(auditLogMock.mock.calls[0]![2]).toBe('UPDATE_TIMESHEET_ENTRY');
  });
});

describe('deleteEntry — мигрированная дневная строка manual_object', () => {
  const buildDeleteEntryReq = (id: number): AuthenticatedRequest => ({
    ...buildReq({}),
    params: { id: String(id) },
  } as unknown as AuthenticatedRequest);

  it('migrated_from_day_level → удаляется как дневная', async () => {
    getByIdMock.mockResolvedValue({
      id: 777, employee_id: EMP, work_date: DATE, source_type: 'manual_object', source_id: OBJECT_KEY,
      metadata: { migrated_from_day_level: true, object_id: OBJECT_KEY },
    });
    deletedById = { id: 777 };
    const res = buildRes();
    await timesheetController.deleteEntry(buildDeleteEntryReq(777), res as never);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ success: true });
    expect(auditLogMock.mock.calls[0]![2]).toBe('DELETE_TIMESHEET_ENTRY');
  });

  it('обычная manual_object → прежний 409', async () => {
    getByIdMock.mockResolvedValue({
      id: 778, employee_id: EMP, work_date: DATE, source_type: 'manual_object', source_id: OBJECT_KEY,
      metadata: { object_id: OBJECT_KEY },
    });
    const res = buildRes();
    await timesheetController.deleteEntry(buildDeleteEntryReq(778), res as never);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(auditLogMock).not.toHaveBeenCalled();
  });
});
