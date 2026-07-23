import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseAvailableTariffs, parseForwarding, mtsBusinessCatalogService } from './mts-business-catalog.service.js';
import { MtsBusinessApiError } from './mts-business-base.service.js';

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

// Контракт снят живым дампом 22.07.2026 (ЛС ООО СУ-10, 7915***501) уже с
// включённым правилом: значения приходят парами name/value в
// productCharacteristic, а не полями forwardingType/forwardingAddress.
describe('МТС Бизнес: parseForwarding (правила переадресации)', () => {
  const live = [{
    relatedParty: [{ type: 'Party', characteristic: [{ name: 'MSISDN', value: '79151518501' }] }],
    productCharacteristic: [
      { name: 'ForwardingAddress', value: '79032839404' },
      { name: 'ForwardingType', value: 'CFU' },
      { name: 'NoReplyTimer', value: '0' },
      { name: 'NumType', value: 'Regular' },
    ],
  }];

  it('читает правило из productCharacteristic (живой ответ МТС)', () => {
    expect(parseForwarding(live)).toEqual([{
      forwardingType: 'CFU', forwardingAddress: '79032839404', noReplyTimer: 0, numType: 'Regular', status: null,
    }]);
  });

  it('журнал заявок (узлы type=Party со статусами) не превращается в правила', () => {
    const log = [{
      relatedParty: [
        { type: 'Party', status: 'Faulted', characteristic: [{ name: 'msisdn', value: '79151518501' }, { name: 'foris_error_code', value: 'CallForwardingServiceNotExists' }] },
        { type: 'Party', status: 'Completed', characteristic: [{ name: 'msisdn', value: '79151518501' }] },
      ],
    }];
    expect(parseForwarding(log)).toEqual([]);
  });

  it('форма с прямыми полями продолжает работать; пустой ответ → []', () => {
    expect(parseForwarding([{ forwardingType: 'CFNRY', forwardingAddress: '79161234567', noReplyTimer: 20 }]))
      .toEqual([{ forwardingType: 'CFNRY', forwardingAddress: '79161234567', noReplyTimer: 20, numType: null, status: null }]);
    expect(parseForwarding([])).toEqual([]);
    expect(parseForwarding(null)).toEqual([]);
  });
});

// Регресс на Sentry FOT-SERVER-4K: МТС отвечал 2xx без eventID, код бросал
// ошибку → 500, переадресация не работала ни разу (заявок в БД 0).
describe('МТС Бизнес: changeCallForwarding (три исхода)', () => {
  const internals = mtsBusinessCatalogService as unknown as CatalogInternals;
  const ACCOUNT = 'a1b2c3d4-0000-0000-0000-000000000001';
  const MSISDN = '79151204230';
  const TARGET = '79161234567';

  const rule = (over: Record<string, unknown> = {}) => ({
    forwardingType: 'CFU', forwardingAddress: TARGET, noReplyTimer: null, numType: 'Regular', status: null, ...over,
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('eventID во вложенном узле — queued (верхним уровнем ответ не ограничен)', async () => {
    vi.spyOn(internals, 'request').mockResolvedValue({ item: [{ eventID: 'evt-77' }] });

    const out = await mtsBusinessCatalogService.changeCallForwarding(ACCOUNT, MSISDN, 'create', {
      forwardingType: 'CFU', forwardingAddress: TARGET,
    });

    expect(out).toEqual({ outcome: 'queued', eventId: 'evt-77' });
  });

  it('NumType задаёт сервис, вызывающему коду его не передают', async () => {
    const spy = vi.spyOn(internals, 'request').mockResolvedValue({ eventID: 'evt-1' });

    await mtsBusinessCatalogService.changeCallForwarding(ACCOUNT, MSISDN, 'create', {
      forwardingType: 'CFNRY', forwardingAddress: TARGET, noReplyTimer: 20,
    });

    const body = spy.mock.calls[0][2].data as {
      item: Array<{ product: { productCharacteristic: Array<{ name: string; value: string }> } }>;
    };
    const chars = body.item[0].product.productCharacteristic;
    expect(chars).toContainEqual({ name: 'NumType', value: 'Regular' });
    expect(chars).toContainEqual({ name: 'NoReplyTimer', value: '20' });
    expect(spy.mock.calls[0][2].retryOn500).toBe(false);
  });

  it('без eventID, но правило появилось — applied с прочитанными правилами', async () => {
    const spy = vi.spyOn(internals, 'request');
    spy.mockResolvedValueOnce({ status: 'ok' });              // POST ChangeCallForwarding
    spy.mockResolvedValueOnce([rule()]);                       // GET CallForwardingInfo
    const out = await mtsBusinessCatalogService.changeCallForwarding(ACCOUNT, MSISDN, 'create', {
      forwardingType: 'CFU', forwardingAddress: TARGET,
    });

    expect(out).toEqual({ outcome: 'applied', eventId: null, rules: [rule()] });
  });

  it('без eventID и правило не появилось — unknown, а не ошибка (повтор мутации опасен)', async () => {
    const spy = vi.spyOn(internals, 'request');
    spy.mockResolvedValueOnce({ status: 'ok' });
    spy.mockResolvedValue([]); // сколько бы раз ни перечитывали — пусто

    const out = await mtsBusinessCatalogService.changeCallForwarding(ACCOUNT, MSISDN, 'create', {
      forwardingType: 'CFU', forwardingAddress: TARGET,
    });

    expect(out).toEqual({ outcome: 'unknown', eventId: null });
  });

  it('снятие подтверждается отсутствием АКТИВНОГО правила (заглушка МТС не мешает)', async () => {
    const spy = vi.spyOn(internals, 'request');
    spy.mockResolvedValueOnce({ status: 'ok' });
    spy.mockResolvedValueOnce([rule({ forwardingAddress: null })]); // пустая заглушка того же типа

    const out = await mtsBusinessCatalogService.changeCallForwarding(ACCOUNT, MSISDN, 'delete', {
      forwardingType: 'CFU',
    });

    expect(out.outcome).toBe('applied');
  });

  it('error-конверт в теле 2xx — исключение с текстом МТС', async () => {
    vi.spyOn(internals, 'request').mockResolvedValue({ errorCode: '2005', errorMessage: 'Не найдена связка региона' });

    await expect(mtsBusinessCatalogService.changeCallForwarding(ACCOUNT, MSISDN, 'create', {
      forwardingType: 'CFU', forwardingAddress: TARGET,
    })).rejects.toThrow(MtsBusinessApiError);
    await expect(mtsBusinessCatalogService.changeCallForwarding(ACCOUNT, MSISDN, 'create', {
      forwardingType: 'CFU', forwardingAddress: TARGET,
    })).rejects.toThrow(/Не найдена связка региона/);
  });

  it('requestID за eventId не принимаем — контракт CheckRequestStatus не подтверждён', async () => {
    const spy = vi.spyOn(internals, 'request');
    spy.mockResolvedValueOnce({ requestID: 'req-1' });
    spy.mockResolvedValue([]);

    const out = await mtsBusinessCatalogService.changeCallForwarding(ACCOUNT, MSISDN, 'create', {
      forwardingType: 'CFU', forwardingAddress: TARGET,
    });

    expect(out.outcome).toBe('unknown');
  });
});
