import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./settings.service.js', () => ({
  assertMtsBusinessBaseUrlAllowed: vi.fn(),
}));
vi.mock('./mts-business-accounts.service.js', () => ({
  mtsBusinessAccountsService: {},
}));
vi.mock('./mts-business-auth.service.js', () => ({
  mtsBusinessAuthService: {},
}));
vi.mock('./mts-business-billing.service.js', () => ({
  mtsBusinessBillingService: { getTariffRental: vi.fn(async () => ({})) },
}));
vi.mock('./mts-business-catalog.service.js', () => ({
  mtsBusinessCatalogService: {
    getBillPlanInfo: vi.fn(async () => ({})),
    getProductInfo: vi.fn(async () => ({})),
    getConnectedBlocks: vi.fn(async () => ({})),
  },
}));
vi.mock('./mts-business-metrics-store.service.js', () => ({
  mtsBusinessMetricsStoreService: { upsertSnapshot: vi.fn(async () => undefined) },
}));
vi.mock('./mts-business-personal-data.service.js', () => ({
  mtsBusinessPersonalDataService: { fetchAndStoreFull: vi.fn(async () => ({ fullName: null })) },
}));
vi.mock('./mts-business-mapping.service.js', () => ({
  mtsBusinessMappingService: {
    getAllKnownMsisdnsByAccount: vi.fn(async () => ['79001111111', '79002222222']),
    getFreshPdHashes: vi.fn(async () => new Set<string>()),
    syncMtsNames: vi.fn(async () => ({ saved: 0, autoLinked: 0 })),
  },
}));
vi.mock('./mts-business-cdr.service.js', () => ({
  msisdnHash: (m: string | null) => (m ? `h${m}` : null),
}));

import { syncAccountSubscribers } from './mts-business-subscriber-sync.service.js';
import { mtsBusinessCatalogService } from './mts-business-catalog.service.js';
import { mtsBusinessBillingService } from './mts-business-billing.service.js';
import { mtsBusinessPersonalDataService } from './mts-business-personal-data.service.js';
import { MtsBusinessApiError } from './mts-business-base.service.js';

const getBillPlanInfo = vi.mocked(mtsBusinessCatalogService.getBillPlanInfo);
const getTariffRental = vi.mocked(mtsBusinessBillingService.getTariffRental);

/** bill_plan падает для msisdn заданное число раз, затем успех. */
const failBillPlanTimes = (msisdn: string, times: number, error: MtsBusinessApiError): void => {
  const attempts = new Map<string, number>();
  getBillPlanInfo.mockImplementation((async (_accountId: string, m: string) => {
    if (m !== msisdn) return {};
    const n = (attempts.get(m) ?? 0) + 1;
    attempts.set(m, n);
    if (n <= times) throw error;
    return {};
  }) as typeof mtsBusinessCatalogService.getBillPlanInfo);
};

