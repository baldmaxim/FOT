import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/postgres.js', () => ({
  query: vi.fn(async () => []),
  queryOne: vi.fn(async () => null),
  execute: vi.fn(async () => 0),
}));

import { execute } from '../config/postgres.js';
import type { IStatementUsageRow } from './mts-business-cdr.service.js';
import {
  buildStatementDedupKeys,
  statementPeerHash,
  parseUsagePeriod,
  mtsBusinessStatementRowsService,
} from './mts-business-statement-rows.service.js';

const executeMock = vi.mocked(execute);

const row = (over: Partial<IStatementUsageRow> = {}): IStatementUsageRow => ({
  date: '2026-07-06T12:34:56',
  category: 'sms',
  label: 'Исходящее SMS',
  networkEvent: 'sms',
  direction: 'out',
  peer: '79151234567',
  units: 1,
  unitCode: 'ITEM',
  amount: 0,
  ...over,
});

describe('buildStatementDedupKeys', () => {
  it('стабильны при повторном вызове (идемпотентный re-fetch месяца)', () => {
    const rows = [row(), row({ amount: 2.5 }), row({ category: 'calls', networkEvent: 'call', unitCode: 'SECOND', units: 60 })];
    expect(buildStatementDedupKeys('H', rows)).toEqual(buildStatementDedupKeys('H', rows));
  });

  it('две легитимно идентичные строки получают РАЗНЫЕ ключи (occurrence)', () => {
    const keys = buildStatementDedupKeys('H', [row(), row()]);
    expect(keys[0]).not.toBe(keys[1]);
    // Порядок идентичных строк не важен — множество ключей то же.
    expect(new Set(buildStatementDedupKeys('H', [row(), row()]))).toEqual(new Set(keys));
  });

  it('разные номера (msisdn_hash) дают разные ключи для одинаковых строк', () => {
    expect(buildStatementDedupKeys('H1', [row()])[0]).not.toBe(buildStatementDedupKeys('H2', [row()])[0]);
  });

  it('сумма участвует в ключе (изменение цены = другая строка)', () => {
    expect(buildStatementDedupKeys('H', [row({ amount: 1 })])[0])
      .not.toBe(buildStatementDedupKeys('H', [row({ amount: 2 })])[0]);
  });
});

describe('statementPeerHash', () => {
  it('валидный телефон → sha256-хэш (64 hex)', () => {
    const h = statementPeerHash('+7 (915) 123-45-67');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    // Канонизация: разные записи одного номера — один хэш.
    expect(statementPeerHash('89151234567')).toBe(h);
  });

  it('APN/сервисные строки и короткие номера → null', () => {
    expect(statementPeerHash('internet.mts.ru')).toBeNull();
    expect(statementPeerHash('111')).toBeNull();
    expect(statementPeerHash(null)).toBeNull();
  });
});

describe('parseUsagePeriod', () => {
  it('date приоритетнее month, период = один день', () => {
    expect(parseUsagePeriod('2026-07', '2026-07-06')).toEqual({
      dateFrom: '2026-07-06', dateTo: '2026-07-06', period: '2026-07-06',
    });
  });

  it('month → весь месяц (включая февраль високосного года)', () => {
    expect(parseUsagePeriod('2026-07', '')).toEqual({
      dateFrom: '2026-07-01', dateTo: '2026-07-31', period: '2026-07',
    });
    expect(parseUsagePeriod('2028-02', '')?.dateTo).toBe('2028-02-29');
  });

  it('некорректный ввод → null', () => {
    expect(parseUsagePeriod('', '')).toBeNull();
    expect(parseUsagePeriod('июль', '06.07.2026')).toBeNull();
  });
});

describe('storeRows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('строки без даты пропускаются, остальные уходят в один INSERT с дедупом', async () => {
    executeMock.mockResolvedValueOnce(2);
    const res = await mtsBusinessStatementRowsService.storeRows(
      'acc-1', '79150000001', [row(), row({ category: 'calls' }), row({ date: null })], 'nightly',
    );
    expect(res).toEqual({ inserted: 2, skipped: 0, noDate: 1 });
    expect(executeMock).toHaveBeenCalledTimes(1);
    const [sql, params] = executeMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO mts_business_statement_rows');
    expect(sql).toContain('ON CONFLICT (dedup_hash) DO NOTHING');
    expect(params).toHaveLength(2 * 15);
    // usage_date — из date.slice(0,10); source — как передан; peer — шифром (не plain).
    expect(params[3]).toBe('2026-07-06');
    expect(params[14]).toBe('nightly');
    expect(params[10]).not.toBe('79151234567');
    expect(String(params[10])).toContain(':'); // формат iv:authTag:ciphertext
    // peer_hash — валидный телефон → 64 hex.
    expect(params[9]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('дубли внутри батча не схлопываются (разные dedup-ключи)', async () => {
    executeMock.mockResolvedValueOnce(2);
    const res = await mtsBusinessStatementRowsService.storeRows('acc-1', '79150000001', [row(), row()], 'manual');
    expect(res.inserted).toBe(2);
    const [, params] = executeMock.mock.calls[0] as [string, unknown[]];
    expect(params[0]).not.toBe(params[15]); // dedup_hash первой и второй строки различаются
  });

  it('пустой список / кривой номер — без запросов к БД', async () => {
    expect(await mtsBusinessStatementRowsService.storeRows('acc-1', '79150000001', [], 'nightly'))
      .toEqual({ inserted: 0, skipped: 0, noDate: 0 });
    expect(await mtsBusinessStatementRowsService.storeRows('acc-1', 'не-номер', [row()], 'nightly'))
      .toEqual({ inserted: 0, skipped: 0, noDate: 0 });
    expect(executeMock).not.toHaveBeenCalled();
  });
});
