import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';

// Журнал ведомостей 1С: только весь штат (403 иначе), месяцы — список YYYY-MM без повторов, до 6; состав — 404 на
// неизвестную; capability отдаёт оба права. Сервисы замоканы — SQL проверяет payroll-1c-payouts.api.pg.test.ts.

const mocks = vi.hoisted(() => ({
  canImportPayouts1c: vi.fn(),
  canViewPayouts1cJournal: vi.fn(),
  listPayoutJournal: vi.fn(),
  getPayoutJournalDoc: vi.fn(),
}));

vi.mock('../services/payroll/payroll-1c-payouts.access.js', () => ({
  canImportPayouts1c: mocks.canImportPayouts1c,
  canViewPayouts1cJournal: mocks.canViewPayouts1cJournal,
}));
vi.mock('../services/payroll/payroll-1c-payouts.journal.js', () => ({
  PAYOUT_JOURNAL_MAX_MONTHS: 6,
  listPayoutJournal: mocks.listPayoutJournal,
  getPayoutJournalDoc: mocks.getPayoutJournalDoc,
}));

import type { AuthenticatedRequest } from '../types/index.js';
import { payroll1cPayoutsController } from './payroll-1c-payouts.controller.js';

const makeReq = (input: { query?: Record<string, string>; params?: Record<string, string> } = {}) => (
  { query: input.query ?? {}, params: input.params ?? {}, user: { id: 'u1' } } as unknown as AuthenticatedRequest
);
const makeRes = () => {
  const response = {
    statusCode: 200, payload: null as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.payload = body; return this; },
  };
  return response as unknown as Response & { statusCode: number; payload: any };
};

describe('payroll-1c-payouts.controller — журнал', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.canImportPayouts1c.mockResolvedValue(false);
    mocks.canViewPayouts1cJournal.mockResolvedValue(true);
    mocks.listPayoutJournal.mockResolvedValue([{ id: 1 }]);
  });

  it('capability — оба права', async () => {
    const res = makeRes();
    await payroll1cPayoutsController.capability(makeReq(), res);
    expect(res.payload).toEqual({ success: true, data: { can_import: false, can_view_journal: true } });
  });

  it('без всего штата — 403, сервис не вызывается', async () => {
    mocks.canViewPayouts1cJournal.mockResolvedValue(false);
    const list = makeRes();
    await payroll1cPayoutsController.journal(makeReq({ query: { months: '2026-11' } }), list);
    expect(list.statusCode).toBe(403);
    const doc = makeRes();
    await payroll1cPayoutsController.journalDoc(makeReq({ params: { id: '1' } }), doc);
    expect(doc.statusCode).toBe(403);
    expect(mocks.listPayoutJournal).not.toHaveBeenCalled();
    expect(mocks.getPayoutJournalDoc).not.toHaveBeenCalled();
  });

  it('месяцы: повторы схлопываются, неверный и пустой — 400, больше 6 — 400', async () => {
    const ok = makeRes();
    await payroll1cPayoutsController.journal(makeReq({ query: { months: '2026-10, 2026-11,2026-10' } }), ok);
    expect(mocks.listPayoutJournal).toHaveBeenCalledWith(['2026-10', '2026-11']);
    expect(ok.payload).toEqual({ success: true, data: [{ id: 1 }] });
    for (const months of ['2026-13', '', Array.from({ length: 7 }, (_, i) => `2025-${String(i + 1).padStart(2, '0')}`).join(',')]) {
      const bad = makeRes();
      await payroll1cPayoutsController.journal(makeReq({ query: { months } }), bad);
      expect(bad.statusCode).toBe(400);
    }
  });

  it('состав: неизвестная и неверный id — 404', async () => {
    mocks.getPayoutJournalDoc.mockResolvedValue(null);
    const missing = makeRes();
    await payroll1cPayoutsController.journalDoc(makeReq({ params: { id: '5' } }), missing);
    expect(missing.statusCode).toBe(404);
    const bad = makeRes();
    await payroll1cPayoutsController.journalDoc(makeReq({ params: { id: 'abc' } }), bad);
    expect(bad.statusCode).toBe(404);
    expect(mocks.getPayoutJournalDoc).toHaveBeenCalledTimes(1);
  });
});
