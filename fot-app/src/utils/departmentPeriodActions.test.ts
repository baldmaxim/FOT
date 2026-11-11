import { describe, expect, it } from 'vitest';
import { resolveDepartmentPeriodHalfButtons, summarizeMonthHalves } from './departmentPeriodActions';
import type {
  IDepartmentPeriodState,
  ITimesheetApproval,
  TimesheetApprovalStatus,
} from '../services/timesheetApprovalService';

const H1 = { half: 1 as const, start_date: '2026-10-01', end_date: '2026-10-15' };
const H2 = { half: 2 as const, start_date: '2026-10-16', end_date: '2026-10-31' };

const info = (id: number, label: string, start = '2026-10-01', end = '2026-10-15') => ({
  id, label, status: 'approved' as const, start_date: start, end_date: end, unlocked: false,
});

const state = (halves: IDepartmentPeriodState['halves']): IDepartmentPeriodState => ({
  start_date: halves[0]!.start_date,
  end_date: halves[halves.length - 1]!.end_date,
  halves,
  approvals: [
    info(2772, 'Табель отдела: ЛИНИЯ'),
    info(2773, 'Табель отдела: ЛИНИЯ', '2026-10-16', '2026-10-31'),
    info(2179, 'Личный табель: Иванишин С. А.'),
    info(2222, 'Личный табель: Баранский С. С.', '2026-10-01', '2026-10-31'),
  ],
});

describe('кнопки «Открыть/Закрыть табель» по половинам', () => {
  it('весь месяц, обе половины закрыты — у каждой своя «Открыть табель» с подписью', () => {
    const halves = resolveDepartmentPeriodHalfButtons(state([
      { ...H1, open_ids: [2179, 2222, 2772], close_ids: [] },
      { ...H2, open_ids: [2222, 2773], close_ids: [] },
    ]));
    expect(halves).toEqual([
      { ...H1, periodLabel: '1–15 окт 2026', canOpen: true, canClose: false },
      { ...H2, periodLabel: '16–31 окт 2026', canOpen: true, canClose: false },
    ]);
  });

  it('открыта 1–15 — у неё «Закрыть», у 16–31 «Открыть»', () => {
    const halves = resolveDepartmentPeriodHalfButtons(state([
      { ...H1, open_ids: [], close_ids: [2179, 2772] },
      { ...H2, open_ids: [2773], close_ids: [] },
    ]));
    expect(halves.map(h => [h.half, h.canOpen, h.canClose])).toEqual([[1, false, true], [2, true, false]]);
  });

  it('обе открыты — у обеих «Закрыть»', () => {
    const halves = resolveDepartmentPeriodHalfButtons(state([
      { ...H1, open_ids: [], close_ids: [2772] },
      { ...H2, open_ids: [], close_ids: [2773] },
    ]));
    expect(halves.map(h => [h.canOpen, h.canClose])).toEqual([[false, true], [false, true]]);
  });

  it('в половине открыт табель отдела, но закрыт личный — обе кнопки', () => {
    const [half] = resolveDepartmentPeriodHalfButtons(state([{ ...H1, open_ids: [2179], close_ids: [2772] }]));
    expect(half).toMatchObject({ canOpen: true, canClose: true });
  });

  it('половина, где нечего открыть и закрыть, кнопок не получает', () => {
    const halves = resolveDepartmentPeriodHalfButtons(state([
      { ...H1, open_ids: [2772], close_ids: [] },
      { ...H2, open_ids: [], close_ids: [] },
    ]));
    expect(halves.map(h => h.half)).toEqual([1]);
  });

  it('режим одной половины и подпись по последнему дню месяца', () => {
    const halves = resolveDepartmentPeriodHalfButtons({
      start_date: '2026-11-16', end_date: '2026-11-30', approvals: [],
      halves: [{ half: 2, start_date: '2026-11-16', end_date: '2026-11-30', open_ids: [1], close_ids: [] }],
    });
    expect(halves).toEqual([{ half: 2, start_date: '2026-11-16', end_date: '2026-11-30', periodLabel: '16–30 ноя 2026', canOpen: true, canClose: false }]);
  });

  it('нет ответа — кнопок нет', () => {
    expect(resolveDepartmentPeriodHalfButtons(null)).toEqual([]);
    expect(resolveDepartmentPeriodHalfButtons(undefined)).toEqual([]);
  });
});

