import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * POST /api/timesheet — дневная форма табеля и привязка корректировки к ОБЪЕКТУ.
 *
 * Кейс, из которого выросли эти проверки: 01.09 у Сайфуллаева не сработал пропуск на
 * вход (два «доступ запрещён»), успешным был только выход на ЖК Wave. Пары нет, минут
 * нет — и корректировка на 11 ч уезжала на ЖК Ситибэй по правилу «максимум событий за
 * 90 дней». Теперь такой день требует явного подтверждения объекта, а распределение
 * хранится в metadata ТОЙ ЖЕ дневной строки (source_type='manual'), поэтому id, автор,
 * вложения и согласование переживают смену объекта.
 *
 * Пользователь — админ (scope='all'): гарды доступа и окна периода проверяются отдельно.
 */

const {
  pgQuery, pgExecute, txQueries, upsertMock, deleteBySourceMock, getByIdMock,
  suggestMock, listSelectableMock, roleAllowsMock, updateByIdMock,
} = vi.hoisted(() => ({
  pgQuery: vi.fn(async () => [] as Array<Record<string, unknown>>),
  pgExecute: vi.fn(async () => 0),
  txQueries: [] as Array<{ sql: string; params: unknown[] }>,
  upsertMock: vi.fn(),
  deleteBySourceMock: vi.fn(async () => [] as number[]),
  getByIdMock: vi.fn(async () => null as Record<string, unknown> | null),
  suggestMock: vi.fn(),
  listSelectableMock: vi.fn(async () => [] as Array<{ object_id: string; object_name: string }>),
  roleAllowsMock: vi.fn(async () => true),
  updateByIdMock: vi.fn(),
}));

vi.mock('../config/postgres.js', async (importActual) => ({
  ...(await importActual<typeof import('../config/postgres.js')>()),
  query: pgQuery,
  queryOne: async (sql: string, params?: unknown[]) => (await pgQuery(sql, params))[0] ?? null,
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

vi.mock('../services/correction-approval-settings.service.js', () => ({
  correctionApprovalSettingsService: {
    getRequiredDepartmentIds: vi.fn(async () => new Set<string>()),
  },
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
  isWorkingDay: vi.fn(() => false),
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
  updateAttendanceAdjustmentById: updateByIdMock,
}));

// Резолвер подсказки мокаем: правила приоритетов покрыты unit-тестами сервиса,
// здесь проверяется решение КОНТРОЛЛЕРА по готовому вердикту.
vi.mock('../services/timesheet-object.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/timesheet-object.service.js')>()),
  resolveDayAllocationSuggestion: suggestMock,
}));

vi.mock('../services/employee-skud-object-access.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/employee-skud-object-access.service.js')>()),
  listSelectableObjectsForEmployee: listSelectableMock,
}));

vi.mock('../services/correction-restrictions.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/correction-restrictions.service.js')>()),
  assertObjectCorrectionsAllowed: vi.fn(async () => undefined),
  assertCorrectionAllowed: vi.fn(async () => undefined),
  areObjectCorrectionsAllowed: roleAllowsMock,
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
  loadEmployeeFullName: vi.fn(async () => 'Сайфуллаев К. Т.'),
  loadEmployeeFullNamesMap: vi.fn(async () => new Map<number, string>()),
}));

vi.mock('../services/skud-realtime.service.js', () => ({
  notifySkudRealtimeChanged: vi.fn(),
  invalidateSkudRealtimeCaches: vi.fn(),
}));

import { timesheetController } from './timesheet.controller.js';
import type { AuthenticatedRequest } from '../types/index.js';

const EMP = 6006;
const DATE = '2026-09-01';
const WAVE = { object_id: 'obj-wave', object_name: 'ЖК Wave' };
const CITYBAY = { object_id: 'obj-citybay', object_name: 'ЖК Ситибэй' };

/** Подсказка «объект известен, но подтверждение обязательно» — случай Сайфуллаева. */
const unpairedSuggestion = {
  distribution: [{ ...WAVE, minutes: 0 }],
  resolution_source: 'skud_day_unpaired' as const,
  requires_allocation: true,
  ambiguous: false,
  candidates: [WAVE],
};

/** Надёжные минуты по объектам: подтверждать не нужно, день раскладывается сам. */
const reliableSuggestion = {
  distribution: [{ ...CITYBAY, minutes: 480 }],
  resolution_source: 'skud_day' as const,
  requires_allocation: false,
  ambiguous: false,
  candidates: [],
};

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

