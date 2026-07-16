import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/postgres.js', () => ({
  query: vi.fn(async () => []),
  queryOne: vi.fn(async () => null),
  execute: vi.fn(async () => 1),
}));
vi.mock('./encryption.service.js', () => ({
  encryptionService: { encrypt: (v: string) => `enc:${v}`, decryptField: (v: string | null) => v },
}));
vi.mock('./mts-business-cdr.service.js', () => ({
  msisdnHash: (m: string | null) => (m ? `h${m}` : null),
  normalizeMsisdn: (m: string | null) => m,
}));
// Реальный base-сервис тянет axios/settings/accounts/auth — для класса ошибки хватит мока.
vi.mock('./mts-business-base.service.js', () => ({
  MtsBusinessApiError: class MtsBusinessApiError extends Error {
    constructor(message: string, public status: number, public code?: string) {
      super(message);
    }
  },
}));

import { mtsBusinessSyncLogService, mtsErrorCodeOf, logFioChanges, type IMtsSyncRunLogger } from './mts-business-sync-log.service.js';
import { MtsBusinessApiError } from './mts-business-base.service.js';
import { query, queryOne, execute } from '../config/postgres.js';

const queryMock = vi.mocked(query);
const queryOneMock = vi.mocked(queryOne);
const executeMock = vi.mocked(execute);

const insertLogCalls = (): unknown[][] =>
  executeMock.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO mts_business_sync_log'));

const startRunOk = (): void => {
  queryOneMock.mockImplementation(async (sql: string) =>
    (String(sql).includes('INSERT INTO mts_business_sync_runs') ? { id: 'run-1' } : null) as never);
};

describe('mtsBusinessSyncLogService: логгер не роняет синки', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeMock.mockResolvedValue(1);
    queryMock.mockResolvedValue([]);
  });

  it('startRun при ошибке БД возвращает no-op-хэндл: log/finish молчат', async () => {
    queryOneMock.mockRejectedValue(new Error('db down'));
    const log = await mtsBusinessSyncLogService.startRun({ job: 'cdr_daily', initiator: 'schedule' });
    // Первый startRun процесса запускает фоновую retention-чистку — дожидаемся,
    // чтобы её DELETE'ы не проросли в моки следующих тестов.
    await new Promise(resolve => setImmediate(resolve));
    expect(log.runId).toBeNull();
    await log.log({ level: 'error', message: 'x' });
    await log.finish('error', { error: 'x' });
    expect(insertLogCalls()).toHaveLength(0);
    expect(executeMock.mock.calls.filter(([sql]) => String(sql).includes('UPDATE mts_business_sync_runs'))).toHaveLength(0);
  });

  it('ошибка INSERT записи глотается, следующий log продолжает работать', async () => {
    startRunOk();
    const log = await mtsBusinessSyncLogService.startRun({ job: 'cdr_daily', initiator: 'schedule' });
    executeMock.mockRejectedValueOnce(new Error('insert failed'));
    await expect(log.log({ level: 'error', message: 'a' })).resolves.toBeUndefined();
    await log.log({ level: 'warn', message: 'b' });
    expect(insertLogCalls()).toHaveLength(2);
  });

  it('кап записей на прогон: сверх лимита дропается, finish дописывает сводку о свёрнутых', async () => {
    startRunOk();
    const log = await mtsBusinessSyncLogService.startRun({ job: 'refresh_all', initiator: 'manual' });
    for (let i = 0; i < 505; i++) {
      await log.log({ level: 'error', message: `e${i}` });
    }
    expect(insertLogCalls()).toHaveLength(500);
    await log.finish('partial');
    const capEntry = insertLogCalls().at(-1);
    expect(String((capEntry?.[1] as unknown[])[9])).toContain('5 записей свёрнуто');
  });

  it('номер шифруется и хэшируется, в открытом виде не пишется', async () => {
    startRunOk();
    const log = await mtsBusinessSyncLogService.startRun({ job: 'rolling', initiator: 'schedule' });
    await log.log({ level: 'error', message: 'x', msisdn: '79001112233' });
    const params = insertLogCalls()[0][1] as unknown[];
    expect(params[5]).toBe('h79001112233');       // msisdn_hash
    expect(params[6]).toBe('enc:79001112233');    // msisdn_enc
    expect(params).not.toContain('79001112233');  // открытого номера нет
  });

  it('finish пишет статус/summary/stats/error одним UPDATE', async () => {
    startRunOk();
    const log = await mtsBusinessSyncLogService.startRun({ job: 'metrics_daily', initiator: 'schedule' });
    await log.finish('error', { summary: 'итог', stats: { failed: 3 }, error: 'boom' });
    const upd = executeMock.mock.calls.find(([sql]) => String(sql).includes('UPDATE mts_business_sync_runs'));
    expect(upd).toBeDefined();
    const params = upd![1] as unknown[];
    expect(params).toEqual(['run-1', 'error', 'итог', JSON.stringify({ failed: 3 }), 'boom']);
  });

  it('logStandalone пишет запись с run_id = NULL и глотает ошибку БД', async () => {
    await mtsBusinessSyncLogService.logStandalone('rolling', { level: 'error', message: 'x' });
    expect((insertLogCalls()[0][1] as unknown[])[0]).toBeNull();
    executeMock.mockRejectedValueOnce(new Error('db down'));
    await expect(mtsBusinessSyncLogService.logStandalone('rolling', { level: 'error', message: 'y' }))
      .resolves.toBeUndefined();
  });
});

describe('mtsErrorCodeOf', () => {
  it('MtsBusinessApiError → "status/code", без кода → "status", сеть/не-API → null', () => {
    expect(mtsErrorCodeOf(new MtsBusinessApiError('x', 401, '1014'))).toBe('401/1014');
    expect(mtsErrorCodeOf(new MtsBusinessApiError('x', 404))).toBe('404');
    expect(mtsErrorCodeOf(new MtsBusinessApiError('x', 0))).toBeNull();
    expect(mtsErrorCodeOf(new Error('x'))).toBeNull();
  });
});

describe('logFioChanges', () => {
  it('привязанный номер → warn с employeeId, свободный → info; пустой список — тишина', async () => {
    const entries: Array<{ level: string; message: string; details?: unknown }> = [];
    const log = { runId: 'r', log: vi.fn(async (e: never) => { entries.push(e); }), finish: vi.fn() } as unknown as IMtsSyncRunLogger;
    await logFioChanges(log, 'acc', [
      { msisdn: '79000000001', oldFio: 'Иванов', newFio: 'Петров', linkedEmployeeId: 42 },
      { msisdn: '79000000002', oldFio: 'Сидоров', newFio: 'Кузнецов', linkedEmployeeId: null },
    ]);
    expect(entries[0]).toMatchObject({
      level: 'warn',
      message: 'ФИО в МТС изменилось у привязанного номера',
      details: { fio: { old: 'Иванов', new: 'Петров' }, employeeId: 42 },
    });
    expect(entries[1]).toMatchObject({ level: 'info', details: { fio: { old: 'Сидоров', new: 'Кузнецов' } } });
    await logFioChanges(log, 'acc', undefined);
    expect(entries).toHaveLength(2);
  });
});
