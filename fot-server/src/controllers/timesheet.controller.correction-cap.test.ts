import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Предел часов корректировки: настоящие гарды роли на всех дневных путях записи.
 * Талбаков, график 12 ч: 14 ч сохранить нельзя, а заметка к старой правке 14 ч — сохраняется.
 * Объектный путь и сумма по объектам — в object-entry и в correction-cap.pg.
 */

const {
  pgQuery, pgExecute, txQueries, upsertMock, deleteBySourceMock, getByIdMock,
  suggestMock, listSelectableMock, roleAllowsMock, updateByIdMock, limitsMock,
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
  limitsMock: vi.fn(),
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
    work_hours: 8,
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
  areObjectCorrectionsAllowed: roleAllowsMock,
  resolveCorrectionDayLimits: limitsMock,
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
  loadEmployeeFullName: vi.fn(async () => 'Талбаков И. Р.'),
  loadEmployeeFullNamesMap: vi.fn(async () => new Map<number, string>()),
}));

vi.mock('../services/skud-realtime.service.js', () => ({
  notifySkudRealtimeChanged: vi.fn(),
  invalidateSkudRealtimeCaches: vi.fn(),
}));

import { timesheetController } from './timesheet.controller.js';
import { invalidateCorrectionRestrictionsCache } from '../services/correction-restrictions.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

const EMP = 6006;
const DATE = '2026-11-03';
const EXISTING_ID = 900200;