const lastUpsert = () => upsertMock.mock.calls[0]![0] as Record<string, unknown>;
const lastMeta = () => (lastUpsert().metadata ?? {}) as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  txQueries.length = 0;
  upsertMock.mockImplementation(async (input: Record<string, unknown>) => ({
    id: 900100, ...input, approval_status: input.approval_status ?? 'auto_approved',
  }));
  deleteBySourceMock.mockResolvedValue([]);
  getByIdMock.mockResolvedValue(null);
  updateByIdMock.mockImplementation(async (_id: number, patch: Record<string, unknown>) => ({
    id: EXISTING_ID, employee_id: EMP, work_date: DATE, status: 'manual', hours_override: 11,
    source_type: 'manual', source_id: 'manual', ...patch,
  }));
  listSelectableMock.mockResolvedValue([WAVE, CITYBAY]);
  roleAllowsMock.mockResolvedValue(true);
  suggestMock.mockResolvedValue({
    distribution: [], resolution_source: null, requires_allocation: false, ambiguous: false, candidates: [],
  });
  pgQuery.mockImplementation(async (sql: string) => {
    if (/WITH RECURSIVE pairs/i.test(sql)) return [];
    if (/FROM\s+employees/i.test(sql)) return [{ id: EMP, org_department_id: 'D1' }];
    return [];
  });
});

