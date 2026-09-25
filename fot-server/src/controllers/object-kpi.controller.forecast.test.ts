/**
 * Прогноз в /report: только в авто-окне по одному объекту (тогда окно кончается текущим
 * месяцем), при явном периоде его нет, а сводка «План / Факт / Выполнение» прогноз не видит.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  resolveScope: vi.fn(),
  fetchReport: vi.fn(),
  fetchForecast: vi.fn(),
  resolveCalcWindow: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: vi.fn(async () => []),
  queryOne: vi.fn(async () => null),
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
  isEconomicsHead: vi.fn(async () => false),
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

import { objectKpiController } from './object-kpi.controller.js';

const OBJECT = '11111111-1111-1111-1111-111111111111';

const makeRes = () => {
  const out: { status?: number; body?: Record<string, unknown> } = {};
  const res = {
    status(code: number) { out.status = code; return res; },
    json(body: Record<string, unknown>) { out.body = body; out.status = out.status ?? 200; return res; },
  };
  return { res: res as never, out };
};

const req = (query: Record<string, string>) => ({
  params: {},
  query,
  user: { id: 'u-1', employee_id: 399, is_admin: true, role_code: 'admin' },
}) as never;

const ACTUAL = [
  { period_month: '2026-08-01', plan_amount: '100.00', fact_amount: '90.00' },
  { period_month: '2026-09-01', plan_amount: '100.00', fact_amount: '0.00' },
];
const FORECAST = [
  { period_month: '2026-10-01', plan_amount: '110.00', fact_amount: '110.00', is_forecast: true },
];

beforeEach(() => {
  vi.clearAllMocks();
  h.resolveScope.mockResolvedValue({ is_unrestricted: true, object_ids: [OBJECT] });
  h.resolveCalcWindow.mockResolvedValue({ from: '2026-08', to: '2026-09' });
  h.fetchReport.mockResolvedValue(ACTUAL);
  h.fetchForecast.mockResolvedValue(FORECAST);
});

describe('getReport: прогноз', () => {
  it('авто-окно по объекту — прогноз от текущего месяца окна', async () => {
    const { res, out } = makeRes();
    await objectKpiController.getReport(req({ object_id: OBJECT }), res);

    expect(out.status).toBe(200);
    expect(h.fetchForecast).toHaveBeenCalledWith(OBJECT, '2026-09');
    expect(out.body?.forecast).toEqual(FORECAST);
    expect(out.body?.data).toEqual(ACTUAL);
  });

  it('явный период — прогноза нет', async () => {
    const { res, out } = makeRes();
    await objectKpiController.getReport(req({ object_id: OBJECT, from: '2026-08', to: '2026-09' }), res);

    expect(out.status).toBe(200);
    expect(h.fetchForecast).not.toHaveBeenCalled();
    expect(out.body?.forecast).toEqual([]);
  });

  it('сводка считается только по фактическим строкам', async () => {
    const { res, out } = makeRes();
    await objectKpiController.getReport(req({ object_id: OBJECT }), res);

    // 90 / 200, а не (90 + 110) / (200 + 110): прогноз в «План / Факт / Выполнение» не входит.
    expect(out.body?.summary).toEqual({
      total_plan: 200,
      total_fact: 90,
      total_fact_unplanned: 0,
      completion_pct: 45,
    });
  });
});
