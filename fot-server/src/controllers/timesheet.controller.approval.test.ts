import { beforeEach, describe, expect, it, vi } from 'vitest';

// Мокаем только то, что дёргают резолвер / reapprove в рантайме: query (employees,
// «есть ли согласованный выход», кандидаты квоты, СКУД, закрытые подачи), whitelist-настройку,
// schedule.service (resolveSchedulesForPeriod/isWorkingDay/loadCalendarMonth) и транзакцию
// (advisory-lock + exec-варианты запросов маршрутизируем в те же моки).
const { pgQuery, pgExecute, txQueries } = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  pgExecute: vi.fn(async () => undefined),
  txQueries: [] as Array<{ sql: string; params: unknown[] }>,
}));

vi.mock('../config/postgres.js', async (importActual) => ({
  ...(await importActual<typeof import('../config/postgres.js')>()),
  query: pgQuery,
  execute: pgExecute,
  queryWith: async (_exec: unknown, sql: string, params?: unknown[]) => pgQuery(sql, params),
  queryOneWith: async (_exec: unknown, sql: string, params?: unknown[]) =>
    (await pgQuery(sql, params))[0] ?? null,
  executeWith: async (_exec: unknown, sql: string, params?: unknown[]) => pgExecute(sql, params),
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
  correctionApprovalSettingsService: {
    getRequiredDepartmentIds: vi.fn(async () => requiredSet),
  },
}));

const { schedule, calendar, scheduleByEmp, isWorkingDayMock, isHolidayOnWorkdayMock } = vi.hoisted(() => ({
  schedule: {
    pattern_type: '5+2',
    expected_saturdays_per_month: 2,
    expected_sundays_per_month: 0,
    respects_holidays: true,
    work_days: [1, 2, 3, 4, 5],
  },
  calendar: { holidays: [] as string[], mandatory_holidays: [] as string[] },
  scheduleByEmp: { value: null as unknown },
  isWorkingDayMock: vi.fn(() => false), // тестовые даты — субботы/воскресенья (нерабочие)
  isHolidayOnWorkdayMock: vi.fn(() => false),
}));

vi.mock('../services/schedule.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/schedule.service.js')>()),
  resolveSchedulesForPeriod: vi.fn(async () => scheduleByEmp.value),
  isWorkingDay: isWorkingDayMock,
  isHolidayOnWorkday: isHolidayOnWorkdayMock,
  loadCalendarMonth: vi.fn(async () => calendar),
}));

const { assignedEmployeesMock } = vi.hoisted(() => ({ assignedEmployeesMock: vi.fn(async () => [] as number[]) }));
vi.mock('../services/timesheet-department-assignments.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/timesheet-department-assignments.service.js')>()),
  listEmployeeIdsAssignedToDepartmentPeriod: assignedEmployeesMock,
}));

import {
  resolveAdjustmentApprovalStatus,
  reapproveAdjustmentsForRange,
  computeReapprovalTransitions,
  quotaLockKeys,
  withQuotaLocks,
} from './timesheet.controller.js';

const EMP = 100;

/** Регексп кандидатов квоты — предикат покрывает work/remote И manual с положительными часами. */
const QUOTA_SQL_RE = /status = 'manual' AND hours_override > 0/i;

/**
 * Маршрутизация query по содержимому SQL.
 * - employees — отдел сотрудника (whitelist);
 * - `SELECT id FROM attendance_adjustments` — hasApprovedWorkOnDate (согласованный выход);
 * - предикат квоты — кандидаты обязательного слота (loadWorkedSaturdaysForQuota);
 * - `FROM skud_daily_summary` — СКУД-присутствие без корректировки.
 * `worked`/`skud` задают уже отработанные субботы месяца (даты ISO).
 * `approvedWorkId` — id строки-основания: если резолвер прислал его в excludeAdjustmentId,
 * «основание» не возвращается (строка не может обосновать сама себя).
 */