describe('create — распределение дневной корректировки по объектам', () => {
  it('кейс Сайфуллаева: выбранный объект пишется в metadata, строка остаётся дневной', async () => {
    suggestMock.mockResolvedValue(unpairedSuggestion);

    await timesheetController.create(
      buildReq({
        employee_id: EMP, work_date: DATE, status: 'manual', hours_worked: 11,
        notes: 'не сработал пропуск на вход, работал на Wave', object_id: WAVE.object_id,
      }),
      buildRes() as never,
    );

    const input = lastUpsert();
    // Ключевое: source_type/source_id прежние — согласование, реестр и вложения
    // остаются на своих путях, конверсии в manual_object нет.
    expect(input.source_type).toBe('manual');
    expect(input.source_id).toBe('manual');
    expect(lastMeta()).toMatchObject({
      object_allocations: [{ object_id: WAVE.object_id, object_name: WAVE.object_name, hours: 11 }],
      allocation_source: 'manual_choice',
    });
  });

  it('распределение по двум объектам сохраняется целиком', async () => {
    suggestMock.mockResolvedValue(unpairedSuggestion);

    await timesheetController.create(
      buildReq({
        employee_id: EMP, work_date: DATE, status: 'manual', hours_worked: 11, notes: 'два объекта',
        object_allocations: [
          { object_id: CITYBAY.object_id, hours: 4 },
          { object_id: WAVE.object_id, hours: 7 },
        ],
      }),
      buildRes() as never,
    );

    // Канонический порядок (по object_id) — перестановка строк в форме не должна
    // выглядеть как изменение.
    expect(lastMeta().object_allocations).toEqual([
      { object_id: CITYBAY.object_id, object_name: CITYBAY.object_name, hours: 4 },
      { object_id: WAVE.object_id, object_name: WAVE.object_name, hours: 7 },
    ]);
  });

  it('имя объекта берётся с сервера, а не из запроса', async () => {
    suggestMock.mockResolvedValue(unpairedSuggestion);

    await timesheetController.create(
      buildReq({
        employee_id: EMP, work_date: DATE, status: 'manual', hours_worked: 11, notes: 'подмена имени',
        object_allocations: [{ object_id: WAVE.object_id, object_name: 'ЖК Подделка', hours: 11 }],
      }),
      buildRes() as never,
    );

    expect(lastMeta().object_allocations).toEqual([
      { object_id: WAVE.object_id, object_name: WAVE.object_name, hours: 11 },
    ]);
  });

  it('сумма часов по объектам обязана совпадать с часами корректировки', async () => {
    suggestMock.mockResolvedValue(unpairedSuggestion);

    const res = buildRes();
    await timesheetController.create(
      buildReq({
        employee_id: EMP, work_date: DATE, status: 'manual', hours_worked: 11, notes: 'несходится',
        object_allocations: [
          { object_id: CITYBAY.object_id, hours: 4 },
          { object_id: WAVE.object_id, hours: 5 },
        ],
      }),
      res as never,
    );

    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'ALLOCATION_SUM_MISMATCH' }));
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('один объект нельзя указать дважды', async () => {
    suggestMock.mockResolvedValue(unpairedSuggestion);

    const res = buildRes();
    await timesheetController.create(
      buildReq({
        employee_id: EMP, work_date: DATE, status: 'manual', hours_worked: 11, notes: 'дубль',
        object_allocations: [
          { object_id: WAVE.object_id, hours: 4 },
          { object_id: WAVE.object_id, hours: 7 },
        ],
      }),
      res as never,
    );

    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'ALLOCATION_DUPLICATE_OBJECT' }));
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('чужой объект отклоняется: раньше любой id проходил молча', async () => {
    suggestMock.mockResolvedValue(unpairedSuggestion);

    const res = buildRes();
    await timesheetController.create(
      buildReq({
        employee_id: EMP, work_date: DATE, status: 'manual', hours_worked: 11,
        notes: 'чужой объект', object_id: 'obj-чужой',
      }),
      res as never,
    );

    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'OBJECT_NOT_ALLOWED' }));
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('непарный СКУД без выбора объекта: 422 OBJECT_REQUIRED с подсказкой', async () => {
    suggestMock.mockResolvedValue(unpairedSuggestion);

    const res = buildRes();
    await timesheetController.create(
      buildReq({ employee_id: EMP, work_date: DATE, status: 'manual', hours_worked: 11, notes: 'без объекта' }),
      res as never,
    );

    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'OBJECT_REQUIRED',
      candidates: [WAVE],
      suggested_distribution: unpairedSuggestion.distribution,
    }));
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('вход на одном объекте, выход на другом: 422 MULTI_OBJECT_REQUIRED', async () => {
    suggestMock.mockResolvedValue({
      distribution: [],
      resolution_source: null,
      requires_allocation: true,
      ambiguous: true,
      candidates: [WAVE, CITYBAY],
    });

    const res = buildRes();
    await timesheetController.create(
      buildReq({ employee_id: EMP, work_date: DATE, status: 'manual', hours_worked: 11, notes: 'спорный день' }),
      res as never,
    );

    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'MULTI_OBJECT_REQUIRED',
      candidates: [WAVE, CITYBAY],
    }));
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('день с надёжными минутами: объект не требуется, распределение не пишется', async () => {
    // Раскладка по фактическим минутам точнее ручного выбора — прежнее поведение.
    suggestMock.mockResolvedValue(reliableSuggestion);

    const res = buildRes();
    await timesheetController.create(
      buildReq({ employee_id: EMP, work_date: DATE, status: 'manual', hours_worked: 8, notes: 'обычный день' }),
      res as never,
    );

    expect(res.status).not.toHaveBeenCalledWith(422);
    expect(lastUpsert().source_type).toBe('manual');
    expect(lastMeta().object_allocations).toBeUndefined();
  });

  it('обнуление дня (0 часов): объект не запрашивается', async () => {
    const res = buildRes();
    await timesheetController.create(
      buildReq({ employee_id: EMP, work_date: DATE, status: 'manual', hours_worked: 0, notes: 'не работал' }),
      res as never,
    );

    expect(suggestMock).not.toHaveBeenCalled();
    expect(lastUpsert().source_type).toBe('manual');
  });

  it('«Работа в выходной» без явных часов объекта не требует', async () => {
    const res = buildRes();
    await timesheetController.create(
      buildReq({ employee_id: EMP, work_date: DATE, status: 'work', notes: 'вышел в выходной' }),
      res as never,
    );

    expect(suggestMock).not.toHaveBeenCalled();
    expect(lastUpsert().hours_override).toBeNull();
  });

  it('нет кандидатов вовсе — ввод не блокируем', async () => {
    suggestMock.mockResolvedValue({
      distribution: [], resolution_source: null, requires_allocation: true, ambiguous: false, candidates: [],
    });
    listSelectableMock.mockResolvedValue([]);

    const res = buildRes();
    await timesheetController.create(
      buildReq({ employee_id: EMP, work_date: DATE, status: 'manual', hours_worked: 11, notes: 'нет объектов' }),
      res as never,
    );

    expect(res.status).not.toHaveBeenCalledWith(422);
    expect(lastUpsert().source_type).toBe('manual');
  });

  it('роль без права на объектные правки: подтверждение не требуется', async () => {
    // Поле «Объект» у такой роли скрыто — требовать его значило бы запретить ей
    // сохранять обычные дневные корректировки.
    roleAllowsMock.mockResolvedValue(false);
    suggestMock.mockResolvedValue(unpairedSuggestion);

    const res = buildRes();
    await timesheetController.create(
      buildReq({ employee_id: EMP, work_date: DATE, status: 'manual', hours_worked: 11, notes: 'без объектов' }),
      res as never,
    );

    expect(res.status).not.toHaveBeenCalledWith(422);
    expect(lastUpsert().source_type).toBe('manual');
    expect(lastMeta().object_allocations).toBeUndefined();
  });

  it('на дне есть объектная корректировка — 409, чужая строка не удаляется', async () => {
    suggestMock.mockResolvedValue(unpairedSuggestion);
    // Отвечаем строкой ТОЛЬКО на проверку объектных корректировок дня (третий параметр —
    // source_type='manual_object'), иначе тот же мок сработал бы на замке периода.
    pgQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (/WITH RECURSIVE pairs/i.test(sql)) return [];
      if (/attendance_adjustments/i.test(sql) && params?.[2] === 'manual_object') return [{ id: 555 }];
      if (/FROM\s+employees/i.test(sql)) return [{ id: EMP, org_department_id: 'D1' }];
      return [];
    });

    const res = buildRes();
    await timesheetController.create(
      buildReq({
        employee_id: EMP, work_date: DATE, status: 'manual', hours_worked: 11,
        notes: 'конфликт', object_id: WAVE.object_id,
      }),
      res as never,
    );

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'OBJECT_ADJUSTMENTS_CONFLICT' }));
    expect(upsertMock).not.toHaveBeenCalled();
    // Мьютекс-DELETE при заданном распределении не выполняется вовсе.
    expect(pgExecute).not.toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM attendance_adjustments'),
      expect.anything(),
    );
  });

  it('идемпотентность: повторное сохранение пишет ту же строку и то же распределение', async () => {
    suggestMock.mockResolvedValue(unpairedSuggestion);
    const body = {
      employee_id: EMP, work_date: DATE, status: 'manual', hours_worked: 11,
      notes: 'служебка', object_id: WAVE.object_id,
    };

    await timesheetController.create(buildReq(body), buildRes() as never);
    const first = { ...lastUpsert(), metadata: { ...lastMeta() } };
    upsertMock.mockClear();
    await timesheetController.create(buildReq(body), buildRes() as never);
    const second = lastUpsert();

    // Адрес строки (employee_id, work_date, source_type, source_id) тот же — UNIQUE-индекс
    // превращает второй вызов в UPDATE, дубля не будет.
    expect(second.source_type).toBe(first.source_type);
    expect(second.source_id).toBe(first.source_id);
    expect(second.metadata).toEqual(first.metadata);
  });
});


