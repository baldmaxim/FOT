import { beforeEach, describe, expect, it, vi } from 'vitest';

// Мокаем только то, что дёргает resolveAdjustmentApprovalStatus в рантайме:
// query (employees + loadAcceptedWeekendDaysForMonth), whitelist-настройку и
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
  // Внутренний isWorkingDay в реальном isHolidayOnWorkday не видит наш мок — поэтому
  // переопределяем сам предикат явно (по умолчанию праздников-буден нет).
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
 * Маршрутизация query по содержимому SQL: employees / attendance_adjustments.
 * Запрос «есть ли согласованный выход» (status='work' + approval_status IN) разводим
 * отдельно — по умолчанию пуст; задаётся опционально для проверки авто-зачёта удалёнки.
 */
function setAcceptedSaturdays(dates: string[], approvedWorkExists = false): void {
  pgQuery.mockImplementation(async (sql: string) => {
    if (/FROM\s+employees/i.test(sql)) {
      return [{ id: EMP, org_department_id: 'D1' }];
    }
    if (/SELECT\s+id\s+FROM\s+attendance_adjustments/i.test(sql)) {
      return approvedWorkExists ? [{ id: 1 }] : [];
    }
    if (/FROM\s+attendance_adjustments/i.test(sql)) {
      return dates.map(d => ({ employee_id: EMP, work_date: d }));
    }
    if (/FROM\s+skud_daily_summary/i.test(sql)) {
      return [];
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
  scheduleByEmp.value = new Map([[EMP, new Map([['__any__', schedule]])]]);
  // resolveSchedulesForPeriod в resolve зовётся с (workDate, workDate); подменим
  // get на возврат текущего schedule вне зависимости от ключа даты.
  (scheduleByEmp.value as Map<number, Map<string, unknown>>).set(EMP, {
    get: () => schedule,
  } as unknown as Map<string, unknown>);
});

describe('resolveAdjustmentApprovalStatus — квота обязательных суббот', () => {
  it('1-я суббота месяца при норме 2 → auto_approved', async () => {
    setAcceptedSaturdays([]);
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-02', 'remote')).toBe('auto_approved');
  });

  it('2-я суббота (1 принятая ранее) → auto_approved', async () => {
    setAcceptedSaturdays(['2026-05-02']);
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-09', 'remote')).toBe('auto_approved');
  });

  it('3-я суббота (2 принятые ранее) → pending', async () => {
    setAcceptedSaturdays(['2026-05-02', '2026-05-09']);
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-16', 'remote')).toBe('pending');
  });

  it('идемпотентность: переоценка уже принятой 2-й субботы → auto_approved', async () => {
    // В наборе уже есть и 02, и 09. Для workDate=09 usedBefore считает только d<09 → 1.
    setAcceptedSaturdays(['2026-05-02', '2026-05-09']);
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-09', 'remote')).toBe('auto_approved');
  });

  it('праздничная суббота (mandatory_holidays) при свободной квоте → pending', async () => {
    calendar.mandatory_holidays = ['2026-05-02'];
    setAcceptedSaturdays([]);
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-02', 'remote')).toBe('pending');
  });

  it('праздничные субботы не занимают слот: рабочая суббота после праздничной → auto_approved', async () => {
    // 02 — праздник и «принят»; для 09 он не должен считаться в usedBefore.
    calendar.holidays = ['2026-05-02'];
    setAcceptedSaturdays(['2026-05-02']);
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-09', 'remote')).toBe('auto_approved');
  });

  it('expected_saturdays_per_month=0 → pending (ветка квоты не входит)', async () => {
    schedule.expected_saturdays_per_month = 0;
    setAcceptedSaturdays([]);
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-02', 'remote')).toBe('pending');
  });

  it('отдел не в whitelist → auto_approved (ранний выход)', async () => {
    pgQuery.mockImplementation(async (sql: string) => {
      if (/FROM\s+employees/i.test(sql)) return [{ id: EMP, org_department_id: 'OTHER' }];
      return [];
    });
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-02', 'remote')).toBe('auto_approved');
  });

  it('hours_override=0 → auto_approved (не работал)', async () => {
    setAcceptedSaturdays([]);
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-16', 'work', 0)).toBe('auto_approved');
  });

  it('праздник-будень 12.06 при квоте >0 → auto_approved (зачтён как обязательная суббота)', async () => {
    calendar.holidays = ['2026-06-12'];
    isHolidayOnWorkdayMock.mockImplementation((_s: unknown, d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` === '2026-06-12');
    setAcceptedSaturdays([]);
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-06-12', 'remote')).toBe('auto_approved');
  });

  it('праздник-будень 12.06 при квоте 0 → pending', async () => {
    schedule.expected_saturdays_per_month = 0;
    calendar.holidays = ['2026-06-12'];
    isHolidayOnWorkdayMock.mockImplementation((_s: unknown, d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` === '2026-06-12');
    setAcceptedSaturdays([]);
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-06-12', 'remote')).toBe('pending');
  });
});

describe('resolveAdjustmentApprovalStatus — удалёнка поверх согласованного выхода', () => {
  it('remote в выходной с уже согласованной заявкой work → auto_approved', async () => {
    // Квота исчерпана (2 субботы приняты), но за день есть одобренный work → зачёт сразу.
    setAcceptedSaturdays(['2026-05-02', '2026-05-09'], true);
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-16', 'remote')).toBe('auto_approved');
  });

  it('remote в выходной без согласованного выхода → pending', async () => {
    setAcceptedSaturdays(['2026-05-02', '2026-05-09'], false);
    expect(await resolveAdjustmentApprovalStatus(EMP, '2026-05-16', 'remote')).toBe('pending');
  });
});

describe('reapproveAdjustmentsForRange — удалёнка поверх согласованного выхода', () => {
  // 2026-05-17 — воскресенье (нерабочий, вне квоты обязательных суббот).
  // Маршрутизация: rows (auto_approved/pending) → remote-строка; employees → отдел D1 (whitelist);
  // approved work (status='work') → задаётся флагом hasApprovedWork.
  function mockReapprove(hasApprovedWork: boolean, remoteApprovalStatus: 'auto_approved' | 'pending'): void {
    pgQuery.mockImplementation(async (sql: string) => {
      if (/approval_status IN \('auto_approved', 'pending'\)/i.test(sql)) {
        return [{ id: 50, employee_id: EMP, work_date: '2026-05-17', status: 'remote', hours_override: 8, approval_status: remoteApprovalStatus }];
      }
      if (/FROM\s+employees/i.test(sql)) {
        return [{ id: EMP, org_department_id: 'D1' }];
      }
      if (/status = 'work'/i.test(sql)) {
        return hasApprovedWork ? [{ employee_id: EMP, work_date: '2026-05-17' }] : [];
      }
      return [];
    });
  }

  it('auto_approved-удалёнка при approved work НЕ падает в pending (нет UPDATE)', async () => {
    mockReapprove(true, 'auto_approved');
    const changed = await reapproveAdjustmentsForRange([EMP], '2026-05-01', '2026-05-31');
    expect(changed).toBe(0);
    expect(pgExecute).not.toHaveBeenCalled();
  });

  it('без approved work удалёнка пересчитывается в pending (UPDATE)', async () => {
    mockReapprove(false, 'auto_approved');
    const changed = await reapproveAdjustmentsForRange([EMP], '2026-05-01', '2026-05-31');
    expect(changed).toBe(1);
    expect(pgExecute).toHaveBeenCalledTimes(1);
  });
});