function mockResolve(opts: {
  approvedWork?: boolean; approvedWorkId?: number; worked?: string[]; skud?: string[];
} = {}): void {
  pgQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (/FROM\s+employees/i.test(sql)) return [{ id: EMP, org_department_id: 'D1' }];
    if (/SELECT\s+id\s+FROM\s+attendance_adjustments/i.test(sql)) {
      if (!opts.approvedWork) return [];
      const excluded = params?.[2] ?? null;
      const rowId = opts.approvedWorkId ?? 1;
      if (excluded !== null && Number(excluded) === rowId) return [];
      return [{ id: rowId }];
    }
    if (QUOTA_SQL_RE.test(sql)) {
      return (opts.worked ?? []).map(d => ({ employee_id: EMP, work_date: d }));
    }
    if (/FROM\s+skud_daily_summary/i.test(sql)) {
      return (opts.skud ?? []).map(d => ({ employee_id: EMP, date: d }));
    }
    return [];
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  txQueries.length = 0;
  assignedEmployeesMock.mockReset();
  assignedEmployeesMock.mockResolvedValue([]);
  isHolidayOnWorkdayMock.mockReset();
  isHolidayOnWorkdayMock.mockReturnValue(false);
  isWorkingDayMock.mockReset();
  isWorkingDayMock.mockReturnValue(false);
  calendar.holidays = [];
  calendar.mandatory_holidays = [];
  schedule.expected_saturdays_per_month = 2;
  schedule.expected_sundays_per_month = 0;
  schedule.respects_holidays = true;
  // resolveSchedulesForPeriod зовётся с (workDate, workDate); get возвращает текущий schedule.
  scheduleByEmp.value = new Map([[EMP, { get: () => schedule } as unknown as Map<string, unknown>]]);
});

/**
 * Count-модель: обязательной считается первая фактически ОТРАБОТАННАЯ непраздничная суббота
 * месяца в пределах expected_saturdays_per_month → auto_approved; вторая и последующие →
 * pending. Решает ФАКТ отработанной субботы, а не способ ввода часов (work/remote/manual).
 * Даты: 2026-05-02/09/16/23/30 — субботы.
 */
describe('resolveAdjustmentApprovalStatus — обязательные субботы (count-модель)', () => {
  it('1-я отработанная суббота при норме 2 (нет прежних) → auto_approved', async () => {
    mockResolve({ worked: [] });
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-09', 'remote')).toBe('auto_approved');
  });

  it('2-я отработанная суббота при норме 2 (1 прежняя) → auto_approved', async () => {
    mockResolve({ worked: ['2026-05-02'] });
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-09', 'remote')).toBe('auto_approved');
  });

  it('3-я отработанная суббота при норме 2 (2 прежних) → pending', async () => {
    mockResolve({ worked: ['2026-05-02', '2026-05-09'] });
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-16', 'remote')).toBe('pending');
  });

  it('норма 1: 1-я отработанная суббота → auto_approved', async () => {
    schedule.expected_saturdays_per_month = 1;
    mockResolve({ worked: [] });
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-09', 'work', null)).toBe('auto_approved');
  });

  it('норма 1: 2-я отработанная суббота → pending (к ответственному за выходные)', async () => {
    schedule.expected_saturdays_per_month = 1;
    mockResolve({ worked: ['2026-05-02'] });
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-09', 'work', null)).toBe('pending');
  });

  it('заявление на 1-ю субботу без часов (null) → auto_approved (часы придут из СКУД)', async () => {
    schedule.expected_saturdays_per_month = 1;
    mockResolve({ worked: [] });
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-02', 'work', null)).toBe('auto_approved');
  });

  it('expected_saturdays_per_month=0 → pending (обязательных суббот нет)', async () => {
    schedule.expected_saturdays_per_month = 0;
    mockResolve({ worked: [] });
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-02', 'remote')).toBe('pending');
  });

  it('воскресенье при expected_sundays_per_month=0 → pending', async () => {
    // 2026-05-17 — воскресенье; субботняя квота на него не распространяется.
    schedule.expected_saturdays_per_month = 1;
    mockResolve({ worked: [] });
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-17', 'manual', 8)).toBe('pending');
  });

  it('дедуп: две строки на одну прежнюю субботу считаются один раз (норма 2 → 2-я auto)', async () => {
    // Без дедупа usedBefore=2 → pending; с дедупом (Set по дате) usedBefore=1 → auto.
    mockResolve({ worked: ['2026-05-02', '2026-05-02'] });
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-09', 'remote')).toBe('auto_approved');
  });

  it('СКУД-присутствие без корректировки занимает слот: следующая заявка → pending', async () => {
    schedule.expected_saturdays_per_month = 1;
    mockResolve({ worked: [], skud: ['2026-05-02'] });
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-09', 'work', null)).toBe('pending');
  });

  it('праздничная суббота не входит в квоту → pending', async () => {
    schedule.expected_saturdays_per_month = 1;
    calendar.holidays = ['2026-05-02'];
    mockResolve({ worked: [] });
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-02', 'work', null)).toBe('pending');
  });

  it('SQL кандидатов: work/remote допускают null-часы, manual — только > 0', async () => {
    mockResolve({ worked: [] });
    await resolveAdjustmentApprovalStatus(EMP, '2026-05-09', 'work', null);
    const q = pgQuery.mock.calls.map(c => String(c[0])).find(s => QUOTA_SQL_RE.test(s));
    expect(q).toBeDefined();
    expect(q).toMatch(/status IN \('work', 'remote'\) AND \(hours_override IS NULL OR hours_override > 0\)/i);
    expect(q).toMatch(/status = 'manual' AND hours_override > 0/i);
  });
});

