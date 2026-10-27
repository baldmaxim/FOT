import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthenticatedRequest } from '../../types/index.js';

// «К выплате (ФОТ)» бригады: доля по КТУ из зафиксированного расчёта бригады, дни бригады не в окладе;
// карточка (getPayoutForEmployees) и вкладка табеля (previewBrigadePayouts) дают одно число.
const pg = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../config/postgres.js', () => ({
  query: pg.query,
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

const basis = vi.hoisted(() => ({ loadMonthBasisSources: vi.fn() }));
vi.mock('./payroll-month-basis.service.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./payroll-month-basis.service.js')>()),
  loadMonthBasisSources: basis.loadMonthBasisSources,
}));

const brigade = vi.hoisted(() => ({ getBrigadeShares: vi.fn() }));
vi.mock('./brigade-salary.service.js', () => brigade);

const terms = vi.hoisted(() => ({ getTermsForPeriod: vi.fn() }));
vi.mock('./payroll-terms.service.js', () => terms);

vi.mock('./payroll-rate-facts.service.js', () => ({ loadRateFacts: vi.fn(async () => new Map()) }));
vi.mock('./payroll-month-attribution.service.js', () => ({
  loadMonthBreakdown: vi.fn(async () => new Map()),
  attributeMonths: vi.fn(async () => new Map()),
  monthPairKey: (employeeId: number, month: string) => `${employeeId}|${month}`,
}));
vi.mock('./payroll-staff-category.js', () => ({
  resolveMonthStaffCategories: vi.fn(async (items: unknown[]) => items.map(() => 'worker')),
}));

import { getPayoutForEmployees, previewBrigadePayouts } from './payroll-calc.service.js';

const req = { user: { id: 'user-1' } } as unknown as AuthenticatedRequest;
const BRIGADE = 'brigade-1';
const septemberWeekdays = Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`)
  .filter(date => ![0, 6].includes(new Date(`${date}T12:00:00`).getDay()));

const source = (over: Record<string, unknown> = {}) => ({
  basisId: 1,
  versionId: 10,
  coverFrom: '2026-09-01',
  coverTo: '2026-09-30',
  normDays: 22,
  normMinutes: 10560,
  workdayDates: septemberWeekdays,
  dayoffDates: [],
  absenceDays: {},
  overtimeMinutes: { '2026-09-01': 180 },
  quality: 'materialized',
  departmentId: BRIGADE,
  isBrigade: true,
  ...over,
});

const shareRow = { employee_id: 7, ktu: '1.5', counted_minutes: 10560, amount: '141818.18', source: 'version' };

beforeEach(() => {
  vi.clearAllMocks();
  pg.query.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM employees')) {
      return [7, 8].map(id => ({
        id, hire_date: null, org_department_id: BRIGADE, employment_status: 'active',
        dismissal_date: null, excluded_from_timesheet_date: null,
      }));
    }
    if (sql.includes('FROM staff_deductions')) {
      return [{ employee_id: 7, kind_id: 1, kind: 'Питание', amount: '3500.00' }];
    }
    return [];
  });
  basis.loadMonthBasisSources.mockResolvedValue(new Map([[7, [source()]], [8, [source()]]]));
  terms.getTermsForPeriod.mockResolvedValue(new Map([[8, [{
    effective_from: '2026-01-01', effective_to: null, calc_type: 'salary', monthly_salary: '110000.00',
    bonus_amount: null, proration_rounding: 'ruble',
  }]]]));
});

describe('«К выплате (ФОТ)» бригады', () => {
  it('рабочий: доля − удержания; то же число во вкладке табеля', async () => {
    brigade.getBrigadeShares.mockResolvedValue({ state: 'fixed', distribution: 'ok', rows: [shareRow] });

    const calc = (await getPayoutForEmployees([7], '2026-09', req)).get(7);

    expect(calc).toMatchObject({ state: 'closed', net: '138318.18', missing: [] });
    expect(calc?.state === 'closed' && calc.lines).toEqual([
      { code: 'brigade', amount: '141818.18', brigade: { ktu: '1.5', hours: 176 } },
    ]);
    const tab = await previewBrigadePayouts(new Map([[7, {
      amount: shareRow.amount, ktu: shareRow.ktu, countedMinutes: shareRow.counted_minutes, distribution: 'ok',
    }]]), '2026-09');
    expect(tab.get(7)?.net).toBe('138318.18');
  });

  it('начальник участка в делёж не входит — его дни бригады идут в оклад, переработка в будни — часами', async () => {
    brigade.getBrigadeShares.mockResolvedValue({ state: 'fixed', distribution: 'ok', rows: [shareRow] });

    const calc = (await getPayoutForEmployees([8], '2026-09', req)).get(8);

    // 3 ч корректировки 1 сентября: 110 000 × 180 / 10 560 = 1 875,00. У рабочего бригады (первый тест) их нет — доля.
    expect(calc?.state === 'closed' && calc.lines.map(line => [line.code, line.amount])).toEqual([
      ['contract', '110000.00'],
      ['overtime', '1875.00'],
    ]);
  });

  it('расчёт бригады не зафиксирован — месяц не закрыт', async () => {
    brigade.getBrigadeShares.mockResolvedValue({ state: 'open', distribution: null, rows: [] });

    const calc = (await getPayoutForEmployees([7], '2026-09', req)).get(7);

    expect(calc).toEqual({ state: 'not_closed', reason: 'brigade_open' });
    expect(brigade.getBrigadeShares).toHaveBeenCalledWith(req, BRIGADE, '2026-09');
  });
});
