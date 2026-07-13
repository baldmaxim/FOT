import { beforeEach, describe, expect, it, vi } from 'vitest';

// Мокаем только то, что дёргает resolveAdjustmentApprovalStatus в рантайме:
// query (employees + «есть ли согласованный выход»), whitelist-настройку и
// schedule.service (resolveSchedulesForPeriod/isWorkingDay/loadCalendarMonth).
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
  isWorkingDayMock: vi.fn(() => false), // тестовые даты — субботы (нерабочие)
  isHolidayOnWorkdayMock: vi.fn(() => false),
}));

vi.mock('../services/schedule.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/schedule.service.js')>()),
  resolveSchedulesForPeriod: vi.fn(async () => scheduleByEmp.value),
  isWorkingDay: isWorkingDayMock,
  isHolidayOnWorkday: isHolidayOnWorkdayMock,
  loadCalendarMonth: vi.fn(async () => calendar),
}));

import { resolveAdjustmentApprovalStatus, reapproveAdjustmentsForRange } from './timesheet.controller.js';

const EMP = 100;

/**
 * Маршрутизация query по содержимому SQL. Запрос «есть ли согласованный выход»
 * (hasApprovedWorkOnDate: SELECT id ... status='work') разводим отдельно — по умолчанию
 * пуст; задаётся флагом для проверки авто-зачёта удалёнки.
 */
function mockResolve(approvedWorkExists = false): void {
  pgQuery.mockImplementation(async (sql: string) => {
    if (/FROM\s+employees/i.test(sql)) {
      return [{ id: EMP, org_department_id: 'D1' }];
    }
    if (/SELECT\s+id\s+FROM\s+attendance_adjustments/i.test(sql)) {
      return approvedWorkExists ? [{ id: 1 }] : [];
    }
    return [];
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  isHolidayOnWorkdayMock.mockReset();
  isHolidayOnWorkdayMock.mockReturnValue(false);
  calendar.holidays = [];
  calendar.mandatory_holidays = [];
  schedule.expected_saturdays_per_month = 2;
  schedule.respects_holidays = true;
  // resolveSchedulesForPeriod в resolve зовётся с (workDate, workDate); подменим
  // get на возврат текущего schedule вне зависимости от ключа даты.
  scheduleByEmp.value = new Map([[EMP, { get: () => schedule } as unknown as Map<string, unknown>]]);
});

/**
 * Квоты плановых суббот в согласовании БОЛЬШЕ НЕТ (раньше первые N непраздничных суббот
 * месяца автосогласовывались). Правило: на плановую субботу заявление не подают, значит
 * любой выход в нерабочий день решает ответственный за выходные.
 */
describe('resolveAdjustmentApprovalStatus — выходные больше не автосогласуются по квоте', () => {
  it('1-я суббота месяца при норме 2 → pending (раньше auto_approved)', async () => {
    mockResolve();
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-02', 'remote')).toBe('pending');
  });

  it('2-я суббота при норме 2 → pending (раньше auto_approved)', async () => {
    mockResolve();
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-09', 'remote')).toBe('pending');
  });

  it('3-я суббота → pending', async () => {
    mockResolve();
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-16', 'remote')).toBe('pending');
  });

  it('expected_saturdays_per_month=0 → pending', async () => {
    schedule.expected_saturdays_per_month = 0;
    mockResolve();
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-02', 'remote')).toBe('pending');
  });

  it('праздник-будень 12.06 при квоте >0 → pending (раньше auto_approved)', async () => {
    calendar.holidays = ['2026-06-12'];
    isHolidayOnWorkdayMock.mockReturnValue(true);
    mockResolve();
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-06-12', 'remote')).toBe('pending');
  });

  it('заявление на субботу без часов (hours_override=null) → pending, а не auto', async () => {
    // Заявление подаётся заранее: часов ещё нет (null). Оно обязано дойти до ответственного.
    mockResolve();
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-02', 'work', null)).toBe('pending');
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
});

/**
 * Дефект: положительный manual (ручные и объектные правки — они пишутся именно с этим
 * статусом и несут реальные 7–8 ч) в нерабочий день молча обходил ответственного.
 */
describe('resolveAdjustmentApprovalStatus — manual в нерабочий день', () => {
  it('manual 8 ч в субботу → pending (раньше auto_approved)', async () => {
    mockResolve();
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
  it('remote в выходной с уже согласованным work → auto_approved', async () => {
    mockResolve(true);
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-16', 'remote')).toBe('auto_approved');
  });

  it('remote в выходной без согласованного выхода → pending', async () => {
    mockResolve(false);
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-16', 'remote')).toBe('pending');
  });

  it('согласованным выходом не считается work с нулём часов (фильтр в SQL)', async () => {
    mockResolve(false);
    await resolveAdjustmentApprovalStatus(EMP, '2026-05-16', 'remote');
    const sqls = pgQuery.mock.calls.map(c => String(c[0]));
    const workSql = sqls.find(s => /SELECT\s+id\s+FROM\s+attendance_adjustments/i.test(s));
    expect(workSql).toBeDefined();
    expect(workSql).toMatch(/hours_override IS NULL OR hours_override > 0/i);
  });
});

describe('reapproveAdjustmentsForRange', () => {
  // 2026-05-17 — воскресенье (нерабочий день, isWorkingDay замокан в false).
  type Row = Record<string, unknown>;

  function mockReapprove(opts: {
    rows: Row[];
    approvedWorkRows?: Array<{ employee_id: number; work_date: string }>;
    timekeeperIds?: string[];
  }): void {
    pgQuery.mockImplementation(async (sql: string) => {
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
    // Оба auto_approved. work пересчитывается в pending, значит согласованного выхода
    // в этот день больше нет — remote не имеет права остаться auto_approved.
    mockReapprove({ rows: [workRow('auto_approved', 8), remoteRow('auto_approved')] });
    expect(await reapproveAdjustmentsForRange([EMP], '2026-05-01', '2026-05-31')).toBe(2);
  });

  it('work с 0 ч («не работал») не разрешает remote: remote → pending', async () => {
    // work с нулём часов остаётся auto_approved (не работал), но согласованным выходом
    // не считается → remote обязана уехать на согласование.
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