/**
 * Объектные правки (status='manual', source_type='manual_object') участвуют в квоте наравне
 * с заявками: кейс Павленкова 18.07 — СКУД без выхода, руководитель проставил 8 ч по объекту,
 * это первая отработанная суббота месяца → согласование не требуется.
 */
describe('resolveAdjustmentApprovalStatus — объектные правки в квоте', () => {
  it('объектная правка на 1-й отработанной субботе → auto_approved (кейс Павленкова)', async () => {
    schedule.expected_saturdays_per_month = 1;
    mockResolve({ worked: [] });
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-02', 'manual', 8)).toBe('auto_approved');
  });

  it('объектная правка на 2-й субботе → pending (к ответственному за выходные)', async () => {
    schedule.expected_saturdays_per_month = 1;
    mockResolve({ worked: ['2026-05-02'] });
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-09', 'manual', 8)).toBe('pending');
  });

  it('две объектные строки разных объектов на одну субботу занимают ОДИН слот', async () => {
    // Обе строки лежат на 2026-05-02; при норме 1 суббота 09.05 всё ещё вторая → pending,
    // но сама 02.05 остаётся auto (слот один, а не два).
    schedule.expected_saturdays_per_month = 1;
    mockResolve({ worked: ['2026-05-02', '2026-05-02'] });
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-02', 'manual', 8)).toBe('auto_approved');
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-09', 'manual', 8)).toBe('pending');
  });

  it('manual 0 ч → auto_approved (не работал)', async () => {
    mockResolve();
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-02', 'manual', 0)).toBe('auto_approved');
  });

  it('manual без часов (null) → auto_approved (гард инварианта: положительность недоказуема)', async () => {
    mockResolve();
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-02', 'manual', null)).toBe('auto_approved');
  });
});

describe('resolveAdjustmentApprovalStatus — ранние выходы в auto_approved', () => {
  it('отдел не в whitelist → auto_approved', async () => {
    pgQuery.mockImplementation(async (sql: string) => {
      if (/FROM\s+employees/i.test(sql)) return [{ id: EMP, org_department_id: 'OTHER' }];
      return [];
    });
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-02', 'remote')).toBe('auto_approved');
  });

  it('hours_override=0 → auto_approved (не работал)', async () => {
    mockResolve();
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-16', 'work', 0)).toBe('auto_approved');
  });

  it('автор — табельщица → auto_approved', async () => {
    mockResolve();
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-02', 'manual', 8, true)).toBe('auto_approved');
  });

  it('отпуск в субботу → auto_approved (не работа)', async () => {
    mockResolve();
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-02', 'vacation', 8)).toBe('auto_approved');
  });

  it('больничный в субботу → auto_approved (не работа)', async () => {
    mockResolve();
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-02', 'sick', 8)).toBe('auto_approved');
  });

  it('sick_worked в субботу → auto_approved (намеренно не входит в набор)', async () => {
    mockResolve();
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-02', 'sick_worked')).toBe('auto_approved');
  });

  it('study_day (учебный день) в субботу → auto_approved: часы из нормы, в выходной она 0', async () => {
    mockResolve();
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-02', 'study_day')).toBe('auto_approved');
  });
});