describe('syncAccountSubscribers: второй проход по упавшим секциям', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('без ошибок — повторов нет, все секции сохранены', async () => {
    const res = await syncAccountSubscribers('acc');
    // 2 номера × (персданные + 4 секции)
    expect(res).toMatchObject({ numbers: 2, stored: 10, failed: 0, transient: 0, retriedNumbers: 0 });
    expect(getBillPlanInfo).toHaveBeenCalledTimes(2);
  });

  it('упавшая секция добирается повтором, успешные секции не перевызываются', async () => {
    failBillPlanTimes('79002222222', 1, new MtsBusinessApiError('EJB', 500, '9999'));
    const res = await syncAccountSubscribers('acc');
    expect(res).toMatchObject({ failed: 0, retriedNumbers: 1, retriedOk: 1, stored: 10 });
    expect(res.errorBreakdown).toEqual({});
    expect(getBillPlanInfo).toHaveBeenCalledTimes(3); // два номера + повтор одного
    expect(getTariffRental).toHaveBeenCalledTimes(2); // повтор НЕ трогает успешную секцию
  });

  it('секция упала и после повтора — failed с разбивкой по классам', async () => {
    failBillPlanTimes('79002222222', 2, new MtsBusinessApiError('EJB', 500, '9999'));
    const res = await syncAccountSubscribers('acc');
    expect(res).toMatchObject({ failed: 1, retriedNumbers: 1, retriedOk: 0, stored: 9 });
    expect(res.errorBreakdown).toEqual({ 'http 500/9999': 1 });
  });

  it('421/3003 после повтора — transient, не failed, в разбивку не попадает', async () => {
    failBillPlanTimes('79002222222', 2, new MtsBusinessApiError('Foris', 421, '3003'));
    const res = await syncAccountSubscribers('acc');
    expect(res).toMatchObject({ failed: 0, transient: 1, retriedNumbers: 1, retriedOk: 0 });
    expect(res.errorBreakdown).toEqual({});
  });

  it('номер вне доступа (401/1014 на всех секциях) — noAccessNumbers, не failed, без повтора', async () => {
    const denied = new MtsBusinessApiError('unauthorized', 401, '1014');
    const failFor = (m: string) => async (_a: string, msisdn: string) => {
      if (msisdn === m) throw denied;
      return {};
    };
    getBillPlanInfo.mockImplementation(failFor('79002222222') as typeof mtsBusinessCatalogService.getBillPlanInfo);
    getTariffRental.mockImplementation(failFor('79002222222') as typeof mtsBusinessBillingService.getTariffRental);
    vi.mocked(mtsBusinessCatalogService.getProductInfo).mockImplementation(failFor('79002222222') as typeof mtsBusinessCatalogService.getProductInfo);
    vi.mocked(mtsBusinessCatalogService.getConnectedBlocks).mockImplementation(failFor('79002222222') as typeof mtsBusinessCatalogService.getConnectedBlocks);
    vi.mocked(mtsBusinessPersonalDataService.fetchAndStoreFull).mockImplementation((async (_a: string, msisdn: string) => {
      if (msisdn === '79002222222') throw denied;
      return { fullName: null };
    }) as typeof mtsBusinessPersonalDataService.fetchAndStoreFull);

    const res = await syncAccountSubscribers('acc');
    expect(res).toMatchObject({ failed: 0, noAccessNumbers: 1, retriedNumbers: 0, stored: 5 });
    expect(res.errorBreakdown).toEqual({});
    expect(getBillPlanInfo).toHaveBeenCalledTimes(2); // повтора по «без доступа» нет
  });

  it('400/IL.* — mtsErrorSections, не failed, без повтора и не в разбивке', async () => {
    // Остальные секции — успех (clearAllMocks не сбрасывает impl из прошлых тестов).
    getTariffRental.mockImplementation((async () => ({})) as typeof mtsBusinessBillingService.getTariffRental);
    vi.mocked(mtsBusinessCatalogService.getProductInfo).mockImplementation((async () => ({})) as typeof mtsBusinessCatalogService.getProductInfo);
    vi.mocked(mtsBusinessCatalogService.getConnectedBlocks).mockImplementation((async () => ({})) as typeof mtsBusinessCatalogService.getConnectedBlocks);
    vi.mocked(mtsBusinessPersonalDataService.fetchAndStoreFull).mockImplementation((async () => ({ fullName: null })) as typeof mtsBusinessPersonalDataService.fetchAndStoreFull);
    getBillPlanInfo.mockImplementation((async (_a: string, msisdn: string) => {
      if (msisdn === '79002222222') throw new MtsBusinessApiError('unknown', 400, 'IL.UnknownError');
      return {};
    }) as typeof mtsBusinessCatalogService.getBillPlanInfo);

    const res = await syncAccountSubscribers('acc');
    expect(res).toMatchObject({ failed: 0, transient: 0, mtsErrorSections: 1, retriedNumbers: 0, stored: 9 });
    expect(res.errorBreakdown).toEqual({});
    expect(getBillPlanInfo).toHaveBeenCalledTimes(2); // повтора по 400/IL.* нет
  });

  it('422/2005 «нет связки ТП» — noBindingNumbers; 404 персданных — noPdNumbers', async () => {
    failBillPlanTimes('79002222222', 99, new MtsBusinessApiError('нет связки', 422, '2005'));
    vi.mocked(mtsBusinessPersonalDataService.fetchAndStoreFull).mockImplementation((async (_a: string, msisdn: string) => {
      if (msisdn === '79001111111') throw new MtsBusinessApiError('not found', 404);
      return { fullName: null };
    }) as typeof mtsBusinessPersonalDataService.fetchAndStoreFull);

    const res = await syncAccountSubscribers('acc');
    expect(res).toMatchObject({ failed: 0, noBindingNumbers: 1, noPdNumbers: 1, retriedNumbers: 0 });
  });
});
