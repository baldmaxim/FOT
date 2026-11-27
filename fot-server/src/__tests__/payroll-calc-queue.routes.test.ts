import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Очередь расчётов «Зарплаты» (payroll-calc-slot.ts) через HTTP: настоящие контроллеры, настоящий serverTiming и
 * настоящая очередь; сами расчёты — заглушки. Проверяется: «Свод», столбцы ФОТ и «Выплачено» идут через очередь со
 * своим приоритетом; Server-Timing — ожидание, внутренние шаги и полный маршрут; «Свод» обгоняет ожидающую порцию;
 * запрос, брошенный клиентом в ожидании, не считается и не даёт ошибки.
 */

const h = vi.hoisted(() => ({
  order: [] as string[],
  getCalcColumns: vi.fn(),
  loadPayrollSummary: vi.fn(),
  getTermsPayouts: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  // Охват «Расчётов» (loadAllowedCalcEmployeeIds): все запрошенные id разрешены.
  query: vi.fn(async (_sql: string, params: unknown[] = []) => {
    const ids = params.find(Array.isArray) as number[] | undefined;
    return (ids ?? []).map(id => ({ id }));
  }),
  queryOne: vi.fn(async () => null),
  execute: vi.fn(async () => 0),
  withTransaction: vi.fn(),
  getPool: vi.fn(),
}));

vi.mock('../services/payroll/payroll-registry-scope.service.js', async importOriginal => ({
  ...await importOriginal<typeof import('../services/payroll/payroll-registry-scope.service.js')>(),
  resolvePayrollStaffScope: vi.fn(async () => ({ contractorRootId: null, departmentIds: null })),
}));

vi.mock('../services/payroll/payroll-calc-columns.service.js', async importOriginal => ({
  ...await importOriginal<typeof import('../services/payroll/payroll-calc-columns.service.js')>(),
  getCalcColumns: h.getCalcColumns,
}));

vi.mock('../services/payroll/payroll-summary.service.js', async importOriginal => ({
  ...await importOriginal<typeof import('../services/payroll/payroll-summary.service.js')>(),
  loadPayrollSummary: h.loadPayrollSummary,
}));

vi.mock('../services/payroll/payroll-terms-payouts.service.js', async importOriginal => ({
  ...await importOriginal<typeof import('../services/payroll/payroll-terms-payouts.service.js')>(),
  getTermsPayouts: h.getTermsPayouts,
}));

const slot = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('../services/payroll/payroll-calc-slot.js', async importOriginal => {
  const original = await importOriginal<typeof import('../services/payroll/payroll-calc-slot.js')>();
  return {
    ...original,
    runInPayrollCalcSlot: ((...args: Parameters<typeof original.runInPayrollCalcSlot>) => {
      slot.calls.push(args[2]);
      return original.runInPayrollCalcSlot(...args);
    }) as typeof original.runInPayrollCalcSlot,
  };
});

const { serverTiming } = await import('../middleware/serverTiming.js');
const { payrollSummaryController } = await import('../controllers/payroll-summary.controller.js');
const { payrollTermsController } = await import('../controllers/payroll-terms.controller.js');

// Маршруты — как в payroll.routes.ts, без проверки прав (её покрывают *-access.routes.test.ts).
const app = express();
app.use((req, _res, next) => {
  (req as unknown as { user: unknown }).user = { id: 'user-1', role_code: 'admin', is_admin: true };
  next();
});
const router = express.Router();
router.get('/terms/calc-columns', serverTiming('payroll_calc_columns'), payrollTermsController.calcColumns as express.RequestHandler);
router.get('/terms/payouts', serverTiming('payroll_terms_payouts'), payrollTermsController.payouts as express.RequestHandler);
router.get('/summary', serverTiming('payroll_summary'), payrollSummaryController.get as express.RequestHandler);
app.use('/api/payroll', router);

const CALC_URL = '/api/payroll/terms/calc-columns?employee_ids=1,2&paid_months=2026-09&preliminary=1';
const SUMMARY_URL = '/api/payroll/summary?months=2026-09';
const PAYOUTS_URL = '/api/payroll/terms/payouts?employee_ids=1,2&date=2026-11-09';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(res => { resolve = res; });
  return { promise, resolve };
};