// ───────────── PUT /api/timesheet/:id — смена распределения ─────────────
const EXISTING_ID = 1111076;

/** Существующая дневная корректировка Алесиной: 11 ч, объект — Ситибэй. */
const existingRow = (overrides: Record<string, unknown> = {}) => ({
  id: EXISTING_ID,
  employee_id: EMP,
  work_date: DATE,
  status: 'manual',
  hours_override: 11,
  source_type: 'manual',
  source_id: 'manual',
  reason: 'не сработал пропуск на вход',
  created_by: 'ALESINA-UUID',
  created_at: '2026-09-09T10:12:00.000Z',
  approval_status: 'auto_approved',
  approved_by: null,
  approved_at: null,
  metadata: {
    object_allocations: [{ object_id: CITYBAY.object_id, object_name: CITYBAY.object_name, hours: 11 }],
    allocation_source: 'manual_choice',
    // Посторонний ключ: обязан пережить смену распределения.
    legacy_note: 'не трогать',
  },
  ...overrides,
});

const lastPatch = () => updateByIdMock.mock.calls[0]![1] as Record<string, unknown>;

const buildUpdateReq = (body: Record<string, unknown>): AuthenticatedRequest => ({
  ...buildReq(body),
  params: { id: String(EXISTING_ID) },
} as unknown as AuthenticatedRequest);

