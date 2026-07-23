import { beforeEach, describe, expect, it, vi } from 'vitest';

// Мокаем только то, что дёргают resolveAdjustmentApprovalStatus / reapprove в рантайме:
// query (employees, «есть ли согласованный выход», кандидаты квоты, СКУД), whitelist-настройку
// и schedule.service (resolveSchedulesForPeriod/isWorkingDay/loadCalendarMonth).
const { pgQuery, pgExecute } = vi.hoisted(() => ({ pgQuery: vi.fn(), pgExecute: vi.fn(async () => undefined) }));
vi.mock('../config/postgres.js', async (importActual) => ({
  ...(await importActual<typeof import('../config/postgres.js')>()),
  query: pgQuery,
  execute: pgExecute,
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

import {
  resolveAdjustmentApprovalStatus,
  reapproveAdjustmentsForRange,
  computeReapprovalTransitions,
} from './timesheet.controller.js';

const EMP = 100;

/**
 * Маршрутизация query по содержимому SQL.
 * - employees — отдел сотрудника (whitelist);
 * - `SELECT id FROM attendance_adjustments` — hasApprovedWorkOnDate (согласованный выход);
 * - `status IN ('work','remote')` — кандидаты обязательного слота (loadWorkedSaturdaysForQuota);
 * - `FROM skud_daily_summary` — СКУД-присутствие без корректировки.
 * `worked`/`skud` задают уже отработанные субботы месяца (даты ISO).
 */
function mockResolve(opts: { approvedWork?: boolean; worked?: string[]; skud?: string[] } = {}): void {
  pgQuery.mockImplementation(async (sql: string) => {
    if (/FROM\s+employees/i.test(sql)) return [{ id: EMP, org_department_id: 'D1' }];
    if (/SELECT\s+id\s+FROM\s+attendance_adjustments/i.test(sql)) {
      return opts.approvedWork ? [{ id: 1 }] : [];
    }
    if (/status IN \('work', 'remote'\)/i.test(sql)) {
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
  isHolidayOnWorkdayMock.mockReset();
  isHolidayOnWorkdayMock.mockReturnValue(false);
  isWorkingDayMock.mockReset();
  isWorkingDayMock.mockReturnValue(false);
  calendar.holidays = [];
  calendar.mandatory_holidays = [];
  schedule.expected_saturdays_per_month = 2;
  schedule.respects_holidays = true;
  // resolveSchedulesForPeriod зовётся с (workDate, workDate); get возвращает текущий schedule.
  scheduleByEmp.value = new Map([[EMP, { get: () => schedule } as unknown as Map<string, unknown>]]);
});

/**
 * Восстановленная count-модель (как до коммита 41830323): обязательной считается первая
 * фактически ОТРАБОТАННАЯ непраздничная суббота месяца в пределах expected_saturdays_per_month
 * → auto_approved; вторая и последующие → pending. Только work/remote; manual — всегда pending.
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

  it('запрос кандидатов квоты фильтрует нулевые часы (SQL)', async () => {
    mockResolve({ worked: [] });
    await resolveAdjustmentApprovalStatus(EMP, '2026-05-09', 'work', null);
    const q = pgQuery.mock.calls.map(c => String(c[0])).find(s => /status IN \('work', 'remote'\)/i.test(s));
    expect(q).toBeDefined();
    expect(q).toMatch(/hours_override IS NULL OR hours_override > 0/i);
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

/**
 * Гейт квоты — строго work/remote. Положительный manual (ручные и объектные правки с реальными
 * 7–8 ч) в нерабочий день НЕ автосогласуется по квоте, а идёт к ответственному за выходные
 * (обход самосогласования остаётся закрытым).
 */
describe('resolveAdjustmentApprovalStatus — manual в нерабочий день', () => {
  it('manual 8 ч в субботу → pending (в квоту не попадает)', async () => {
    mockResolve({ worked: [] });
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-02', 'manual', 8)).toBe('pending');
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

describe('resolveAdjustmentApprovalStatus — удалёнка поверх согласованного выхода', () => {
  // Квота исчерпана (2 прежних субботы при норме 2), поэтому решает ветка remote-over-work.
  it('remote в выходной с уже согласованным work → auto_approved', async () => {
    mockResolve({ approvedWork: true, worked: ['2026-05-02', '2026-05-09'] });
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-16', 'remote')).toBe('auto_approved');
  });

  it('remote в выходной без согласованного выхода (сверх квоты) → pending', async () => {
    mockResolve({ approvedWork: false, worked: ['2026-05-02', '2026-05-09'] });
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-16', 'remote')).toBe('pending');
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

describe('reapproveAdjustmentsForRange — воскресенья и remote (без субботней квоты)', () => {
  // 2026-05-17 — воскресенье (нерабочий день; expected_sundays=0 → квота не применяется).
  type Row = Record<string, unknown>;

  function mockReapprove(opts: {
    rows: Row[];
    approvedWorkRows?: Array<{ employee_id: number; work_date: string }>;
    timekeeperIds?: string[];
    quotaCandidates?: Array<{ employee_id: number; work_date: string }>;
    skud?: Array<{ employee_id: number; date: string }>;
  }): void {
    pgQuery.mockImplementation(async (sql: string) => {
      if (/status IN \('work', 'remote'\)/i.test(sql)) return opts.quotaCandidates ?? [];
      if (/FROM\s+skud_daily_summary/i.test(sql)) return opts.skud ?? [];
      if (/approval_status IN \('auto_approved', 'pending'\)/i.test(sql)) return opts.rows;
      if (/FROM\s+user_profiles/i.test(sql)) return (opts.timekeeperIds ?? []).map(id => ({ id }));
      if (/FROM\s+employees/i.test(sql)) return [{ id: EMP, org_department_id: 'D1' }];
      if (/status = 'work'/i.test(sql)) return opts.approvedWorkRows ?? [];
      return [];
    });
  }

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
    expect(await reapproveAdjustmentsForRange([EMP], '2026-05-01', '2026-05-31')).toBe(0);
    expect(pgExecute).not.toHaveBeenCalled();
  });

  it('без согласованного выхода удалёнка пересчитывается в pending (UPDATE)', async () => {
    mockReapprove({ rows: [remoteRow('auto_approved')] });
    expect(await reapproveAdjustmentsForRange([EMP], '2026-05-01', '2026-05-31')).toBe(1);
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
    expect(await reapproveAdjustmentsForRange([EMP], '2026-05-01', '2026-05-31')).toBe(0);
    expect(pgExecute).not.toHaveBeenCalled();
  });

  it('manual 8 ч в выходной (не табельщица) → pending', async () => {
    mockReapprove({
      rows: [{
        id: 61, employee_id: EMP, work_date: '2026-05-17', status: 'manual',
        hours_override: 8, approval_status: 'auto_approved', created_by: 'MGR-UUID',
      }],
    });
    expect(await reapproveAdjustmentsForRange([EMP], '2026-05-01', '2026-05-31')).toBe(1);
  });

  it('двухфазность: work уехал в pending → связанная remote того же дня тоже pending', async () => {
    mockReapprove({ rows: [workRow('auto_approved', 8), remoteRow('auto_approved')] });
    expect(await reapproveAdjustmentsForRange([EMP], '2026-05-01', '2026-05-31')).toBe(2);
  });

  it('work с 0 ч («не работал») не разрешает remote: remote → pending', async () => {
    mockReapprove({ rows: [workRow('auto_approved', 0), remoteRow('auto_approved')] });
    expect(await reapproveAdjustmentsForRange([EMP], '2026-05-01', '2026-05-31')).toBe(1);
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
 * Ретроактивный пересчёт обязательных суббот: накопившиеся после 13.07 pending-субботы
 * должны корректно переводиться в auto_approved. Даты 2026-05-02/09 — субботы.
 */
describe('reapprove — обязательные субботы (бэкфилл)', () => {
  type Row = Record<string, unknown>;

  function mockReapprove(opts: {
    rows: Row[];
    quotaCandidates?: Array<{ employee_id: number; work_date: string }>;
    skud?: Array<{ employee_id: number; date: string }>;
  }): void {
    pgQuery.mockImplementation(async (sql: string) => {
      if (/status IN \('work', 'remote'\)/i.test(sql)) return opts.quotaCandidates ?? [];
      if (/FROM\s+skud_daily_summary/i.test(sql)) return opts.skud ?? [];
      if (/approval_status IN \('auto_approved', 'pending'\)/i.test(sql)) return opts.rows;
      if (/FROM\s+user_profiles/i.test(sql)) return [];
      if (/FROM\s+employees/i.test(sql)) return [{ id: EMP, org_department_id: 'D1' }];
      if (/status = 'work'/i.test(sql)) return [];
      return [];
    });
  }

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
    expect(t).toEqual([{ id: 70, from: 'pending', to: 'auto_approved' }]);
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
    expect(t).toEqual([{ id: 70, from: 'pending', to: 'auto_approved' }]);
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
