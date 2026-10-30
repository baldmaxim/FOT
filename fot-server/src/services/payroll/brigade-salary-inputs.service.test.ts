import crypto from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  brigadeOutputMode,
  brigadeSalaryInputsHash,
  brigadeSalaryLockKey,
  totalBrigadeOutput,
  type IBrigadeSalaryInputs,
} from './brigade-salary-inputs.service.js';

const inputs = (over: Partial<IBrigadeSalaryInputs> = {}): IBrigadeSalaryInputs => ({
  outputs: new Map([['wave', { amount: '100000.5', object_name: 'ЖК Wave' }]]),
  brigadeOutput: null,
  ktu: new Map([[1951, 15], [2325, 10]]),
  ...over,
});

/** Отпечаток до 341 — та же формула без ключа brigade. */
const legacyHash = (outputs: Array<[string, string]>, ktu: Array<[number, number]>): string => (
  `v2:${crypto.createHash('sha256').update(JSON.stringify({ outputs, ktu })).digest('hex')}`
);

describe('отпечаток ввода бригады и сумма бригаде (341)', () => {
  it('без суммы бригаде — байт-в-байт прежний: закрытые месяцы не пересчитываются', () => {
    // КТУ 1,0 не входит, сумма — нормализована до копеек.
    expect(brigadeSalaryInputsHash(inputs())).toBe(legacyHash([['wave', '100000.50']], [[1951, 15]]));
    expect(brigadeSalaryInputsHash(inputs({ outputs: new Map() }))).toBe(legacyHash([], [[1951, 15]]));
  });

  it('сумма бригаде меняет отпечаток; запись суммы разными строками — один отпечаток; стёрли — прежний', () => {
    const base = inputs({ outputs: new Map() });
    const withBrigade = inputs({ outputs: new Map(), brigadeOutput: '1000000' });
    expect(brigadeSalaryInputsHash(withBrigade)).not.toBe(brigadeSalaryInputsHash(base));
    expect(brigadeSalaryInputsHash(withBrigade)).toBe(brigadeSalaryInputsHash({ ...withBrigade, brigadeOutput: '1000000.00' }));
    expect(brigadeSalaryInputsHash({ ...withBrigade, brigadeOutput: null })).toBe(brigadeSalaryInputsHash(base));
  });

  it('режим и выработка, по которой делятся доли', () => {
    expect(brigadeOutputMode(inputs())).toBe('objects');
    expect(totalBrigadeOutput(inputs())).toBe('100000.50');
    expect(totalBrigadeOutput(inputs({ outputs: new Map() }))).toBeNull();
    const brigade = inputs({ outputs: new Map(), brigadeOutput: '250000' });
    expect(brigadeOutputMode(brigade)).toBe('brigade');
    expect(totalBrigadeOutput(brigade)).toBe('250000.00');
    expect(totalBrigadeOutput({ ...brigade, brigadeOutput: '0.00' })).toBe('0.00');
  });

  it('ключ замка — как у фиксации расчёта и триггера 341', () => {
    expect(brigadeSalaryLockKey('5049c2c9-1334-49e6-8d55-7a04bebcaa8c', '2026-10'))
      .toBe('brigade_salary:5049c2c9-1334-49e6-8d55-7a04bebcaa8c:2026-10');
  });
});