describe('update — распределение по объектам у существующей корректировки', () => {
  beforeEach(() => {
    getByIdMock.mockResolvedValue(existingRow());
    // Под локом читаем metadata заблокированной строки — мержим из неё.
    pgQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (/WITH RECURSIVE pairs/i.test(sql)) return [];
      if (/attendance_adjustments/i.test(sql) && params?.[2] === 'manual_object') return [];
      if (/SELECT metadata FROM attendance_adjustments/i.test(sql)) {
        return [{ metadata: existingRow().metadata }];
      }
      if (/FROM\s+employees/i.test(sql)) return [{ id: EMP, org_department_id: 'D1' }];
      return [];
    });
  });

  it('смена объекта не трогает id, автора и решение согласующего', async () => {
    suggestMock.mockResolvedValue(unpairedSuggestion);

    const res = buildRes();
    await timesheetController.update(
      buildUpdateReq({ object_allocations: [{ object_id: WAVE.object_id, hours: 11 }] }),
      res as never,
    );

    expect(updateByIdMock).toHaveBeenCalledWith(EXISTING_ID, expect.anything(), expect.anything());
    const patch = lastPatch();
    // Ни id, ни source_type/source_id, ни поля согласования в патч не попадают.
    expect(patch).not.toHaveProperty('source_type');
    expect(patch).not.toHaveProperty('source_id');
    expect(patch).not.toHaveProperty('created_by');
    expect(patch).not.toHaveProperty('approval_status');
    // Правка ТОЛЬКО распределения не перебивает автора в реестре корректировок.
    expect(patch).not.toHaveProperty('updated_by');
    const metadata = patch.metadata as Record<string, unknown>;
    expect(metadata.object_allocations).toEqual([
      { object_id: WAVE.object_id, object_name: WAVE.object_name, hours: 11 },
    ]);
    // Посторонние ключи metadata живы.
    expect(metadata.legacy_note).toBe('не трогать');
  });

  it('то же распределение в другом порядке — no-op, metadata не переписывается', async () => {
    suggestMock.mockResolvedValue(unpairedSuggestion);
    getByIdMock.mockResolvedValue(existingRow({
      metadata: {
        object_allocations: [
          { object_id: WAVE.object_id, object_name: WAVE.object_name, hours: 7 },
          { object_id: CITYBAY.object_id, object_name: CITYBAY.object_name, hours: 4 },
        ],
      },
    }));

    await timesheetController.update(
      buildUpdateReq({
        object_allocations: [
          { object_id: CITYBAY.object_id, hours: 4 },
          { object_id: WAVE.object_id, hours: 7 },
        ],
      }),
      buildRes() as never,
    );

    expect(lastPatch()).not.toHaveProperty('metadata');
  });

  it('часы изменились при одном объекте — часы аллокации следуют за итогом', async () => {
    suggestMock.mockResolvedValue(unpairedSuggestion);

    await timesheetController.update(
      buildUpdateReq({ hours_worked: 9 }),
      buildRes() as never,
    );

    const metadata = lastPatch().metadata as Record<string, unknown>;
    expect(metadata.object_allocations).toEqual([
      { object_id: CITYBAY.object_id, object_name: CITYBAY.object_name, hours: 9 },
    ]);
    // Часы — значимая правка, автора обновляем как обычно.
    expect(lastPatch().updated_by).toBe('USER-UUID');
  });

  it('часы изменились при нескольких объектах — 422 ALLOCATION_REQUIRED', async () => {
    getByIdMock.mockResolvedValue(existingRow({
      metadata: {
        object_allocations: [
          { object_id: WAVE.object_id, object_name: WAVE.object_name, hours: 7 },
          { object_id: CITYBAY.object_id, object_name: CITYBAY.object_name, hours: 4 },
        ],
      },
    }));

    const res = buildRes();
    await timesheetController.update(buildUpdateReq({ hours_worked: 9 }), res as never);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'ALLOCATION_REQUIRED' }));
    expect(updateByIdMock).not.toHaveBeenCalled();
  });

  it('переход в отпуск снимает распределение, остальная metadata цела', async () => {
    await timesheetController.update(
      buildUpdateReq({ status: 'vacation' }),
      buildRes() as never,
    );

    const metadata = lastPatch().metadata as Record<string, unknown>;
    expect(metadata.object_allocations).toBeUndefined();
    expect(metadata.allocation_source).toBeUndefined();
    expect(metadata.legacy_note).toBe('не трогать');
  });

  it('пустой массив при обязательном подтверждении отклоняется', async () => {
    suggestMock.mockResolvedValue(unpairedSuggestion);

    const res = buildRes();
    await timesheetController.update(
      buildUpdateReq({ object_allocations: [] }),
      res as never,
    );

    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'ALLOCATION_REQUIRED' }));
    expect(updateByIdMock).not.toHaveBeenCalled();
  });

  it('на дне есть объектная строка — 409, ничего не удаляется', async () => {
    suggestMock.mockResolvedValue(unpairedSuggestion);
    pgQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (/WITH RECURSIVE pairs/i.test(sql)) return [];
      if (/attendance_adjustments/i.test(sql) && params?.[2] === 'manual_object') return [{ id: 777 }];
      if (/FROM\s+employees/i.test(sql)) return [{ id: EMP, org_department_id: 'D1' }];
      return [];
    });

    const res = buildRes();
    await timesheetController.update(
      buildUpdateReq({ object_allocations: [{ object_id: WAVE.object_id, hours: 11 }] }),
      res as never,
    );

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'OBJECT_ADJUSTMENTS_CONFLICT' }));
    expect(updateByIdMock).not.toHaveBeenCalled();
  });

  it('объектную строку дневная форма не правит: 409 без кода конфликта распределения', async () => {
    getByIdMock.mockResolvedValue(existingRow({ source_type: 'manual_object', source_id: WAVE.object_id }));

    const res = buildRes();
    await timesheetController.update(buildUpdateReq({ hours_worked: 9 }), res as never);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(updateByIdMock).not.toHaveBeenCalled();
  });
});


