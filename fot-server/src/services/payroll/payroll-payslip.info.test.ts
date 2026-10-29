import { beforeEach, describe, expect, it, vi } from 'vitest';

// Листок карточки: посчитанный месяц (закрытый или предварительно по живому табелю) — из основы расчёта; посчитать
// нечем — прежний путь по табелю. Графики месяца — по всем дням месяца, как у нормы.
const pg = vi.hoisted(() => ({ query: vi.fn(), queryOne: vi.fn() }));
vi.mock('../../config/postgres.js', () => ({
  query: pg.query,
  queryOne: pg.queryOne,
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

const calcService = vi.hoisted(() => ({ getPayoutForEmployees: vi.fn(), getPreliminaryPayoutForEmployees: vi.fn() }));
vi.mock('./payroll-calc.service.js', () => calcService);

const schedules = vi.hoisted(() => ({ resolveSchedulesForPeriod: vi.fn() }));
vi.mock('../schedule.service.js', () => ({ ...schedules, isWorkingDay: vi.fn(() => true) }));

const live = vi.hoisted(() => ({ fetchTimesheetDataForEmployees: vi.fn() }));
vi.mock('../timesheet-export.service.js', () => live);

import type { AuthenticatedRequest } from '../../types/index.js';
import { getPayslipInfo, groupPayslipSchedules } from './payroll-payslip.service.js';

const req = { user: { id: 'user-1' } } as unknown as AuthenticatedRequest;

const septemberDates = Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`);
const day = (scheduleId: string, name: string | null, anchor: string | null = null) => ({
  schedule_id: scheduleId, name, assignment_anchor_date: anchor,
});

const counted = {
  norm_days: 22,
  period_from: '2026-09-01',
  period_to: '2026-09-30',
  worked_days: { workday: 22, dayoff: 0 },
  absences: { vacation: 0, sick: 0, educational_leave: 0, unpaid: 0 },
  rate_allowances: [{ code: 'travel', amount: '2730.00', days: { worked: 22, norm: 22 }, rate: '2730.00' }],
  terms: [{
    effective_from: '2026-08-01', effective_to: null, calc_type: 'salary', monthly_salary: '150000.00',
    hourly_rate: null, bonus_amount: null,
  }],
  lines: [{ code: 'contract', amount: '150000.00', days: { worked: 22, norm: 22 } }],
  deductions: [],
  accrued: '152730.00',
  deducted: '0.00',
  net: '152730.00',
  missing: [],
};

describe('getPayslipInfo — состояния расчёта', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    schedules.resolveSchedulesForPeriod.mockResolvedValue(new Map([[42, new Map(
      septemberDates.map(date => [date, day('5-2', '5+2 (Линия С/О)')]),
    )]]));
  });

  it('закрытый месяц — из основы, живой табель не собирается; графики месяца — справочно', async () => {
    calcService.getPayoutForEmployees.mockResolvedValue(new Map([[42, {
      state: 'closed', quality: 'reconstructed', basis_ids: [1], version_ids: [2], ...counted,
    }]]));

    const info = await getPayslipInfo(42, '2026-09', req);

    expect(calcService.getPreliminaryPayoutForEmployees).not.toHaveBeenCalled();
    expect(live.fetchTimesheetDataForEmployees).not.toHaveBeenCalled();
    expect(info.calc).toMatchObject({ state: 'closed', net: '152730.00' });
    expect(info.calc).not.toHaveProperty('terms');
    expect(info.terms).toEqual([{ effective_from: '2026-08-01', effective_to: null, calc_type: 'salary', amount: '150000.00' }]);
    expect(info.rate_allowances).toEqual(counted.rate_allowances);
    expect(info.schedules).toEqual([{ name: '5+2 (Линия С/О)', from: '2026-09-01', to: '2026-09-30' }]);
    expect(schedules.resolveSchedulesForPeriod).toHaveBeenCalledWith([{ id: 42 }], '2026-09-01', '2026-09-30');
  });

  it('preliminary — незакрытый месяц предварительно по живому табелю, листок из той же основы', async () => {
    calcService.getPreliminaryPayoutForEmployees.mockResolvedValue(new Map([[42, {
      state: 'preliminary', as_of: '2026-09-30', ...counted,
    }]]));

    const info = await getPayslipInfo(42, '2026-09', req, { preliminary: true });

    expect(calcService.getPayoutForEmployees).not.toHaveBeenCalled();
    expect(live.fetchTimesheetDataForEmployees).not.toHaveBeenCalled();
    expect(info.calc).toMatchObject({ state: 'preliminary', as_of: '2026-09-30', net: '152730.00' });
    expect(info.worked_days).toEqual({ workday: 22, dayoff: 0 });
  });

  it('посчитать нечем (не работал в месяце) — not_closed, графики всё равно отдаются', async () => {
    calcService.getPreliminaryPayoutForEmployees.mockResolvedValue(new Map([[42, { state: 'not_closed', reason: 'no_period' }]]));
    live.fetchTimesheetDataForEmployees.mockResolvedValue({ cutoffByEmployeeId: new Map([[42, '2026-09-01']]) });
    pg.queryOne.mockResolvedValue({ hire_date: null, org_department_id: null, employment_status: 'dismissed' });

    const info = await getPayslipInfo(42, '2026-09', req, { preliminary: true });

    expect(info).toMatchObject({ calc: { state: 'not_closed', reason: 'no_period' }, period_from: null, worked_days: null });
    expect(info.schedules).toHaveLength(1);
  });
});

describe('groupPayslipSchedules — графики месяца', () => {
  it('назначение на часть месяца — остальные дни графиком по умолчанию, отдельными интервалами', () => {
    const days = septemberDates.map(date => [
      date, date >= '2026-09-10' && date <= '2026-09-20' ? day('6-0', '6+0 (11 ч)') : day('def', 'Пятидневка'),
    ] as const);
    expect(groupPayslipSchedules(days)).toEqual([
      { name: 'Пятидневка', from: '2026-09-01', to: '2026-09-09' },
      { name: '6+0 (11 ч)', from: '2026-09-10', to: '2026-09-20' },
      { name: 'Пятидневка', from: '2026-09-21', to: '2026-09-30' },
    ]);
  });

  it('два графика за месяц; новая точка отсчёта цикла — новый интервал при том же имени; без имени — «Стандартный график»', () => {
    const days = septemberDates.map(date => [
      date,
      date < '2026-09-16' ? day('2-2', '2/2', '2026-08-01') : day('2-2', '2/2', '2026-09-16'),
    ] as const);
    expect(groupPayslipSchedules(days)).toEqual([
      { name: '2/2', from: '2026-09-01', to: '2026-09-15' },
      { name: '2/2', from: '2026-09-16', to: '2026-09-30' },
    ]);
    expect(groupPayslipSchedules([['2026-09-01', day('x', '  ')], ['2026-09-02', day('x', null)]]))
      .toEqual([{ name: 'Стандартный график', from: '2026-09-01', to: '2026-09-02' }]);
  });
});