beforeEach(() => {
  h.order.length = 0;
  slot.calls.length = 0;
  h.getCalcColumns.mockReset();
  h.loadPayrollSummary.mockReset();
  h.getTermsPayouts.mockReset();
  h.getCalcColumns.mockImplementation(async (ids: number[]) => {
    h.order.push('calc');
    return new Map(ids.map(id => [id, null]));
  });
  h.loadPayrollSummary.mockImplementation(async () => {
    h.order.push('summary');
    return { months: ['2026-09'], rows: [] };
  });
  h.getTermsPayouts.mockImplementation(async () => {
    h.order.push('payouts');
    return { months: [], payouts: new Map() };
  });
});

describe('очередь расчётов «Зарплаты» через HTTP', () => {
  it('«Свод» — high; Server-Timing: ожидание, шаги «Свода» и полный маршрут', async () => {
    const res = await request(app).get(SUMMARY_URL).expect(200);
    expect(slot.calls).toEqual(['high']);
    const timing = String(res.headers['server-timing']);
    expect(timing).toMatch(/payroll_queue;dur=[\d.]+;desc="high depth=0"/);
    expect(timing).toMatch(/summary_total;dur=/);
    expect(timing).toMatch(/payroll_summary;dur=/);
    expect(res.body).toEqual({ success: true, data: { months: ['2026-09'], rows: [] } });
  });

  it('столбцы ФОТ — normal; Server-Timing: ожидание, шаги расчёта и полный маршрут', async () => {
    const res = await request(app).get(CALC_URL).expect(200);
    expect(slot.calls).toEqual(['normal']);
    const timing = String(res.headers['server-timing']);
    expect(timing).toMatch(/payroll_queue;dur=[\d.]+;desc="normal depth=0"/);
    expect(timing).toMatch(/calc_total;dur=/);
    expect(timing).toMatch(/payroll_calc_columns;dur=/);
    expect(res.body.data).toEqual({ available: true, rows: [{ employee_id: 1, calc: null }, { employee_id: 2, calc: null }] });
  });

  it('«Выплачено» — low; Server-Timing: ожидание и полный маршрут', async () => {
    const res = await request(app).get(PAYOUTS_URL).expect(200);
    expect(slot.calls).toEqual(['low']);
    const timing = String(res.headers['server-timing']);
    expect(timing).toMatch(/payroll_queue;dur=[\d.]+;desc="low depth=0"/);
    expect(timing).toMatch(/payroll_terms_payouts;dur=/);
  });

  it('«Свод» обгоняет ожидающую порцию, но ждёт идущую', async () => {
    const gate = deferred();
    h.getCalcColumns.mockImplementationOnce(async (ids: number[]) => {
      h.order.push('calc-running');
      await gate.promise;
      return new Map(ids.map(id => [id, null]));
    });
    const running = request(app).get(CALC_URL).then(res => res);
    await vi.waitFor(() => expect(h.order).toEqual(['calc-running']));
    const waitingCalc = request(app).get(CALC_URL).then(res => res);
    await vi.waitFor(() => expect(slot.calls).toHaveLength(2));
    const summary = request(app).get(SUMMARY_URL).then(res => res);
    await vi.waitFor(() => expect(slot.calls).toHaveLength(3));
    expect(h.order).toEqual(['calc-running']);

    gate.resolve();
    const [first, second, third] = await Promise.all([running, waitingCalc, summary]);
    expect([first.status, second.status, third.status]).toEqual([200, 200, 200]);
    expect(h.order).toEqual(['calc-running', 'summary', 'calc']);
    expect(String(third.headers['server-timing'])).toMatch(/payroll_queue;dur=[\d.]+;desc="high depth=2"/);
  });

  it('брошенный клиентом в ожидании — не считается, без 500 и без console.error', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const gate = deferred();
    h.getCalcColumns.mockImplementationOnce(async (ids: number[]) => {
      h.order.push('calc-running');
      await gate.promise;
      return new Map(ids.map(id => [id, null]));
    });
    const running = request(app).get(CALC_URL).then(res => res);
    await vi.waitFor(() => expect(h.order).toEqual(['calc-running']));
    // Клиент не дождался (как таймаут фронта): соединение закрыто, пока запрос стоял в очереди.
    const abandoned = request(app).get(CALC_URL).timeout(100).then(() => 'answered', () => 'timeout');
    expect(await abandoned).toBe('timeout');
    await vi.waitFor(() => expect(logs).toHaveBeenCalledWith(expect.stringMatching(/\[payroll-queue\] .* normal .* aborted$/)));

    gate.resolve();
    expect((await running).status).toBe(200);
    // Следующий запрос идёт сразу: брошенный из очереди удалён.
    await request(app).get(CALC_URL).expect(200);
    expect(h.order).toEqual(['calc-running', 'calc']);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
    logs.mockRestore();
  });
});
