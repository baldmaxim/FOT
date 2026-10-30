import { beforeEach, describe, expect, it, vi } from 'vitest';

const pg = vi.hoisted(() => ({
  pool: vi.fn(() => ({})),
  query: vi.fn(),
  withTransaction: vi.fn(),
}));
vi.mock('../../config/postgres.js', () => pg);

import type { IPayrollBasisDraft } from './payroll-basis.service.js';
import { absenceCountsMatch, backfillPayrollBasisAbsenceDates } from './payroll-basis-absence-dates.service.js';

const row = (over: Record<string, unknown> = {}) => ({
  version_id: '10', employee_id: 904, full_name: 'Крумина Наташа Николаевна', month: '2026-09-01', revision: 1,
  norm_days: 24, norm_minutes: 10560, workday_dates: ['2026-09-01'], dayoff_dates: [],
  absence_days: { vacation: 2 }, overtime_minutes: {}, ...over,
});

const draft = (over: Partial<IPayrollBasisDraft> = {}): IPayrollBasisDraft => ({
  employeeId: 904, month: '2026-09-01', normDays: 24, normMinutes: 10560, workdayDates: ['2026-09-01'], dayoffDates: [],
  absenceDays: { vacation: 2, sick: 0, educational_leave: 0, unpaid: 0 },
  absenceDates: { vacation: ['2026-09-02', '2026-09-03'], sick: [], educational_leave: [], unpaid: [] },
  overtimeMinutes: {},
  ...over,
});

const insertClient = { query: vi.fn(async () => ({ rowCount: 1 })) };

beforeEach(() => {
  vi.clearAllMocks();
  pg.withTransaction.mockImplementation(async (fn: (client: unknown) => unknown) => fn(insertClient));
});

describe('даты отсутствий в основе — дозаполнение', () => {
  it('число дат по статусам = счётчики основы', () => {
    const dates = { vacation: ['2026-09-02', '2026-09-03'], sick: [], educational_leave: [], unpaid: [] };
    expect(absenceCountsMatch({ vacation: 2 }, dates)).toBe(true);
    expect(absenceCountsMatch({ vacation: 2, sick: 0 }, dates)).toBe(true);
    expect(absenceCountsMatch({ vacation: 3 }, dates)).toBe(false);
    expect(absenceCountsMatch({ vacation: 2, sick: 1 }, dates)).toBe(false);
  });

  it('сухой прогон: совпало — будет записано, не совпало или нет основы — пропуск с отчётом; ничего не пишется', async () => {
    pg.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM timesheet_versions')) return [{ payload: { approval: {}, employees: [] } }];
      return [row(), row({ employee_id: 477, full_name: 'Гринёв', absence_days: { vacation: 9 } }), row({ employee_id: 5 })];
    });
    const rebuild = vi.fn(async () => [draft(), draft({ employeeId: 477 })]);

    const result = await backfillPayrollBasisAbsenceDates({ apply: false, fromMonth: '2026-09', rebuild });

    expect(pg.query.mock.calls[0][1]).toEqual(['2026-09-01']);
    expect(result).toMatchObject({ candidates: 3, matched: 1, written: 0, failedVersions: [] });
    expect(result.skipped).toEqual([
      expect.objectContaining({ employeeId: 477, stored: { vacation: 9 }, rebuilt: expect.objectContaining({ vacation: 2 }) }),
      expect.objectContaining({ employeeId: 5, rebuilt: null }),
    ]);
    expect(pg.withTransaction).not.toHaveBeenCalled();
  });

  it('запись: копия последней revision с датами, только если дат ещё нет; ошибка редакции — в отчёт', async () => {
    pg.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM timesheet_versions')) {
        if (params?.[0] === 11) throw new Error('payload сломан');
        return [{ payload: { approval: {}, employees: [] } }];
      }
      return [row(), row({ version_id: '11' })];
    });

    const result = await backfillPayrollBasisAbsenceDates({ apply: true, fromMonth: '2026-09', rebuild: vi.fn(async () => [draft()]) });

    expect(result).toMatchObject({ candidates: 2, matched: 1, written: 1, failedVersions: [11] });
    const [sql, params] = insertClient.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/b\.revision \+ 1/);
    expect(sql).toMatch(/AND b\.absence_dates IS NULL/);
    expect(params.slice(0, 4)).toEqual([10, 904, '2026-09-01', 1]);
    expect(JSON.parse(params[5] as string)).toEqual(draft().absenceDates);
  });
});