describe('resolveAdjustmentApprovalStatus — поверх согласованного выхода', () => {
  // Квота исчерпана (2 прежних субботы при норме 2), поэтому решает ветка «день уже согласован».
  it('remote в выходной с уже согласованным work → auto_approved', async () => {
    mockResolve({ approvedWork: true, worked: ['2026-05-02', '2026-05-09'] });
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-16', 'remote')).toBe('auto_approved');
  });

  it('объектная правка сверх квоты, но день согласован заявкой work → auto_approved (кейс Зайцева)', async () => {
    schedule.expected_saturdays_per_month = 1;
    mockResolve({ approvedWork: true, worked: ['2026-05-02'] });
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-09', 'manual', 7.12)).toBe('auto_approved');
  });

  it('remote в выходной без согласованного выхода (сверх квоты) → pending', async () => {
    mockResolve({ approvedWork: false, worked: ['2026-05-02', '2026-05-09'] });
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-16', 'remote')).toBe('pending');
  });

  it('изменяемая строка не может быть основанием сама себе (excludeAdjustmentId)', async () => {
    // Единственный approved work за день — это та самая строка, которую сейчас переписывают
    // в manual. Без исключения резолвер выдал бы auto_approved.
    schedule.expected_saturdays_per_month = 1;
    mockResolve({ approvedWork: true, approvedWorkId: 555, worked: ['2026-05-02'] });
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-09', 'manual', 8, false, 555)).toBe('pending');
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-09', 'manual', 8, false, 999)).toBe('auto_approved');
  });

  it('согласованным выходом не считается work с нулём часов (фильтр в SQL)', async () => {
    mockResolve({ approvedWork: false, worked: ['2026-05-02', '2026-05-09'] });
    await resolveAdjustmentApprovalStatus(EMP, '2026-05-16', 'remote');
    const sqls = pgQuery.mock.calls.map(c => String(c[0]));
    const workSql = sqls.find(s => /SELECT\s+id\s+FROM\s+attendance_adjustments/i.test(s));
    expect(workSql).toBeDefined();
    expect(workSql).toMatch(/hours_override IS NULL OR hours_override > 0/i);
  });
});

type Row = Record<string, unknown>;

function mockReapprove(opts: {
  rows: Row[];
  approvedWorkRows?: Array<{ employee_id: number; work_date: string }>;
  timekeeperIds?: string[];
  quotaCandidates?: Array<{ employee_id: number; work_date: string }>;
  skud?: Array<{ employee_id: number; date: string }>;
  lockedIds?: number[];
  legacyApprovals?: Array<{ department_id: string; start_date: string; end_date: string }>;
}): void {
  pgQuery.mockImplementation(async (sql: string) => {
    if (QUOTA_SQL_RE.test(sql)) return opts.quotaCandidates ?? [];
    if (/FROM\s+skud_daily_summary/i.test(sql)) return opts.skud ?? [];
    // Порядок важен: запрос легаси-подач тоже упоминает timesheet_approval_employees
    // (в NOT EXISTS), поэтому снимок ловим по SELECT DISTINCT aa.id.
    if (/SELECT\s+DISTINCT\s+aa\.id/i.test(sql)) return (opts.lockedIds ?? []).map(id => ({ id }));
    if (/FROM\s+timesheet_approvals/i.test(sql)) return opts.legacyApprovals ?? [];
    if (/approval_status IN \('auto_approved', 'pending'\)/i.test(sql)) return opts.rows;
    if (/FROM\s+user_profiles/i.test(sql)) return (opts.timekeeperIds ?? []).map(id => ({ id }));
    if (/FROM\s+employees/i.test(sql)) return [{ id: EMP, org_department_id: 'D1' }];
    if (/status = 'work'/i.test(sql)) return opts.approvedWorkRows ?? [];
    return [];
  });
}

