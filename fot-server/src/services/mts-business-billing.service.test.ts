import { describe, it, expect, vi } from 'vitest';

// parsePackages — чистая функция, но модуль тянет HTTP-базу: мокаем зависимости.
vi.mock('./mts-business-base.service.js', () => ({
  MtsBusinessServiceBase: class {},
}));

import { parsePackages } from './mts-business-billing.service.js';

/** Узел продукта в форме реального ответа Bills/ValidityInfo (probe 16.07.2026). */
const product = (
  name: string,
  unit: string,
  counterType: string,
  currentValue: string,
  validFor?: { startDateTime: string; endDateTime: string },
) => ({
  relationshipType: 'ProductRelationship',
  product: {
    productStatus: 'Active',
    productPrice: [{ unitOfMeasure: unit }],
    ...(validFor ? { validFor } : {}),
    productSpecification: {
      name,
      id: 'X',
      productSpecCharacteristic: [
        {
          prodSpecCharacteristicValue: [
            { valueType: 'CounterValueType', value: counterType },
            { validFor: { endDateTime: '2037-12-31T21:00:00Z' } },
            { valueType: 'CurrentValue', value: currentValue },
          ],
        },
      ],
    },
  },
});

const validityResponse = (products: unknown[]) => [
  { name: 'ForisCounters', customerAccount: [{ accountType: 'CustomerAccount', productRelationship: products }] },
];

describe('parsePackages: реальная форма ValidityInfo (CounterValueType/CurrentValue)', () => {
  it('берёт только Remainder-счётчики: остаток из CurrentValue, квоты нет (null)', () => {
    const resp = validityResponse([
      product('Умный бизнес M (пакет минут)', 'SECOND', 'Remainder', '60000',
        { startDateTime: '2026-06-30T21:00:00Z', endDateTime: '2026-07-31T20:59:59Z' }),
      product('Умный бизнес M (пакет SMS)', 'ITEM', 'Remainder', '491'),
      product('Удержание вызова. Факт', 'ITEM', 'Accumulation', '1'),
      product('Бизнес пакет: мест. минуты', 'SECOND', 'Unspecified', '0'),
    ]);
    const out = parsePackages(resp);
    expect(out).toEqual([
      {
        name: 'Умный бизнес M (пакет минут)', unitOfMeasure: 'SECOND',
        quota: null, remainder: 60000, consumption: null, rotate: null,
        validFrom: '2026-06-30T21:00:00Z', validTo: '2026-07-31T20:59:59Z',
      },
      {
        name: 'Умный бизнес M (пакет SMS)', unitOfMeasure: 'ITEM',
        quota: null, remainder: 491, consumption: null, rotate: null,
        validFrom: null, validTo: null,
      },
    ]);
  });

  it('пустой/чужой ответ → пустой список', () => {
    expect(parsePackages(null)).toEqual([]);
    expect(parsePackages([{ name: 'ForisCounters', customerAccount: [] }])).toEqual([]);
    expect(parsePackages({ some: 'garbage' })).toEqual([]);
  });
});
