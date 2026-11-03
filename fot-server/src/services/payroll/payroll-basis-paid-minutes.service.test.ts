import { beforeEach, describe, expect, it, vi } from 'vitest';

const pg = vi.hoisted(() => ({
  pool: vi.fn(() => ({})),
  query: vi.fn(),
  withTransaction: vi.fn(),
}));
vi.mock('../../config/postgres.js', () => pg);

import { computeBasisHash, type IPayrollBasisDraft } from './payroll-basis.service.js';
import { backfillPayrollBasisPaidMinutes, paidMinutesForStoredDates } from './payroll-basis-paid-minutes.service.js';

const row = (over: Record<string, unknown> = {}) => ({
  version_id: '10', employee_id: 283, month: '2026-08-01', revision: 1, norm_days: 31, norm_minutes: 10080,
  workday_dates: ['2026-08-03', '2026-08-04'], dayoff_dates: [],
  absence_days: { vacation: 0, sick: 0, educational_leave: 0, unpaid: 0 }, absence_dates: null, overtime_minutes: {},
  ...over,
});

const draft = (over: Partial<IPayrollBasisDraft> = {}): IPayrollBasisDraft => ({
  employeeId: 283, month: '2026-08-01', normDays: 31, normMinutes: 10080, workdayDates: ['2026-08-03', '2026-08-04'],
  dayoffDates: [],
  absenceDays: { vacation: 0, sick: 0, educational_leave: 0, unpaid: 0 },
  absenceDates: { vacation: [], sick: [], educational_leave: [], unpaid: [] },
  overtimeMinutes: {},
  paidMinutes: { '2026-08-03': 600, '2026-08-04': 360, '2026-08-05': 600 },
  ...over,
});

const insertClient = { query: vi.fn(async () => ({ rowCount: 1 })) };

const mockRows = (rows: unknown[]): void => {
  pg.query.mockImplementation(async (sql: string) => (
    sql.includes('SELECT payload') ? [{ payload: { employees: [] } }] : rows
  ));
};

beforeEach(() => {
  vi.clearAllMocks();
  pg.withTransaction.mockImplementation(async (work: (client: typeof insertClient) => Promise<number>) => work(insertClient));
});

describe('минуты к оплате в сохранённой основе', () => {
  it('только даты основы; даты основы без минут считаются', () => {
    expect(paidMinutesForStoredDates({ '2026-08-03': 600, '2026-08-09': 360 }, ['2026-08-03', '2026-08-04'])).toEqual({
      minutes: { '2026-08-03': 600 },
      uncovered: 1,
    });
  });

  it('сухой прогон не пишет', async () => {
    mockRows([row()]);
    const result = await backfillPayrollBasisPaidMinutes({ apply: false, fromMonth: '2026-05', rebuild: async () => [draft()] });
    expect(result).toEqual({ candidates: 1, matched: 1, written: 0, uncovered: 0, failedVersions: [] });
    expect(pg.withTransaction).not.toHaveBeenCalled();
  });

  it('запись: новая revision только с датами основы, хэш с минутами', async () => {
    mockRows([row()]);
    const result = await backfillPayrollBasisPaidMinutes({ apply: true, fromMonth: '2026-05', rebuild: async () => [draft()] });
    expect(result.written).toBe(1);
    const [sql, params] = insertClient.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('b.revision + 1');
    expect(sql).toContain('AND b.paid_minutes IS NULL');
    const minutes = { '2026-08-03': 600, '2026-08-04': 360 };
    expect(params[5]).toBe(JSON.stringify(minutes));
    expect(params[4]).toBe(computeBasisHash({
      employeeId: 283, month: '2026-08-01', normDays: 31, normMinutes: 10080, workdayDates: ['2026-08-03', '2026-08-04'],
      dayoffDates: [], absenceDays: { vacation: 0, sick: 0, educational_leave: 0, unpaid: 0 }, absenceDates: null,
      overtimeMinutes: {}, paidMinutes: minutes,
    }));
  });

  it('график сменили и у даты основы минут нет — дата остаётся без минут, основа в счётчике', async () => {
    mockRows([row()]);
    const result = await backfillPayrollBasisPaidMinutes({
      apply: true,
      fromMonth: '2026-05',
      rebuild: async () => [draft({ paidMinutes: { '2026-08-03': 600 } })],
    });
    expect(result).toMatchObject({ matched: 1, uncovered: 1 });
    const [, params] = insertClient.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(params[5]).toBe(JSON.stringify({ '2026-08-03': 600 }));
  });

  it('сотрудника нет в пересборке — пропуск; ошибка редакции не роняет остальные', async () => {
    mockRows([row(), row({ version_id: '11' })]);
    const result = await backfillPayrollBasisPaidMinutes({
      apply: true,
      fromMonth: '2026-05',
      rebuild: vi.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('сбой')),
    });
    expect(result).toMatchObject({ candidates: 2, matched: 0, written: 0, failedVersions: [11] });
  });
});
