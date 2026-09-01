/**
 * Чтение KPI-контура под ограниченным скоупом (миграция 262): карточка чужого объекта → 403,
 * закрепления в карточке — только тем, кто ими управляет, список закреплений/поиск → 403,
 * ЛК руководителя — только свои закрепления и своя премия (регрессия).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  resolveScope: vi.fn(),
  loadAssigned: vi.fn(),
  canManage: vi.fn(),
  isEconomicsHead: vi.fn(),
  listAssignments: vi.fn(),
  fetchReport: vi.fn(),
  fetchManagerPremium: vi.fn(),
  resolveCalcWindow: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: h.query,
  queryOne: h.queryOne,
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));
vi.mock('../services/object-kpi-report.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/object-kpi-report.service.js')>();
  return { ...actual, fetchObjectKpiReport: h.fetchReport, resolveCalcWindow: h.resolveCalcWindow };
});
vi.mock('../services/object-kpi-premium.service.js', () => ({
  fetchManagerPremium: h.fetchManagerPremium,
  EMPTY_PREMIUM_TOTALS: { total_plan: '0', total_fact: '0', completion_pct: null, total_premium: '0' },
}));
vi.mock('../services/object-kpi-scope.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/object-kpi-scope.service.js')>();
  return {
    ...actual,
    resolveObjectKpiScope: h.resolveScope,
    loadAssignedObjectIds: h.loadAssigned,
    canManageObjectKpiAssignments: h.canManage,
    assertCanManageAssignmentsOr403: async (req: unknown) => {
      if (!(await h.canManage(req))) {
        throw Object.assign(new Error(actual.ASSIGNMENTS_MANAGE_DENIED_MESSAGE), {
          __save: { http: 403, code: 'assignments_forbidden', message: actual.ASSIGNMENTS_MANAGE_DENIED_MESSAGE },
        });
      }
    },
  };
});
vi.mock('../services/object-kpi-roles-cache.service.js', () => ({
  isEconomicsHead: h.isEconomicsHead,
  isEconomicsHeadLive: vi.fn(),
  invalidateObjectKpiRolesCache: vi.fn(),
}));
vi.mock('../services/object-kpi-assignments.service.js', () => ({
  listAssignments: h.listAssignments,
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

const OWN = '11111111-1111-1111-1111-111111111111';
const FOREIGN = '22222222-2222-2222-2222-222222222222';

const makeRes = () => {
  const out: { status?: number; body?: Record<string, unknown> } = {};
  const res = {
    status(code: number) { out.status = code; return res; },
    json(body: Record<string, unknown>) { out.body = body; out.status = out.status ?? 200; return res; },
  };
  return { res: res as never, out };
};

const economistReq = (over: Record<string, unknown> = {}) => ({
  params: {},
  query: {},
  user: { id: 'u-1', employee_id: 399, is_admin: false, role_code: 'economist' },
  ...over,
}) as never;

beforeEach(() => {
  vi.clearAllMocks();
  h.resolveScope.mockResolvedValue({ is_unrestricted: false, object_ids: [OWN] });
  h.canManage.mockResolvedValue(false);
  h.isEconomicsHead.mockResolvedValue(false);
  h.fetchReport.mockResolvedValue([]);
  h.resolveCalcWindow.mockResolvedValue({ from: '2026-08', to: '2026-08' });
  h.listAssignments.mockResolvedValue([{ id: 'a-1', skud_object_id: OWN }]);
  h.queryOne.mockResolvedValue({ exists: false });
  h.query.mockResolvedValue([]);
});

describe('getObjectCard', () => {
  it('свой объект → 200, закрепления в карточке экономисту не отдаются и не запрашиваются', async () => {
    const { res, out } = makeRes();
    await objectKpiController.getObjectCard(economistReq({ params: { objectId: OWN } }), res);

    expect(out.status).toBe(200);
    expect(h.listAssignments).not.toHaveBeenCalled();
    expect((out.body?.data as { assignments: unknown[] }).assignments).toEqual([]);
  });

  it('чужой объект по прямой ссылке → 403, данные не собираются', async () => {
    const { res, out } = makeRes();
    await objectKpiController.getObjectCard(economistReq({ params: { objectId: FOREIGN } }), res);

    expect(out.status).toBe(403);
    expect(h.fetchReport).not.toHaveBeenCalled();
  });

  it('админ / руководитель эк. отдела получают закрепления в карточке', async () => {
    h.canManage.mockResolvedValue(true);
    const { res, out } = makeRes();
    await objectKpiController.getObjectCard(economistReq({ params: { objectId: OWN } }), res);

    expect(out.status).toBe(200);
    expect(h.listAssignments).toHaveBeenCalledWith({ objectId: OWN });
    expect((out.body?.data as { assignments: unknown[] }).assignments).toHaveLength(1);
  });
});

describe('getReport / listObjects под ограниченным скоупом', () => {
  it('отчёт по чужому объекту → 403; по своему → 200', async () => {
    let r = makeRes();
    await objectKpiController.getReport(economistReq({ query: { object_id: FOREIGN } }), r.res);
    expect(r.out.status).toBe(403);
    expect(h.fetchReport).not.toHaveBeenCalled();

    r = makeRes();
    await objectKpiController.getReport(economistReq({ query: { object_id: OWN } }), r.res);
    expect(r.out.status).toBe(200);
    expect(h.fetchReport).toHaveBeenCalledWith(expect.objectContaining({ objectIds: [OWN] }));
  });

  it('listObjects: список — только скоуп, can_manage_assignments=false для экономиста', async () => {
    h.query.mockResolvedValue([{ id: OWN, name: 'ЖК Ситибэй' }]);
    const { res, out } = makeRes();
    await objectKpiController.listObjects(economistReq(), res);

    expect(out.status).toBe(200);
    expect(h.query.mock.calls[0][1]).toEqual([[OWN]]);
    expect(out.body?.scope).toEqual({ is_unrestricted: false, can_revise_plan: false, can_manage_assignments: false });
  });
});

describe('закрепления — список и поиск', () => {
  it('listAssignments / searchEmployees: экономист → 403, данные не читаются', async () => {
    let r = makeRes();
    await objectKpiController.listAssignments(economistReq(), r.res);
    expect(r.out.status).toBe(403);
    expect(h.listAssignments).not.toHaveBeenCalled();

    r = makeRes();
    await objectKpiController.searchEmployees(economistReq({ query: { q: 'Ви' } }), r.res);
    expect(r.out.status).toBe(403);
    expect(h.query).not.toHaveBeenCalled();
  });

  it('руководитель эк. отдела: список закреплений отдаётся', async () => {
    h.canManage.mockResolvedValue(true);
    h.resolveScope.mockResolvedValue({ is_unrestricted: true, object_ids: [OWN, FOREIGN] });
    const { res, out } = makeRes();
    await objectKpiController.listAssignments(economistReq(), res);

    expect(out.status).toBe(200);
    expect(h.listAssignments).toHaveBeenCalledTimes(1);
  });
});

describe('ЛК руководителя /my/objects — регрессия', () => {
  it('свой employee_id, закрепления construction_manager, премия только своя', async () => {
    h.loadAssigned.mockResolvedValue([OWN]);
    h.fetchManagerPremium.mockResolvedValue({
      rows: [], premium: [{ period_month: '2026-08-01', status: 'calculated', premium_amount: '1' }],
      period_totals: { total_plan: '0', total_fact: '0', completion_pct: null, total_premium: '1' },
      scales: [],
    });
    const { res, out } = makeRes();
    await objectKpiController.getMyObjects(
      { params: {}, query: { from: '2026-08', to: '2026-08' }, user: { id: 'u-7', employee_id: 7, is_admin: false, role_code: 'manager_obj' } } as never,
      res,
    );

    expect(out.status).toBe(200);
    // Скоуп «вся стройка» здесь не участвует — только личные закрепления руководителя.
    expect(h.resolveScope).not.toHaveBeenCalled();
    expect(h.loadAssigned).toHaveBeenCalledWith(7, '2026-08-01', { from: '2026-08-01', to: '2026-08-01' });
    expect(h.fetchManagerPremium).toHaveBeenCalledWith(expect.objectContaining({ employeeId: 7, objectIds: [OWN] }));
    expect((out.body?.premium as unknown[])).toHaveLength(1);
  });
});
