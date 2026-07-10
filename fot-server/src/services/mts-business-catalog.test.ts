import { describe, it, expect } from 'vitest';
import { parseAvailableTariffs } from './mts-business-catalog.service.js';

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