// ───────────── bulk и объектная вкладка: конфликты вместо удаления ─────────────
describe('bulkSave — многообъектные дни не трогаем', () => {
  it('ячейка с распределением по двум объектам пропускается, остальные пишутся', async () => {
    // Общая сумма часов не говорит, как перераспределить её между объектами, поэтому
    // такую ячейку массовая правка не меняет — и обязана сказать об этом явно.
    pgQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (/WITH RECURSIVE pairs/i.test(sql)) return [];
      if (/SELECT employee_id, work_date::text/i.test(sql)) {
        return [
          {
            employee_id: EMP,
            work_date: DATE,
            metadata: {
              object_allocations: [
                { object_id: WAVE.object_id, object_name: WAVE.object_name, hours: 7 },
                { object_id: CITYBAY.object_id, object_name: CITYBAY.object_name, hours: 4 },
              ],
            },
          },
        ];
      }
      if (/FROM\s+employees/i.test(sql)) return [{ id: EMP, org_department_id: 'D1' }];
      if (params?.[2] === 'manual_object') return [];
      return [];
    });

    const res = buildRes();
    await timesheetController.bulkSave(
      buildReq({
        items: [
          { employee_id: EMP, work_date: DATE },
          { employee_id: EMP, work_date: '2026-09-02' },
        ],
        status: 'manual',
        hours_worked: 8,
        notes: 'массовая правка',
      }),
      res as never,
    );

    const payload = res.json.mock.calls[0]![0] as { data: { processed: number; skipped: Array<{ code: string }> } };
    expect(payload.data.skipped).toHaveLength(1);
    expect(payload.data.skipped[0]).toMatchObject({ employee_id: EMP, work_date: DATE, code: 'ALLOCATION_REQUIRED' });
    // processed считает только реально записанные ячейки.
    expect(payload.data.processed).toBe(1);
  });
});

describe('upsertObjectEntry — объектная правка на дне с распределением', () => {
  it('отвечает 409 и не удаляет дневную строку с вложениями', async () => {
    pgQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (/WITH RECURSIVE pairs/i.test(sql)) return [];
      // Дневная строка дня с распределением — конфликт до любых побочных эффектов.
      if (/SELECT metadata FROM attendance_adjustments/i.test(sql)) {
        return [{
          metadata: {
            object_allocations: [{ object_id: WAVE.object_id, object_name: WAVE.object_name, hours: 11 }],
          },
        }];
      }
      if (/FROM\s+employees/i.test(sql)) return [{ id: EMP, org_department_id: 'D1' }];
      if (params?.[2] === 'manual_object') return [];
      return [];
    });

    const res = buildRes();
    await timesheetController.upsertObjectEntry(
      buildReq({
        employee_id: EMP,
        work_date: DATE,
        object_key: WAVE.object_id,
        object_id: WAVE.object_id,
        object_name: WAVE.object_name,
        hours_worked: 8,
        notes: 'правка по объекту',
      }),
      res as never,
    );

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'DAY_ALLOCATION_CONFLICT' }));
    // Ни одного DELETE: дневная корректировка и её файлы на месте.
    expect(pgExecute).not.toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM attendance_adjustments'),
      expect.anything(),
    );
  });
});
