/**
 * Агрегатор премии для сводного отчёта.
 *
 * Проверяется не арифметика приказа (она в object-kpi-premium.*.test.ts), а сборка:
 * премия принадлежит человеку, а не объекту, поэтому набор объектов для расчёта берётся
 * из закреплений руководителя, а не из фильтра отчёта.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/postgres.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('../services/object-kpi-report.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/object-kpi-report.service.js')>();
  return { ...actual, fetchObjectKpiReport: vi.fn() };
});

vi.mock('../services/object-kpi-premium.service.js', () => ({
  fetchManagerPremium: vi.fn(),
  EMPTY_PREMIUM_TOTALS: { total_plan: '0', total_fact: '0', completion_pct: null, total_premium: '0' },
}));

vi.mock('../services/object-kpi-scope.service.js', () => ({
  loadAssignedObjectIds: vi.fn(),
  resolveObjectKpiScope: vi.fn(),
}));

import { objectKpiController } from './object-kpi.controller.js';
import { fetchObjectKpiReport } from '../services/object-kpi-report.service.js';
import { fetchManagerPremium } from '../services/object-kpi-premium.service.js';
import { loadAssignedObjectIds, resolveObjectKpiScope } from '../services/object-kpi-scope.service.js';

const OBJECT_A = '11111111-1111-1111-1111-111111111111';
const OBJECT_B = '22222222-2222-2222-2222-222222222222';

const asMock = (fn: unknown) => fn as unknown as {
  mockResolvedValue: (v: unknown) => void;
  mockImplementation: (fn: (...args: never[]) => unknown) => void;
  mock: { calls: unknown[][] };
};

const reportRow = (managerIds: number[], periodMonth: string) => ({
  skud_object_id: OBJECT_A,
  period_month: periodMonth,
  managers: managerIds.map((id) => ({ employee_id: id, full_name: `Ф ${id}`, days: 30 })),
  primary_manager_id: managerIds[0] ?? null,
});

const premiumMonth = (periodMonth: string, status: string, amount: string | null) => ({
  period_month: periodMonth,
  status,
  total_plan: '100.00',
  total_fact: '100.00',
  completion_pct: '100.00',
  coefficient: '1.00',
  premium_amount: amount,
});

const makeRes = () => {
  const payload: { status?: number; body?: Record<string, unknown> } = {};
  return {
    res: {
      status(code: number) { payload.status = code; return this; },
      json(body: Record<string, unknown>) { payload.body = body; return this; },
    },
    payload,
  };
};

const request = (query: Record<string, unknown> = {}) =>
  ({ query, user: { id: 'user-1', employee_id: 500 } }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  asMock(resolveObjectKpiScope).mockResolvedValue({ is_unrestricted: true, object_ids: [OBJECT_A, OBJECT_B] });
});

describe('getReportPremium', () => {
  it('руководители дедуплицируются: один расчёт на человека, а не на строку', async () => {
    asMock(fetchObjectKpiReport).mockResolvedValue([
      reportRow([7], '2026-07-01'),
      reportRow([7], '2026-08-01'),
    ]);
    asMock(loadAssignedObjectIds).mockResolvedValue([OBJECT_A, OBJECT_B]);
    asMock(fetchManagerPremium).mockResolvedValue({
      premium: [premiumMonth('2026-07-01', 'calculated', '200000'), premiumMonth('2026-08-01', 'calculated', '250000')],
    });

    const { res, payload } = makeRes();
    await objectKpiController.getReportPremium(request({ from: '2026-07', to: '2026-08' }), res as never);

    expect(asMock(fetchManagerPremium).mock.calls).toHaveLength(1);
    expect((payload.body?.data as unknown[])).toHaveLength(2);
  });

  it('премия считается по всем объектам руководителя, даже если отчёт сужен до одного', async () => {
    asMock(fetchObjectKpiReport).mockResolvedValue([reportRow([7], '2026-08-01')]);
    // У руководителя два объекта, отчёт показывает один.
    asMock(loadAssignedObjectIds).mockResolvedValue([OBJECT_A, OBJECT_B]);
    asMock(fetchManagerPremium).mockResolvedValue({
      premium: [premiumMonth('2026-08-01', 'calculated', '300000')],
    });

    const { res } = makeRes();
    await objectKpiController.getReportPremium(
      request({ from: '2026-08', to: '2026-08', object_id: OBJECT_A }),
      res as never,
    );

    const call = asMock(fetchManagerPremium).mock.calls[0][0] as { objectIds: string[] };
    expect(call.objectIds).toEqual([OBJECT_A, OBJECT_B]);
  });

  it('месяц без руководителя не даёт строк и не зовёт расчёт', async () => {
    asMock(fetchObjectKpiReport).mockResolvedValue([reportRow([], '2026-08-01')]);

    const { res, payload } = makeRes();
    await objectKpiController.getReportPremium(request({ from: '2026-08', to: '2026-08' }), res as never);

    expect(fetchManagerPremium).not.toHaveBeenCalled();
    expect(payload.body?.data).toEqual([]);
  });

  it('статусы «не рассчитано» доходят до клиента, а не превращаются в пустоту', async () => {
    asMock(fetchObjectKpiReport).mockResolvedValue([reportRow([7], '2026-08-01')]);
    asMock(loadAssignedObjectIds).mockResolvedValue([OBJECT_A]);
    asMock(fetchManagerPremium).mockResolvedValue({
      premium: [premiumMonth('2026-08-01', 'no_plan', null)],
    });

    const { res, payload } = makeRes();
    await objectKpiController.getReportPremium(request({ from: '2026-08', to: '2026-08' }), res as never);

    expect(payload.body?.data).toEqual([
      expect.objectContaining({ employee_id: 7, status: 'no_plan', premium_amount: null }),
    ]);
  });

  it('руководитель без закреплений в окне пропускается', async () => {
    asMock(fetchObjectKpiReport).mockResolvedValue([reportRow([7], '2026-08-01')]);
    asMock(loadAssignedObjectIds).mockResolvedValue([]);

    const { res, payload } = makeRes();
    await objectKpiController.getReportPremium(request({ from: '2026-08', to: '2026-08' }), res as never);

    expect(fetchManagerPremium).not.toHaveBeenCalled();
    expect(payload.body?.data).toEqual([]);
  });
});
