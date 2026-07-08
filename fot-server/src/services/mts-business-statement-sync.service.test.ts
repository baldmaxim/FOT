import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/postgres.js', () => ({
  queryOne: vi.fn(async () => ({ c: '0' })),
}));
vi.mock('./settings.service.js', () => ({
  assertMtsBusinessBaseUrlAllowed: vi.fn(),
}));
vi.mock('./mts-business-accounts.service.js', () => ({
  mtsBusinessAccountsService: {},
}));
vi.mock('./mts-business-auth.service.js', () => ({
  mtsBusinessAuthService: {},
}));
vi.mock('./mts-business-data.service.js', () => ({
  mtsBusinessDataService: { getBillingStatementExtdByMsisdn: vi.fn() },
}));
vi.mock('./mts-business-cdr.service.js', () => ({
  mtsBusinessCdrService: {
    parseBillingStatementResponse: vi.fn(() => []),
    storeCalls: vi.fn(async () => ({ inserted: 0 })),
    sumStatementChargesByDay: vi.fn(() => new Map()),
  },
}));
vi.mock('./mts-business-metrics-store.service.js', () => ({
  mtsBusinessMetricsStoreService: { replaceMsisdnDailyCharges: vi.fn(async () => undefined) },
}));
// Полный subscriber-sync тянет billing/catalog/personal-data — для батча нужен только пул.
vi.mock('./mts-business-subscriber-sync.service.js', () => ({
  runPool: async <T>(items: T[], _limit: number, worker: (item: T) => Promise<void>): Promise<void> => {
    for (const item of items) await worker(item);
  },
}));

import { syncMsisdnsBatch } from './mts-business-statement-sync.service.js';
import { mtsBusinessDataService } from './mts-business-data.service.js';
import { MtsBusinessApiError } from './mts-business-base.service.js';

const getStatement = vi.mocked(mtsBusinessDataService.getBillingStatementExtdByMsisdn);

/** Выписка: per-msisdn сценарий по номерам попыток (1-я, 2-я, ...). */
const scriptStatement = (script: Record<string, Array<MtsBusinessApiError | 'ok'>>): void => {
  const attempts = new Map<string, number>();
  getStatement.mockImplementation(async (_accountId: string, params: { msisdn: string; dateFrom: string; dateTo: string }) => {
    const n = (attempts.get(params.msisdn) ?? 0) + 1;
    attempts.set(params.msisdn, n);
    const outcome = script[params.msisdn]?.[n - 1] ?? 'ok';
    if (outcome !== 'ok') throw outcome;
    return {};
  });
};

describe('syncMsisdnsBatch: второй проход и классификация ошибок', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('все номера успешны — без ошибок и повторов', async () => {
    scriptStatement({});
    const res = await syncMsisdnsBatch('acc', ['A', 'B'], '2026-07-01', '2026-07-07', 3);
    expect(res).toMatchObject({ numbers: 2, failed: 0, unavailable: 0, transient: 0, retriedOk: 0 });
    expect(res.errorBreakdown).toEqual({});
    expect(getStatement).toHaveBeenCalledTimes(2);
  });

  it('транзиентный сбой первого прохода добирается вторым', async () => {
    scriptStatement({ B: [new MtsBusinessApiError('EJB', 500, '9999'), 'ok'] });
    const res = await syncMsisdnsBatch('acc', ['A', 'B'], '2026-07-01', '2026-07-07', 3);
    expect(res).toMatchObject({ failed: 0, retriedOk: 1, transient: 0 });
    expect(res.errorBreakdown).toEqual({});
    expect(getStatement).toHaveBeenCalledTimes(3); // A + B + повтор B
  });

  it('стойкая ошибка после повтора — failed с разбивкой', async () => {
    scriptStatement({ B: [new MtsBusinessApiError('EJB', 500, '9999'), new MtsBusinessApiError('EJB', 500, '9999')] });
    const res = await syncMsisdnsBatch('acc', ['A', 'B'], '2026-07-01', '2026-07-07', 3);
    expect(res).toMatchObject({ failed: 1, retriedOk: 0 });
    expect(res.errorBreakdown).toEqual({ 'http 500/9999': 1 });
  });

  it('403/1010 «не в тарифе» — unavailable, повтора нет', async () => {
    scriptStatement({ B: [new MtsBusinessApiError('нет в тарифе', 403, '1010')] });
    const res = await syncMsisdnsBatch('acc', ['A', 'B'], '2026-07-01', '2026-07-07', 3);
    expect(res).toMatchObject({ failed: 0, unavailable: 1 });
    expect(getStatement).toHaveBeenCalledTimes(2); // без второго прохода по B
  });

  it('401/1014 «номер вне доступа» — noAccess, не failed, повтора нет', async () => {
    scriptStatement({ B: [new MtsBusinessApiError('unauthorized', 401, '1014')] });
    const res = await syncMsisdnsBatch('acc', ['A', 'B'], '2026-07-01', '2026-07-07', 3);
    expect(res).toMatchObject({ failed: 0, noAccess: 1 });
    expect(res.errorBreakdown).toEqual({});
    expect(getStatement).toHaveBeenCalledTimes(2);
  });

  it('421/3003 после повтора — transient, не failed', async () => {
    scriptStatement({ B: [new MtsBusinessApiError('Foris', 421, '3003'), new MtsBusinessApiError('Foris', 421, '3003')] });
    const res = await syncMsisdnsBatch('acc', ['A', 'B'], '2026-07-01', '2026-07-07', 3);
    expect(res).toMatchObject({ failed: 0, transient: 1 });
    expect(res.errorBreakdown).toEqual({ 'http 421/3003': 1 });
  });
});
