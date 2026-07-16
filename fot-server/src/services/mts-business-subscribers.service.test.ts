import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/postgres.js', () => ({
  query: vi.fn(async () => []),
  queryOne: vi.fn(async () => null),
  execute: vi.fn(async () => 0),
}));
vi.mock('./encryption.service.js', () => ({ encryptionService: {} }));
vi.mock('./mts-business-mapping.service.js', () => ({ mtsBusinessMappingService: {} }));
vi.mock('./mts-business-personal-data.service.js', () => ({ mtsBusinessPersonalDataService: {} }));
vi.mock('./mts-business-catalog.service.js', () => ({
  extractTariffNameFromServices: vi.fn(() => null),
}));
vi.mock('./mts-business-metrics-store.service.js', () => ({
  mtsBusinessMetricsStoreService: {
    getLatestSnapshotsForMsisdn: vi.fn(async () => new Map()),
    getMsisdnChargesForPeriod: vi.fn(async () => null),
  },
}));

import { query } from '../config/postgres.js';
import { mtsBusinessMetricsStoreService } from './mts-business-metrics-store.service.js';
import { mtsBusinessSubscribersService } from './mts-business-subscribers.service.js';

const queryMock = vi.mocked(query);
const metrics = vi.mocked(mtsBusinessMetricsStoreService);

beforeEach(() => {
  vi.clearAllMocks();
});

// Один инстанс сервиса на файл — кэш квот (1 час) переживает clearAllMocks,
// поэтому строки квот задаются один раз в первом тесте.
describe('mtsBusinessSubscribersService — квоты пакетов из данных', () => {
  it('getDerivedPackageQuotas: карта name|uom → mode остатка; повторный вызов из кэша', async () => {
    queryMock.mockResolvedValueOnce([
      { name: 'Ежемесячная плата Умный бизнес M (мин)', uom: 'SECOND', quota: '60000' },
      { name: 'Ежемесячная плата Умный бизнес M (смс)', uom: 'ITEM', quota: '500' },
      { name: 'Битая строка', uom: 'ITEM', quota: 'not-a-number' },
    ] as never);

    const map = await mtsBusinessSubscribersService.getDerivedPackageQuotas();
    expect(map.get('Ежемесячная плата Умный бизнес M (мин)|SECOND')).toBe(60000);
    expect(map.get('Ежемесячная плата Умный бизнес M (смс)|ITEM')).toBe(500);
    expect(map.has('Битая строка|ITEM')).toBe(false);

    await mtsBusinessSubscribersService.getDerivedPackageQuotas();
    expect(queryMock).toHaveBeenCalledTimes(1); // кэш
  });

  it('getMySimSummary: пакет без квоты получает её из карты, посторонний счётчик — нет', async () => {
    metrics.getLatestSnapshotsForMsisdn.mockResolvedValueOnce(new Map([
      ['validity_msisdn', {
        payload: [
          {
            name: 'Ежемесячная плата Умный бизнес M (мин)', unitOfMeasure: 'SECOND',
            quota: null, remainder: 32340, consumption: null, rotate: null,
            validFrom: '2026-06-16T21:00:00Z', validTo: '2026-07-16T20:59:59Z',
          },
          {
            name: 'Пакет GPRS в МН роуминге', unitOfMeasure: 'BYTE',
            quota: null, remainder: 100, consumption: null, rotate: null,
            validFrom: null, validTo: null,
          },
        ],
        capturedAt: '2026-07-10T00:00:00Z',
      }],
    ]) as never);

    const summary = await mtsBusinessSubscribersService.getMySimSummary('79150000001');
    expect(summary).not.toBeNull();
    const minutes = summary?.packages.find(p => p.unitOfMeasure === 'SECOND');
    const roaming = summary?.packages.find(p => p.unitOfMeasure === 'BYTE');
    expect(minutes?.quota).toBe(60000); // из кэша первого теста
    expect(minutes?.remainder).toBe(32340);
    expect(roaming?.quota).toBeNull(); // счётчика нет в карте квот
  });
});