describe('reapproveAdjustmentsForRange — воскресенья и remote (без субботней квоты)', () => {
  // 2026-05-17 — воскресенье (нерабочий день; expected_sundays=0 → квота не применяется).
  const remoteRow = (approval: 'auto_approved' | 'pending', extra: Row = {}): Row => ({
    id: 50, employee_id: EMP, work_date: '2026-05-17', status: 'remote',
    hours_override: 8, approval_status: approval, created_by: null, ...extra,
  });
  const workRow = (approval: 'auto_approved' | 'pending', hours: number | null, extra: Row = {}): Row => ({
    id: 51, employee_id: EMP, work_date: '2026-05-17', status: 'work',
    hours_override: hours, approval_status: approval, created_by: null, ...extra,
  });

  it('auto_approved-удалёнка при approved work НЕ падает в pending (нет UPDATE)', async () => {
    mockReapprove({
      rows: [remoteRow('auto_approved')],
      approvedWorkRows: [{ employee_id: EMP, work_date: '2026-05-17' }],
    });
    expect(await reapproveAdjustmentsForRange([EMP], '2026-05-01', '2026-05-31')).toHaveLength(0);
    expect(pgExecute).not.toHaveBeenCalled();
  });

  it('без согласованного выхода удалёнка пересчитывается в pending (UPDATE)', async () => {
    mockReapprove({ rows: [remoteRow('auto_approved')] });
    expect(await reapproveAdjustmentsForRange([EMP], '2026-05-01', '2026-05-31')).toHaveLength(1);
    expect(pgExecute).toHaveBeenCalledTimes(1);
  });

  it('строка табельщицы остаётся auto_approved (не уезжает в pending)', async () => {
    mockReapprove({
      rows: [{
        id: 60, employee_id: EMP, work_date: '2026-05-17', status: 'manual',
        hours_override: 8, approval_status: 'auto_approved', created_by: 'TK-UUID',
      }],
      timekeeperIds: ['TK-UUID'],
    });
    expect(await reapproveAdjustmentsForRange([EMP], '2026-05-01', '2026-05-31')).toHaveLength(0);
    expect(pgExecute).not.toHaveBeenCalled();
  });

  it('manual 8 ч в воскресенье (не табельщица) → pending', async () => {
    mockReapprove({
      rows: [{
        id: 61, employee_id: EMP, work_date: '2026-05-17', status: 'manual',
        hours_override: 8, approval_status: 'auto_approved', created_by: 'MGR-UUID',
      }],
    });
    expect(await reapproveAdjustmentsForRange([EMP], '2026-05-01', '2026-05-31')).toHaveLength(1);
  });

  it('manual с нулём часов и с null в пересчёте → auto_approved (переходов нет)', async () => {
    mockReapprove({
      rows: [
        { id: 62, employee_id: EMP, work_date: '2026-05-17', status: 'manual', hours_override: 0, approval_status: 'auto_approved', created_by: null },
        { id: 63, employee_id: EMP, work_date: '2026-05-17', status: 'manual', hours_override: null, approval_status: 'auto_approved', created_by: null },
      ],
    });
    expect(await computeReapprovalTransitions([EMP], '2026-05-01', '2026-05-31')).toEqual([]);
  });

  it('двухфазность: work уехал в pending → связанная remote того же дня тоже pending', async () => {
    mockReapprove({ rows: [workRow('auto_approved', 8), remoteRow('auto_approved')] });
    expect(await reapproveAdjustmentsForRange([EMP], '2026-05-01', '2026-05-31')).toHaveLength(2);
  });

  it('work с 0 ч («не работал») не разрешает remote: remote → pending', async () => {
    mockReapprove({ rows: [workRow('auto_approved', 0), remoteRow('auto_approved')] });
    expect(await reapproveAdjustmentsForRange([EMP], '2026-05-01', '2026-05-31')).toHaveLength(1);
  });

  it('запрос согласованных выходов отсекает нулевые часы (фильтр в SQL)', async () => {
    mockReapprove({ rows: [remoteRow('auto_approved')] });
    await reapproveAdjustmentsForRange([EMP], '2026-05-01', '2026-05-31');
    const workSql = pgQuery.mock.calls.map(c => String(c[0])).find(s => /status = 'work'/i.test(s));
    expect(workSql).toBeDefined();
    expect(workSql).toMatch(/hours_override IS NULL OR hours_override > 0/i);
  });
});

/**
 * Фазность в пересчёте: manual зависит от множества согласованных выходов ровно так же, как
 * remote, поэтому обе считаются во второй фазе. Порядок строк из SQL не гарантирован —
 * проверяем оба направления.
 */
