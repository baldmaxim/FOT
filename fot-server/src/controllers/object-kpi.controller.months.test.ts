/**
 * Выбор месяцев на вкладке «KPI объектов»: /report/summary и /report принимают набор
 * months=YYYY-MM,… (один, подряд или вразброс). Окно отчёта — от первого до последнего
 * месяца, лишние месяцы отбрасываются; сводка по объектам считается из тех же строк.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  resolveScope: vi.fn(),
  fetchReport: vi.fn(),
  fetchForecast: vi.fn(),
  resolveCalcWindow: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));
vi.mock('../services/object-kpi-report.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/object-kpi-report.service.js')>();
  return { ...actual, fetchObjectKpiReport: h.fetchReport, resolveCalcWindow: h.resolveCalcWindow };
});
vi.mock('../services/object-kpi-forecast.service.js', () => ({ fetchObjectKpiForecast: h.fetchForecast }));
vi.mock('../services/object-kpi-premium.service.js', () => ({
  fetchManagerPremium: vi.fn(),
  EMPTY_PREMIUM_TOTALS: { total_plan: '0', total_fact: '0', completion_pct: null, total_premium: '0' },
}));
vi.mock('../services/object-kpi-scope.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/object-kpi-scope.service.js')>();
  return { ...actual, resolveObjectKpiScope: h.resolveScope };
});
vi.mock('../services/object-kpi-roles-cache.service.js', () => ({
  isEconomicsHead: vi.fn(),
  isEconomicsHeadLive: vi.fn(),
  invalidateObjectKpiRolesCache: vi.fn(),
}));
vi.mock('../services/object-kpi-assignments.service.js', () => ({
  listAssignments: vi.fn(async () => []),
  listGlobalRoles: vi.fn(async () => []),
}));
vi.mock('../services/object-kpi-plan.service.js', () => ({
  listMonthPlans: vi.fn(async () => []),
  normalizeMonth: (m: string) => m,
}));
vi.mock('../services/object-kpi-plan-freezer.service.js', () => ({
  getFreezerConfig: vi.fn(),
  resolveFixationDate: vi.fn(),
}));
vi.mock('../services/object-kpi-headcount.service.js', () => ({ fetchObjectKpiHeadcount: vi.fn() }));
vi.mock('../services/object-kpi-history.service.js', () => ({ listObjectKpiHistory: vi.fn(async () => []) }));
vi.mock('../services/object-kpi.service.js', () => ({
  getContractByObject: vi.fn(async () => null),
  listAddenda: vi.fn(async () => []),
  listKs2Entries: vi.fn(async () => []),
}));
vi.mock('../services/object-kpi-ks6.service.js', () => ({ listKs6Entries: vi.fn(async () => []) }));

import { monthsParamSchema, objectKpiController } from './object-kpi.controller.js';

const OBJECT_A = '11111111-1111-1111-1111-111111111111';

const makeRes = () => {
  const out: { status?: number; body?: Record<string, unknown> } = {};
  const res = {
    status(code: number) { out.status = code; return res; },
    json(body: Record<string, unknown>) { out.body = body; out.status = out.status ?? 200; return res; },
  };
  return { res: res as never, out };
};

const req = (query: Record<string, unknown>) => ({
  params: {},
  query,
  user: { id: 'u-1', employee_id: 1, is_admin: true },
}) as never;

const monthRow = (periodMonth: string, plan: string, fact: string) => ({
  skud_object_id: OBJECT_A,
  object_name: 'ЖК А',
  contract_id: 'c-a',
  period_month: periodMonth,
  contract_total: '1000.00',
  ks2_cumulative_before: '0.00',
  remainder: '1000.00',
  plan_amount: plan,
  fact_amount: fact,
  primary_manager_name: 'Иванов И. И.',
  managers: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  h.resolveScope.mockResolvedValue({ is_unrestricted: true, object_ids: [OBJECT_A] });
  h.resolveCalcWindow.mockResolvedValue({ from: '2026-01', to: '2026-09' });
  h.fetchForecast.mockResolvedValue([]);
  h.fetchReport.mockResolvedValue([
    monthRow('2026-07-01', '100.00', '50.00'),
    monthRow('2026-08-01', '100.00', '100.00'),
    monthRow('2026-09-01', '100.00', '80.00'),
  ]);
});

describe('monthsParamSchema', () => {
  it('убирает повторы и упорядочивает месяцы', () => {
    expect(monthsParamSchema.parse('2026-09,2026-07,2026-09')).toEqual(['2026-07', '2026-09']);
  });

  it('отвергает мусор, 13-й месяц и пустые элементы', () => {
    for (const value of ['abc', '2026-13', '2026-07,', '2026-7', '']) {
      expect(() => monthsParamSchema.parse(value)).toThrow();
    }
  });

  it('отвергает набор шире 10 лет', () => {
    expect(() => monthsParamSchema.parse('2016-01,2026-09')).toThrow(/месяцев/);
  });
});

describe('getReportSummary с набором месяцев', () => {
  it('окно — от первого до последнего месяца; сводка и объекты — только по выбранным', async () => {
    const { res, out } = makeRes();
    await objectKpiController.getReportSummary(req({ months: '2026-09,2026-07' }), res);

    expect(out.status).toBe(200);
    expect(h.fetchReport).toHaveBeenCalledWith({
      monthFrom: '2026-07-01',
      monthTo: '2026-09-01',
      objectIds: [OBJECT_A],
    });
    // Скоуп резолвится на то же окно, что и отчёт.
    expect(h.resolveScope).toHaveBeenCalledWith(expect.anything(), {
      periodRange: { from: '2026-07-01', to: '2026-09-01' },
    });
    // Август (100 / 100) в выбор не входит: план 200, факт 130.
    expect(out.body?.summary).toMatchObject({ total_plan: 200, total_fact: 130, completion_pct: 65 });
    expect(out.body?.objects).toEqual([
      expect.objectContaining({ skud_object_id: OBJECT_A, plan_amount: 200, fact_amount: 130, completion_pct: 65 }),
    ]);
    expect(out.body?.period).toEqual({ from: '2026-07', to: '2026-09' });
  });

  it('без месяцев — весь расчёт, как раньше, плюс сводка по объектам', async () => {
    const { res, out } = makeRes();
    await objectKpiController.getReportSummary(req({}), res);

    expect(out.status).toBe(200);
    expect(out.body?.summary).toMatchObject({ total_plan: 300, total_fact: 230 });
    expect(out.body?.objects).toHaveLength(1);
    expect(out.body?.period).toEqual({ from: '2026-01', to: '2026-09' });
  });

  it('месяцы вместе с from/to → 400, отчёт не строится', async () => {
    const { res, out } = makeRes();
    await objectKpiController.getReportSummary(
      req({ months: '2026-08', from: '2026-01', to: '2026-02' }),
      res,
    );

    expect(out.status).toBe(400);
    expect(h.fetchReport).not.toHaveBeenCalled();
  });

  it('кривой набор месяцев → 400', async () => {
    const { res, out } = makeRes();
    await objectKpiController.getReportSummary(req({ months: '2026-13' }), res);

    expect(out.status).toBe(400);
    expect(h.fetchReport).not.toHaveBeenCalled();
  });
});

describe('getReport с набором месяцев', () => {
  it('строки только выбранных месяцев, прогноза нет (окно не авто)', async () => {
    const { res, out } = makeRes();
    await objectKpiController.getReport(req({ months: '2026-08', object_id: OBJECT_A }), res);

    expect(out.status).toBe(200);
    expect((out.body?.data as Array<{ period_month: string }>).map((row) => row.period_month))
      .toEqual(['2026-08-01']);
    expect(h.fetchForecast).not.toHaveBeenCalled();
  });
});
