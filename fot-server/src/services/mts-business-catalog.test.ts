import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseAvailableTariffs, mtsBusinessCatalogService } from './mts-business-catalog.service.js';

// Контракт снят живым probe 10.07.2026 (ЛС СУ-10, msisdn 7915…230):
// GET /Product/ProductInfo?category.name=AvailibleTariffPlann → 200, массив тарифов.
// id тарифа — в поле `id` (НЕ externalID), цена — в productOfferingPrice[].price.dutyFreeAmount
// (taxIncludedAmount приходит 0 = скидка). Прежний парсер искал externalID → count=0.
describe('МТС Бизнес: parseAvailableTariffs (доступные тарифы для перехода)', () => {
  const sample = [
    {
      name: 'Умный бизнес M (КОРП) (SS)',
      id: '0495',
      marketSegment: [{ characteristic: [{ name: 'MSISDN', value: '79151204230' }] }],
      category: [{ name: 'AD' }],
      productOfferingPrice: [{
        type: 'ProductOfferingPrice',
        unitOfMeasure: 'FACT',
        name: 'Price',
        price: { currencyCode: '810', dutyFreeAmount: 122.95082, taxIncludedAmount: 0 },
      }],
    },
    {
      name: 'Умный бизнес XL (КОРП) (SS)',
      id: '0860',
      productOfferingPrice: [{ name: 'Price', price: { dutyFreeAmount: 500, taxIncludedAmount: 0 } }],
    },
  ];

  it('читает id как идентификатор тарифа и цену из dutyFreeAmount', () => {
    expect(parseAvailableTariffs(sample)).toEqual([
      { tariffId: '0495', name: 'Умный бизнес M (КОРП) (SS)', price: 122.95082 },
      { tariffId: '0860', name: 'Умный бизнес XL (КОРП) (SS)', price: 500 },
    ]);
  });

  it('дедуплицирует по id и пропускает узлы без идентификатора', () => {
    const dup = [...sample, sample[0], { name: 'без id', productOfferingPrice: [] }];
    const out = parseAvailableTariffs(dup);
    expect(out.map(t => t.tariffId)).toEqual(['0495', '0860']);
  });

  it('толерантен к обёртке-объекту (fallback через productOfferingPrice-маркер)', () => {
    const wrapped = { data: { tariffs: sample } };
    expect(parseAvailableTariffs(wrapped).map(t => t.tariffId)).toEqual(['0495', '0860']);
  });

  it('пустой/битый ответ → []', () => {
    expect(parseAvailableTariffs(null)).toEqual([]);
    expect(parseAvailableTariffs([])).toEqual([]);
    expect(parseAvailableTariffs({})).toEqual([]);
  });
});

// Регресс на Sentry FOT-SERVER-4D: msisdn лежал в теле ModifyProduct, а гейт МТС
// ждёт его в query (док §5.4) — отвечал 401, управление услугами не работало.
interface IRequestOptions {
  accountId: string;
  params?: Record<string, unknown>;
  data?: unknown;
  retryOn500?: boolean;
}
type CatalogInternals = {
  request: (method: string, endpoint: string, options: IRequestOptions) => Promise<unknown>;
};

describe('МТС Бизнес: modifyProduct (подключение/отключение услуги и блокировки)', () => {
  const internals = mtsBusinessCatalogService as unknown as CatalogInternals;
  const ACCOUNT = 'a1b2c3d4-0000-0000-0000-000000000001';
  const MSISDN = '79151204230';

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('шлёт msisdn в query, а не в теле; тело — характеристика + item', async () => {
    const spy = vi.spyOn(internals, 'request').mockResolvedValue({ eventID: 'evt-1' });

    const out = await mtsBusinessCatalogService.modifyProduct(ACCOUNT, MSISDN, 'create', 'PE1234');

    expect(out).toEqual({ eventId: 'evt-1' });
    const [method, endpoint, options] = spy.mock.calls[0];
    expect(method).toBe('post');
    expect(endpoint).toBe('/Product/ModifyProduct');
    expect(options.params).toEqual({ msisdn: MSISDN });
    expect(options.retryOn500).toBe(false); // мутация: исход первой попытки неизвестен
    expect(options.data).toEqual({
      characteristic: [{ name: 'MobileConnectivity' }],
      item: [{
        action: 'create',
        product: {
          externalID: 'PE1234',
          productCharacteristic: [{ name: 'ResourceServiceRequestItemType', value: 'ResourceServiceRequestItem' }],
        },
      }],
    });
    expect(JSON.stringify(options.data)).not.toContain(MSISDN);
  });

  it('отключение шлёт action=delete', async () => {
    const spy = vi.spyOn(internals, 'request').mockResolvedValue({ eventID: 'evt-2' });

    await mtsBusinessCatalogService.modifyProduct(ACCOUNT, MSISDN, 'delete', 'BL0001');

    const body = spy.mock.calls[0][2].data as { item: Array<{ action: string; product: { externalID: string } }> };
    expect(body.item[0].action).toBe('delete');
    expect(body.item[0].product.externalID).toBe('BL0001');
  });

  it('ответ без eventID — ошибка (заявку нельзя отследить)', async () => {
    vi.spyOn(internals, 'request').mockResolvedValue({ status: 'ok' });

    await expect(mtsBusinessCatalogService.modifyProduct(ACCOUNT, MSISDN, 'create', 'PE1234'))
      .rejects.toThrow(/без eventID/);
  });
});