describe('computeReapprovalTransitions — фазность manual относительно work', () => {
  const workSat = (approval: 'auto_approved' | 'pending'): Row => ({
    id: 81, employee_id: EMP, work_date: '2026-05-09', status: 'work',
    hours_override: 8, approval_status: approval, created_by: null,
  });
  const manualSat = (approval: 'auto_approved' | 'pending'): Row => ({
    id: 82, employee_id: EMP, work_date: '2026-05-09', status: 'manual',
    hours_override: 8, approval_status: approval, created_by: null,
  });

  it('квота исчерпана: work уходит в pending, manual того же дня — тоже', async () => {
    schedule.expected_saturdays_per_month = 1;
    mockReapprove({
      rows: [workSat('auto_approved'), manualSat('auto_approved')],
      quotaCandidates: [{ employee_id: EMP, work_date: '2026-05-02' }],
    });
    const t = await computeReapprovalTransitions([EMP], '2026-05-01', '2026-05-31');
    expect(t.map(x => x.id).sort()).toEqual([81, 82]);
    expect(t.every(x => x.to === 'pending')).toBe(true);
  });

  it('тот же кейс при обратном порядке строк из SQL', async () => {
    schedule.expected_saturdays_per_month = 1;
    mockReapprove({
      rows: [manualSat('auto_approved'), workSat('auto_approved')],
      quotaCandidates: [{ employee_id: EMP, work_date: '2026-05-02' }],
    });
    const t = await computeReapprovalTransitions([EMP], '2026-05-01', '2026-05-31');
    expect(t.map(x => x.id).sort()).toEqual([81, 82]);
    expect(t.every(x => x.to === 'pending')).toBe(true);
  });

  it('квота доступна: work и manual одного дня остаются auto_approved', async () => {
    schedule.expected_saturdays_per_month = 1;
    mockReapprove({
      rows: [workSat('auto_approved'), manualSat('auto_approved')],
      quotaCandidates: [{ employee_id: EMP, work_date: '2026-05-09' }],
    });
    expect(await computeReapprovalTransitions([EMP], '2026-05-01', '2026-05-31')).toEqual([]);
  });
});

/**
 * Ретроактивный пересчёт обязательных суббот. Даты 2026-05-02/09 — субботы.
 */
describe('reapprove — обязательные субботы (бэкфилл)', () => {
  const sat = (id: number, date: string, approval: 'auto_approved' | 'pending', extra: Row = {}): Row => ({
    id, employee_id: EMP, work_date: date, status: 'work',
    hours_override: 8, approval_status: approval, created_by: null, ...extra,
  });

  it('единственная pending-суббота → auto_approved после пересчёта', async () => {
    schedule.expected_saturdays_per_month = 1;
    mockReapprove({
      rows: [sat(70, '2026-05-02', 'pending')],
      quotaCandidates: [{ employee_id: EMP, work_date: '2026-05-02' }],
    });
    const t = await computeReapprovalTransitions([EMP], '2026-05-01', '2026-05-31');
    expect(t).toEqual([
      { id: 70, from: 'pending', to: 'auto_approved', workDate: '2026-05-02', employeeId: EMP },
    ]);
  });

  it('две pending при норме 1: первая → auto, вторая остаётся pending', async () => {
    schedule.expected_saturdays_per_month = 1;
    mockReapprove({
      rows: [sat(70, '2026-05-02', 'pending'), sat(71, '2026-05-09', 'pending')],
      quotaCandidates: [
        { employee_id: EMP, work_date: '2026-05-02' },
        { employee_id: EMP, work_date: '2026-05-09' },
      ],
    });
    const t = await computeReapprovalTransitions([EMP], '2026-05-01', '2026-05-31');
    expect(t.map(x => x.id)).toEqual([70]);
    expect(t[0]!.to).toBe('auto_approved');
  });

  it('дубли: две строки на одну субботу (норма 1) → обе auto (дата считается один раз)', async () => {
    schedule.expected_saturdays_per_month = 1;
    mockReapprove({
      rows: [
        sat(70, '2026-05-02', 'pending'),
        sat(72, '2026-05-02', 'pending', { status: 'remote' }),
      ],
      quotaCandidates: [
        { employee_id: EMP, work_date: '2026-05-02' },
        { employee_id: EMP, work_date: '2026-05-02' },
      ],
    });
    const t = await computeReapprovalTransitions([EMP], '2026-05-01', '2026-05-31');
    expect(t.map(x => x.id).sort()).toEqual([70, 72]);
    expect(t.every(x => x.to === 'auto_approved')).toBe(true);
  });

  it('СКУД-суббота без корректировки занимает слот → заявка на следующую остаётся pending', async () => {
    schedule.expected_saturdays_per_month = 1;
    mockReapprove({
      rows: [sat(71, '2026-05-09', 'pending')],
      quotaCandidates: [{ employee_id: EMP, work_date: '2026-05-09' }],
      skud: [{ employee_id: EMP, date: '2026-05-02' }],
    });
    const t = await computeReapprovalTransitions([EMP], '2026-05-01', '2026-05-31');
    expect(t).toEqual([]);
  });
});