const approval = (
  id: number,
  status: TimesheetApprovalStatus,
  start: string,
  end: string,
  extra: Partial<ITimesheetApproval> = {},
): ITimesheetApproval => ({
  id,
  department_id: 'dept',
  manager_employee_id: null,
  start_date: start,
  end_date: end,
  status,
  submitted_by: null,
  submitted_at: null,
  reviewed_by: null,
  reviewed_at: null,
  review_comment: null,
  created_at: '2026-11-01T00:00:00Z',
  updated_at: '2026-11-01T00:00:00Z',
  ...extra,
});

const OCT = { startDate: '2026-10-01', endDate: '2026-10-31' };

describe('сводка месяца по половинам', () => {
  it('подач нет — подавать можно (сводки нет)', () => {
    expect(summarizeMonthHalves({ ...OCT, approvals: [] })).toEqual({ hasApprovals: false, status: 'draft', waitingWeekends: false });
  });

  it('один черновик — подачи есть, месяц черновик', () => {
    const summary = summarizeMonthHalves({ ...OCT, approvals: [approval(1, 'draft', '2026-10-01', '2026-10-15')] });
    expect(summary).toEqual({ hasApprovals: true, status: 'draft', waitingWeekends: false });
  });

  it('утверждена только 1–15 — месяц ещё черновик', () => {
    expect(summarizeMonthHalves({ ...OCT, approvals: [approval(1, 'approved', '2026-10-01', '2026-10-15')] }).status).toBe('draft');
  });

  it('обе утверждены — утверждён; утверждён + на проверке — на проверке', () => {
    const both = [approval(1, 'approved', '2026-10-01', '2026-10-15'), approval(2, 'approved', '2026-10-16', '2026-10-31')];
    expect(summarizeMonthHalves({ ...OCT, approvals: both }).status).toBe('approved');
    const mixed = [approval(1, 'approved', '2026-10-01', '2026-10-15'), approval(2, 'submitted', '2026-10-16', '2026-10-31')];
    expect(summarizeMonthHalves({ ...OCT, approvals: mixed }).status).toBe('submitted');
  });

  it('отклонён + на доработке — детерминированно «Отклонён»', () => {
    const approvals = [approval(1, 'returned', '2026-10-01', '2026-10-15'), approval(2, 'rejected', '2026-10-16', '2026-10-31')];
    expect(summarizeMonthHalves({ ...OCT, approvals }).status).toBe('rejected');
    expect(summarizeMonthHalves({ ...OCT, approvals: [...approvals].reverse() }).status).toBe('rejected');
  });

  it('поданная половина ждёт выходных', () => {
    const approvals = [
      approval(1, 'approved', '2026-10-01', '2026-10-15'),
      approval(2, 'submitted', '2026-10-16', '2026-10-31', { pending_decisions_count: 2 }),
    ];
    expect(summarizeMonthHalves({ ...OCT, approvals }).waitingWeekends).toBe(true);
  });

  it('активная подача половины важнее старого черновика той же половины', () => {
    const approvals = [
      approval(5, 'draft', '2026-10-01', '2026-10-15'),
      approval(3, 'approved', '2026-10-01', '2026-10-15'),
      approval(4, 'approved', '2026-10-16', '2026-10-31'),
    ];
    expect(summarizeMonthHalves({ ...OCT, approvals }).status).toBe('approved');
  });

  it('подача вне месяца отбрасывается; подача на обе половины считается за обе', () => {
    expect(summarizeMonthHalves({ ...OCT, approvals: [approval(1, 'approved', '2026-09-16', '2026-09-30')] }))
      .toEqual({ hasApprovals: false, status: 'draft', waitingWeekends: false });
    expect(summarizeMonthHalves({ ...OCT, approvals: [approval(2, 'submitted', '2026-10-01', '2026-10-31')] }).status)
      .toBe('submitted');
  });

  it('февраль 28/29 и 30-дневный месяц', () => {
    const feb = [approval(1, 'approved', '2028-02-01', '2028-02-15'), approval(2, 'approved', '2028-02-16', '2028-02-29')];
    expect(summarizeMonthHalves({ startDate: '2028-02-01', endDate: '2028-02-29', approvals: feb }).status).toBe('approved');
    const nov = [approval(1, 'approved', '2026-11-01', '2026-11-15')];
    expect(summarizeMonthHalves({ startDate: '2026-11-01', endDate: '2026-11-30', approvals: nov }).status).toBe('draft');
  });
});
