import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthenticatedRequest } from '../../types/index.js';

const pg = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../config/postgres.js', () => ({ query: pg.query }));

const summaryCalc = vi.hoisted(() => ({
  loadSummaryRoster: vi.fn(),
  loadSummaryExtras: vi.fn(),
  calcSummaryMonths: vi.fn(),
}));
vi.mock('./payroll-summary-calc.service.js', () => summaryCalc);
// sumCalcColumns — настоящий; его модуль тянет расчёт и условия, они здесь не нужны.
vi.mock('./payroll-calc.service.js', () => ({ getPayoutForEmployees: vi.fn(), getPreliminaryPayoutForEmployees: vi.fn() }));
vi.mock('./payroll-terms.service.js', () => ({ getTermsForPeriod: vi.fn() }));

import { getTermsPayouts, termsPayoutMonths, termsPayoutsServerTiming } from './payroll-terms-payouts.service.js';

const req = { user: { id: 'user-1' } } as unknown as AuthenticatedRequest;

const closed = (net: string | null, lines: Array<{ code: string; amount: string | null }>, missing: string[] = []) => ({
  state: 'closed', net, lines, missing, deductions: [], rate_allowances: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  summaryCalc.loadSummaryRoster.mockResolvedValue(new Map());
  summaryCalc.loadSummaryExtras.mockResolvedValue({ oneTime: new Map(), deductions: new Map() });
  summaryCalc.calcSummaryMonths.mockResolvedValue({ calcs: new Map(), employees: 0 });
  pg.query.mockResolvedValue([]);
});

describe('termsPayoutMonths', () => {
  it('6 месяцев перед месяцем даты, через границу года', () => {
    expect(termsPayoutMonths('2026-11-09')).toEqual(['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
    expect(termsPayoutMonths('2026-02-01')).toEqual(['2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01']);
  });
});

describe('getTermsPayouts', () => {
  it('расчёт — только работавшим без «Зарплаты» 1С; загруженные месяцы — по всем; реестр и разовые — по id порции', async () => {
    pg.query.mockImplementation(async (sql: string) => {
      if (sql.includes('DISTINCT')) return [{ month: '2026-09' }];
      return [
        { employee_id: 28, month: '2026-09', item: 'contract', amount: '106363.68' },
        { employee_id: 28, month: '2026-09', item: 'vacation', amount: '99140.26' },
      ];
    });
    summaryCalc.loadSummaryRoster.mockResolvedValue(new Map([['2026-09', [28, 52]], ['2026-10', [28, 52]]]));
    summaryCalc.loadSummaryExtras.mockResolvedValue({
      oneTime: new Map([['52|2026-10', [{ reason: 'Премия', amount: '1000.00' }]]]),
      deductions: new Map(),
    });
    summaryCalc.calcSummaryMonths.mockResolvedValue({
      calcs: new Map([
        ['52|2026-09', closed('211213.00', [{ code: 'contract', amount: '211213.00' }])],
        ['28|2026-10', closed('206594.00', [{ code: 'contract', amount: '206594.00' }])],
        ['52|2026-10', closed('205260.00', [{ code: 'contract', amount: '204260.00' }, { code: 'supplement', amount: '1000.00' }])],
      ]),
      employees: 3,
    });

    const result = await getTermsPayouts({ employeeIds: [28, 52, 28], date: '2026-11-09', contractorRootId: 'root', req });

    expect(summaryCalc.loadSummaryRoster).toHaveBeenCalledWith(result.months, 'root', [28, 52]);
    expect(summaryCalc.loadSummaryExtras).toHaveBeenCalledWith(result.months, [28, 52]);
    expect(pg.query.mock.calls[0][1]).toEqual([[28, 52], result.months.map(month => `${month}-01`)]);
    const [candidates, loaded] = summaryCalc.calcSummaryMonths.mock.calls[0];
    expect([...candidates]).toEqual([['2026-09', [52]], ['2026-10', [28, 52]]]);
    expect([...loaded]).toEqual(['2026-09']);
    expect(result.payouts).toEqual(new Map([
      [28, [{ month: '2026-09', amount: '205503.94' }, { month: '2026-10', amount: '206594.00' }]],
      [52, [{ month: '2026-09', amount: '211213.00' }, { month: '2026-10', amount: '205260.00' }]],
    ]));
  });

  it('итог ФОТ неизвестен (выработка не внесена) — «—»; известный ноль — 0.00', async () => {
    summaryCalc.loadSummaryRoster.mockResolvedValue(new Map([['2026-10', [15, 16]]]));
    summaryCalc.calcSummaryMonths.mockResolvedValue({
      calcs: new Map([
        ['15|2026-10', closed(null, [{ code: 'brigade', amount: null }], ['brigade_output'])],
        ['16|2026-10', closed('0.00', [], ['no_days'])],
      ]),
      employees: 2,
    });

    const result = await getTermsPayouts({ employeeIds: [15, 16], date: '2026-11-09', contractorRootId: null, req });

    expect(result.payouts.get(15)).toEqual([]);
    expect(result.payouts.get(16)).toEqual([{ month: '2026-10', amount: '0.00' }]);
  });

  it('пустая порция — без запросов; Server-Timing с числом расчётов', async () => {
    const result = await getTermsPayouts({ employeeIds: [], date: '2026-11-09', contractorRootId: null, req });
    expect(result.payouts.size).toBe(0);
    expect(pg.query).not.toHaveBeenCalled();
    expect(termsPayoutsServerTiming({ calcEmployees: 3, loadMs: 1, calcMs: 2, totalMs: 3 }))
      .toBe('payouts_load;dur=1.0, payouts_calc;dur=2.0;desc="3", payouts_total;dur=3.0');
  });
});