/**
 * Гард закрытых периодов: строки уже поданного/утверждённого табеля пересчёт не трогает —
 * редактирование там закрыто, переигрывать статусы задним числом нельзя.
 */
describe('computeReapprovalTransitions — гард закрытых подач', () => {
  const sat = (id: number, date: string): Row => ({
    id, employee_id: EMP, work_date: date, status: 'work',
    hours_override: 8, approval_status: 'pending', created_by: null,
  });

  it('строка в submitted-периоде (по снимку состава) не попадает в переходы', async () => {
    schedule.expected_saturdays_per_month = 1;
    mockReapprove({
      rows: [sat(70, '2026-05-02')],
      quotaCandidates: [{ employee_id: EMP, work_date: '2026-05-02' }],
      lockedIds: [70],
    });
    expect(await computeReapprovalTransitions([EMP], '2026-05-01', '2026-05-31')).toEqual([]);
  });

  it('1–15 закрыт, 16–31 открыт: пересчитывается только вторая половина', async () => {
    schedule.expected_saturdays_per_month = 2;
    mockReapprove({
      rows: [sat(70, '2026-05-02'), sat(71, '2026-05-23')],
      quotaCandidates: [
        { employee_id: EMP, work_date: '2026-05-02' },
        { employee_id: EMP, work_date: '2026-05-23' },
      ],
      lockedIds: [70],
    });
    const t = await computeReapprovalTransitions([EMP], '2026-05-01', '2026-05-31');
    expect(t.map(x => x.id)).toEqual([71]);
  });

  it('подача без снимка состава: fallback по членству отдела, только даты внутри периода', async () => {
    schedule.expected_saturdays_per_month = 2;
    mockReapprove({
      rows: [sat(70, '2026-05-02'), sat(71, '2026-05-23')],
      quotaCandidates: [
        { employee_id: EMP, work_date: '2026-05-02' },
        { employee_id: EMP, work_date: '2026-05-23' },
      ],
      legacyApprovals: [{ department_id: 'D1', start_date: '2026-05-01', end_date: '2026-05-15' }],
    });
    assignedEmployeesMock.mockResolvedValue([EMP]);
    const t = await computeReapprovalTransitions([EMP], '2026-05-01', '2026-05-31');
    // 02.05 внутри закрытой подачи → заморожена; 23.05 вне её → пересчитывается.
    expect(t.map(x => x.id)).toEqual([71]);
  });

  it('подача без снимка: сотрудник не в составе → строки не блокируются', async () => {
    schedule.expected_saturdays_per_month = 2;
    mockReapprove({
      rows: [sat(70, '2026-05-02')],
      quotaCandidates: [{ employee_id: EMP, work_date: '2026-05-02' }],
      legacyApprovals: [{ department_id: 'D1', start_date: '2026-05-01', end_date: '2026-05-15' }],
    });
    assignedEmployeesMock.mockResolvedValue([EMP + 1]);
    const t = await computeReapprovalTransitions([EMP], '2026-05-01', '2026-05-31');
    expect(t.map(x => x.id)).toEqual([70]);
  });
});

describe('advisory-lock квоты', () => {
  it('ключ = (employee_id, YYYYMM)', () => {
    expect(quotaLockKeys(6006, '2026-07-18')).toEqual([6006, 202607]);
  });

  it('withQuotaLocks берёт локи в детерминированном порядке и дедуплицирует', async () => {
    pgQuery.mockImplementation(async () => []);
    await withQuotaLocks(
      [
        { employeeId: 200, workDate: '2026-07-18' },
        { employeeId: 100, workDate: '2026-08-01' },
        { employeeId: 100, workDate: '2026-07-04' },
        { employeeId: 100, workDate: '2026-07-18' }, // тот же (100, 202607) — дубль
      ],
      async () => null,
    );
    const locks = txQueries
      .filter(q => /pg_advisory_xact_lock/.test(q.sql))
      .map(q => q.params);
    expect(locks).toEqual([[100, 202607], [100, 202608], [200, 202607]]);
  });
});