const buildReq = (body: Record<string, unknown>, params: Record<string, string> = {}): AuthenticatedRequest => ({
  body,
  params,
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

interface IFixture {
  capEnabled: boolean;
  /** Строка manual/manual этого дня. */
  dayRow: Record<string, unknown> | null;
  approvedWork: boolean;
}

let fixture: IFixture;

const setLimits = (normHours: number, capHours: number) => {
  limitsMock.mockImplementation(async () => ({ normHours, capHours, capEnabled: fixture.capEnabled }));
};

const roleRow = () => ({
  corrections_anomalies_only: false,
  corrections_cap_by_schedule_norm: fixture.capEnabled,
  corrections_allow_zero_short_attendance: false,
  corrections_disable_bulk: false,
  corrections_disable_object_entries: false,
  max_corrections_per_month: null,
  weekend_memo_required: false,
});

beforeEach(() => {
  vi.clearAllMocks();
  invalidateCorrectionRestrictionsCache();
  fixture = { capEnabled: true, dayRow: null, approvedWork: false };
  setLimits(12, 12);
  upsertMock.mockImplementation(async (input: Record<string, unknown>) => ({
    id: EXISTING_ID, ...input, approval_status: input.approval_status ?? 'auto_approved',
  }));
  deleteBySourceMock.mockResolvedValue([]);
  roleAllowsMock.mockResolvedValue(false);
  updateByIdMock.mockImplementation(async (_id: number, patch: Record<string, unknown>) => ({
    id: EXISTING_ID, employee_id: EMP, work_date: DATE, status: 'manual', hours_override: 14,
    source_type: 'manual', source_id: 'manual', ...patch,
  }));
  getByIdMock.mockResolvedValue({
    id: EXISTING_ID, employee_id: EMP, work_date: DATE, status: 'manual', hours_override: '14.00',
    source_type: 'manual', source_id: 'manual', approval_status: 'auto_approved', metadata: null,
  });
  pgQuery.mockImplementation(async (sql: string) => {
    if (/FROM\s+system_roles/i.test(sql)) return [roleRow()];
    if (/WITH RECURSIVE pairs/i.test(sql)) return [];
    if (/SELECT status, hours_override FROM attendance_adjustments/i.test(sql)) {
      return fixture.dayRow ? [fixture.dayRow] : [];
    }
    if (/SELECT employee_id, work_date::text AS work_date, metadata, status/i.test(sql)) {
      return fixture.dayRow
        ? [{ employee_id: EMP, work_date: DATE, metadata: null, source_id: 'manual', ...fixture.dayRow }]
        : [];
    }
    if (/status = 'work'/i.test(sql) && /approval_status IN/i.test(sql)) return fixture.approvedWork ? [{ id: 1 }] : [];
    if (/FROM\s+employees/i.test(sql)) return [{ id: EMP, org_department_id: 'D1', full_name: 'Талбаков И. Р.' }];
    return [];
  });
});

const statusOf = (res: ReturnType<typeof buildRes>) => res.status.mock.calls[0]?.[0] ?? 200;
const payloadOf = (res: ReturnType<typeof buildRes>) => res.json.mock.calls[0]![0] as Record<string, unknown>;

describe('POST /timesheet — предел часов', () => {
  const post = async (body: Record<string, unknown>) => {
    const res = buildRes();
    await timesheetController.create(
      buildReq({ employee_id: EMP, work_date: DATE, notes: 'причина', ...body }),
      res as never,
    );
    return res;
  };

  it('14 ч при графике 12 ч — отказ, ничего не записано', async () => {
    const res = await post({ status: 'manual', hours_worked: 14 });
    expect(statusOf(res)).toBe(422);
    expect(payloadOf(res)).toMatchObject({ code: 'hours_exceed_norm', error: 'Часы корректировки (14) больше графика дня (12).' });
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('ровно по графику — проходит', async () => {
    const res = await post({ status: 'manual', hours_worked: 12 });
    expect(statusOf(res)).toBe(200);
    expect(upsertMock).toHaveBeenCalledTimes(1);
  });

  it('повторная запись той же правки 14 ч (форма шлёт статус и часы) — проходит', async () => {
    fixture.dayRow = { status: 'manual', hours_override: '14.00' };
    const res = await post({ status: 'manual', hours_worked: 14 });
    expect(statusOf(res)).toBe(200);
  });

  it('выходной: до длины смены можно, сверх — нет', async () => {
    setLimits(0, 10);
    expect(statusOf(await post({ status: 'manual', hours_worked: 10 }))).toBe(200);
    expect(statusOf(await post({ status: 'manual', hours_worked: 11 }))).toBe(422);
  });

  it('work без часов в выходной при смене 6 ч: часы придут из СКУД, предел не срабатывает', async () => {
    setLimits(0, 6);
    expect(statusOf(await post({ status: 'work' }))).toBe(200);
  });

  it('удалёнка без часов в предпраздничный день: пишется норма 7, а не график 8', async () => {
    setLimits(7, 7);
    const res = await post({ status: 'remote' });
    expect(statusOf(res)).toBe(200);
    expect(upsertMock.mock.calls[0]![0]).toMatchObject({ status: 'remote', hours_override: 7 });
  });

  it('удалёнка поверх согласованного выхода тоже ограничена длиной смены', async () => {
    setLimits(0, 10);
    fixture.approvedWork = true;
    expect(statusOf(await post({ status: 'remote', hours_worked: 11 }))).toBe(422);
    expect(statusOf(await post({ status: 'remote', hours_worked: 10 }))).toBe(200);
  });

  it('галочка роли снята: 14 ч проходит, удалёнка без часов — как раньше', async () => {
    fixture.capEnabled = false;
    setLimits(7, 7);
    expect(statusOf(await post({ status: 'manual', hours_worked: 14 }))).toBe(200);
    const res = await post({ status: 'remote' });
    expect(statusOf(res)).toBe(200);
    expect(upsertMock.mock.calls.at(-1)![0]).toMatchObject({ status: 'remote', hours_override: 8 });
  });

  it('галочка роли снята: удалёнка без часов в предпраздничный день — норма 7, как в окне', async () => {
    fixture.capEnabled = false;
    setLimits(7, 7);
    const preHolidayCalendar = calendar as { pre_holidays?: string[] };
    preHolidayCalendar.pre_holidays = [DATE];
    try {
      const res = await post({ status: 'remote' });
      expect(statusOf(res)).toBe(200);
      expect(upsertMock.mock.calls.at(-1)![0]).toMatchObject({ status: 'remote', hours_override: 7 });
    } finally {
      delete preHolidayCalendar.pre_holidays;
    }
  });
});

describe('PATCH /timesheet/:id — предел часов', () => {
  const patch = async (body: Record<string, unknown>) => {
    const res = buildRes();
    await timesheetController.update(buildReq(body, { id: String(EXISTING_ID) }), res as never);
    return res;
  };

  it('заметка к старой правке 14 ч: форма шлёт статус, часы и заметку — сохраняется', async () => {
    const res = await patch({ status: 'manual', hours_worked: 14, notes: 'уточнил причину' });
    expect(statusOf(res)).toBe(200);
    expect(updateByIdMock).toHaveBeenCalled();
  });

  it('снижение 14 → 13 при пределе 12 — отказ', async () => {
    const res = await patch({ status: 'manual', hours_worked: 13, notes: 'причина' });
    expect(statusOf(res)).toBe(422);
    expect(updateByIdMock).not.toHaveBeenCalled();
  });

  it('снижение 14 → 12 — проходит', async () => {
    expect(statusOf(await patch({ status: 'manual', hours_worked: 12, notes: 'причина' }))).toBe(200);
  });

  it('смена статуса при тех же 14 ч — отказ', async () => {
    expect(statusOf(await patch({ status: 'remote', hours_worked: 14, notes: 'причина' }))).toBe(422);
  });

  it('галочка роли снята: 13 ч проходит', async () => {
    fixture.capEnabled = false;
    expect(statusOf(await patch({ status: 'manual', hours_worked: 13, notes: 'причина' }))).toBe(200);
  });
});

describe('POST /timesheet/bulk — предел часов', () => {
  const bulk = async (body: Record<string, unknown>) => {
    const res = buildRes();
    await timesheetController.bulkSave(
      buildReq({ items: [{ employee_id: EMP, work_date: DATE }], notes: 'массовая', ...body }),
      res as never,
    );
    return res;
  };

  it('удалёнка с hours_worked: 12 при пределе 8 — отказ с ФИО и датой, ничего не записано', async () => {
    setLimits(8, 8);
    const res = await bulk({ status: 'remote', hours_worked: 12 });
    expect(statusOf(res)).toBe(422);
    expect(payloadOf(res)).toMatchObject({ code: 'hours_exceed_norm' });
    expect(String(payloadOf(res).error)).toContain('Талбаков И. Р., 03.11.2026');
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('удалёнка без часов в предпраздничный день пишет норму', async () => {
    setLimits(7, 7);
    const res = await bulk({ status: 'remote' });
    expect(statusOf(res)).toBe(200);
    expect(upsertMock.mock.calls[0]![0]).toMatchObject({ status: 'remote', hours_override: 7 });
  });

  it('повторная массовая правка тех же 14 ч — проходит', async () => {
    fixture.dayRow = { status: 'manual', hours_override: '14.00' };
    expect(statusOf(await bulk({ status: 'manual', hours_worked: 14 }))).toBe(200);
  });

  it('новые 14 ч — отказ', async () => {
    expect(statusOf(await bulk({ status: 'manual', hours_worked: 14 }))).toBe(422);
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('галочка роли снята: 14 ч проходит', async () => {
    fixture.capEnabled = false;
    expect(statusOf(await bulk({ status: 'manual', hours_worked: 14 }))).toBe(200);
  });
});
