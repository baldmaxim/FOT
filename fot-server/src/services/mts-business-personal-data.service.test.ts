import { describe, it, expect, vi } from 'vitest';

// stableStringify/personalDataPlainHash — чистые функции, но модуль тянет
// HTTP-базу и mapping: мокаем зависимости, чтобы тест был лёгким.
vi.mock('../config/postgres.js', () => ({
  query: vi.fn(async () => []),
  queryOne: vi.fn(async () => null),
  execute: vi.fn(async () => 1),
}));
vi.mock('./encryption.service.js', () => ({
  encryptionService: { encrypt: (v: string) => `enc:${v}`, decryptField: (v: string | null) => v },
}));
vi.mock('./mts-business-base.service.js', () => ({
  MtsBusinessServiceBase: class {},
}));
vi.mock('./mts-business-mapping.service.js', () => ({
  mtsBusinessMappingService: {},
}));
vi.mock('./mts-business-cdr.service.js', () => ({
  msisdnHash: (m: string | null) => (m ? `h${m}` : null),
  normalizeMsisdn: (m: string | null) => m,
}));

import { stableStringify, personalDataPlainHash } from './mts-business-personal-data.service.js';

describe('stableStringify / personalDataPlainHash: канонизация для pd_data_hash', () => {
  it('перестановка ключей (в т.ч. вложенных и в массивах) не меняет хэш', () => {
    const a = { fio: { last: 'Иванов', first: 'Иван' }, docs: [{ type: 'passport', num: '1234' }] };
    const b = { docs: [{ num: '1234', type: 'passport' }], fio: { first: 'Иван', last: 'Иванов' } };
    expect(stableStringify(a)).toBe(stableStringify(b));
    expect(personalDataPlainHash(a)).toBe(personalDataPlainHash(b));
  });

  it('изменение значения меняет хэш', () => {
    expect(personalDataPlainHash({ fio: 'Иванов' })).not.toBe(personalDataPlainHash({ fio: 'Петров' }));
  });

  it('undefined-поля игнорируются, примитивы и null сериализуются стабильно', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify(['x', 2, null])).toBe('["x",2,null]');
  });
});
