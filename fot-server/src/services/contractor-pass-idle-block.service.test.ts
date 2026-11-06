/**
 * Автоблокировка: решения по каждому пропуску, остановки прогона, восстановление после сбоев и откат.
 * SQL очереди и отметок проверяется на PostgreSQL в contractor-pass-idle.pg.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/node';
import type { IIdlePassRow } from './contractor-pass-idle.service.js';

const h = vi.hoisted(() => {
  class BlacklistBlockedError extends Error {}
  return {
    BlacklistBlockedError,
    query: vi.fn(),
    queryOne: vi.fn(),
    clientQuery: vi.fn(),
    commitFailures: 0,
    fetchCandidates: vi.fn(),
    lockCandidate: vi.fn(),
    markUnblocked: vi.fn(),
    getEmployeeById: vi.fn(),
    blockEmployee: vi.fn(),
    unblockEmployee: vi.fn(),
    invalidateEmployeeCache: vi.fn(),
    invalidateDirectory: vi.fn(),
    blockInfo: vi.fn(),
    logWithClient: vi.fn(),
    guard: vi.fn(),
  };
});

vi.mock('../config/postgres.js', () => ({
  query: h.query,
  queryOne: h.queryOne,
  withTransaction: async (fn: (client: unknown) => Promise<unknown>) => {
    const value = await fn({ query: h.clientQuery });
    if (h.commitFailures > 0) {
      h.commitFailures -= 1;
      throw new Error('commit failed');
    }
    return value;
  },
}));
vi.mock('./contractor-pass-idle.service.js', () => ({
  IDLE_PASS_DAYS: 5,
  fetchIdleBlockCandidates: h.fetchCandidates,
  lockIdleBlockCandidate: h.lockCandidate,
  markContractorPassUnblocked: h.markUnblocked,
}));
vi.mock('./sigur.service.js', () => ({
  sigurService: {
    getBackgroundConnectionType: async () => 'internal',
    getEmployeeById: h.getEmployeeById,
    blockEmployee: h.blockEmployee,
    unblockEmployee: h.unblockEmployee,
    invalidateEmployeeCache: h.invalidateEmployeeCache,
  },
}));
vi.mock('./sigur-live-admin.service.js', () => ({
  invalidateSigurDirectoryCaches: h.invalidateDirectory,
}));
vi.mock('./sigur-employee-block.service.js', () => ({ getSigurEmployeeBlockInfo: h.blockInfo }));
vi.mock('./contractor-pool.service.js', () => ({
  isSigurNotFound: (error: { response?: { status?: number } }) =>
    error?.response?.status === 404 || error?.response?.status === 422,
}));
vi.mock('./blacklist.service.js', () => ({
  BlacklistBlockedError: h.BlacklistBlockedError,
  withSigurProfileGuard: h.guard,
}));
vi.mock('./audit.service.js', () => ({
  AUDIT_ACTIONS: { UPDATE_EMPLOYEE: 'UPDATE_EMPLOYEE', CONTRACTOR_POOL_SETTINGS_CHANGED: 'CONTRACTOR_POOL_SETTINGS_CHANGED' },
  auditService: { logWithClient: h.logWithClient },
}));

const {
  buildIdleBlockReason,
  IDLE_BLOCK_MAX_CONSECUTIVE_FAILURES,
  parseSigurBlocked,
  isIdleBlockNightlyEnabled,
  runContractorPassIdleBlock,
  setIdleBlockNightlyEnabled,
} = await import('./contractor-pass-idle-block.service.js');
const { rollbackContractorPassIdleRun } = await import('./contractor-pass-idle-rollback.service.js');

const candidate = (n: number, overrides: Partial<IIdlePassRow> = {}): IIdlePassRow => ({
  pass_id: `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`,
  holder_id: `holder-${n}`,
  org_department_id: '00000000-0000-0000-0000-0000000000a1',
  org_name: 'АЛЬЯНС ООО',
  pass_number: String(n),
  sigur_employee_id: 1000 + n,
  holder_name: `Держатель ${n}`,
  issued_on: '2026-06-10',
  last_event_date: '2026-06-11',
  last_access_point: 'КПП-1',
  days_idle: 147,
  idle_blocked_on: null,
  blocked_manually: false,
  ...overrides,
});

const queue = (count: number): IIdlePassRow[] => Array.from({ length: count }, (_, i) => candidate(i + 1));
const notFound = (): Error => Object.assign(new Error('Unprocessable'), { response: { status: 422 } });

/** Настройка ответов обычного query: дни событий, сверка, журнал партии. */
let eventDays: Array<{ day: string; events: number }>;
let walkedAfterMark: Array<{ pass_id: string; holder_id: string; sigur_employee_id: number }>;
let runAuditRows: Array<Record<string, string>>;

const auditDetails = (): Array<Record<string, unknown>> =>
  h.logWithClient.mock.calls.map(call => (call[1] as { details: Record<string, unknown> }).details);

const failureStamps = (): number =>
  h.query.mock.calls.filter(call => String(call[0]).includes('idle_block_failed_at = now()')).length;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  h.commitFailures = 0;
  eventDays = ['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04']
    .map(day => ({ day, events: 5000 }));
  walkedAfterMark = [];
  runAuditRows = [];
  h.query.mockImplementation(async (sql: string) => {
    if (sql.includes('generate_series')) return eventDays;
    if (sql.includes('m.marked_at')) return walkedAfterMark;
    if (sql.includes(`a.details->>'run_id'`)) return runAuditRows;
    return [];
  });
  h.clientQuery.mockResolvedValue({ rows: [], rowCount: 1 });
  h.lockCandidate.mockResolvedValue(true);
  h.getEmployeeById.mockResolvedValue({ isBlocked: false });
  h.blockEmployee.mockResolvedValue(undefined);
  h.unblockEmployee.mockResolvedValue(undefined);
  h.blockInfo.mockResolvedValue(null);
  h.logWithClient.mockResolvedValue(undefined);
  h.fetchCandidates.mockResolvedValue([]);
  h.guard.mockImplementation(async (_id: number, action: (client: unknown) => Promise<unknown>) =>
    action({ query: h.clientQuery }));
});

describe('parseSigurBlocked', () => {
  it.each([
    [true, true], [false, false], [1, true], [0, false], ['true', true], [' False ', false], ['1', true],
    [undefined, null], [null, null], ['', null], ['maybe', null],
  ])('%o → %o', (value, expected) => {
    expect(parseSigurBlocked(value)).toBe(expected);
  });
});

describe('buildIdleBlockReason', () => {
  it('с проходом и без', () => {
    expect(buildIdleBlockReason({ last_event_date: '2026-06-11', issued_on: '2026-06-10' }))
      .toBe('Автоблокировка: не ходит больше 5 дней (последний проход 11.06.2026)');
    expect(buildIdleBlockReason({ last_event_date: null, issued_on: '2026-06-10' }))
      .toBe('Автоблокировка: не ходит больше 5 дней (проходов не было, выдан 10.06.2026)');
  });
});

describe('обработка пропуска', () => {
  it('не заблокирован: журнал с причиной и run_id, отметка, Sigur последним', async () => {
    h.fetchCandidates.mockResolvedValue([candidate(80)]);

    const result = await runContractorPassIdleBlock({ dryRun: false, triggeredBy: 'scheduler' });

    expect(result).toMatchObject({ status: 'completed', blocked: 1, totalCandidates: 1, selected: 1 });
    expect(auditDetails()[0]).toMatchObject({
      action: 'block',
      reason: 'Автоблокировка: не ходит больше 5 дней (последний проход 11.06.2026)',
      source: 'contractor_pass_idle',
      mode: 'blocked',
      run_id: result.runId,
      pass_id: candidate(80).pass_id,
      holder_id: 'holder-80',
    });
    expect(h.logWithClient.mock.calls[0][1]).toMatchObject({
      user_id: null, entity_type: 'sigur_employee', entity_id: '1080',
    });
    expect(h.clientQuery).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtext($1))', ['blacklist:sigur:1080']);
    const holderUpdate = h.clientQuery.mock.calls.find(call => String(call[0]).includes('UPDATE contractor_pass_holders'));
    expect(String(holderUpdate?.[0])).toContain('idle_blocked_at = now()');
    expect(h.blockEmployee).toHaveBeenCalledWith(1080, 'internal');
    const lastClientQuery = Math.max(...h.clientQuery.mock.invocationCallOrder);
    expect(lastClientQuery).toBeLessThan(h.blockEmployee.mock.invocationCallOrder[0]);
    expect(h.invalidateEmployeeCache).toHaveBeenCalledTimes(1);
  });

  it('заблокирован вручную с причиной: без журнала и idle_blocked_at, только чужая отметка', async () => {
    h.fetchCandidates.mockResolvedValue([candidate(1)]);
    h.getEmployeeById.mockResolvedValue({ isBlocked: true });
    h.blockInfo.mockResolvedValue({ blockedAt: '2026-10-01', blockedByName: 'Гладкая', reason: 'отсутствие более 5 дней' });

    const result = await runContractorPassIdleBlock({ dryRun: false, triggeredBy: 'cli' });

    expect(result).toMatchObject({ alreadyManual: 1, blocked: 0, reasonAdded: 0 });
    expect(h.logWithClient).not.toHaveBeenCalled();
    expect(h.blockEmployee).not.toHaveBeenCalled();
    const holderUpdate = h.clientQuery.mock.calls.find(call => String(call[0]).includes('UPDATE contractor_pass_holders'));
    expect(String(holderUpdate?.[0])).toContain('external_blocked_seen_at = now()');
    expect(String(holderUpdate?.[0])).not.toContain('idle_blocked_at = now()');
    expect(h.clientQuery.mock.calls.some(call => String(call[0]).includes('is_active = false'))).toBe(true);
  });

  it('заблокирован без причины: причина и отметка, вызова Sigur нет', async () => {
    h.fetchCandidates.mockResolvedValue([candidate(1)]);
    h.getEmployeeById.mockResolvedValue({ isBlocked: true });
    h.blockInfo.mockResolvedValue({ blockedAt: '2026-05-01', blockedByName: 'Гладкая', reason: null });

    const result = await runContractorPassIdleBlock({ dryRun: false, triggeredBy: 'cli' });

    expect(result).toMatchObject({ reasonAdded: 1, blocked: 0 });
    expect(auditDetails()[0]).toMatchObject({ action: 'block', mode: 'reason_only' });
    expect(h.blockEmployee).not.toHaveBeenCalled();
  });

  it('Sigur заблокировал, COMMIT упал: следующий запуск восстанавливает БД и журнал без второй блокировки', async () => {
    h.fetchCandidates.mockResolvedValue([candidate(1)]);
    h.commitFailures = 1;

    const first = await runContractorPassIdleBlock({ dryRun: false, triggeredBy: 'cli' });

    expect(first).toMatchObject({ blocked: 0 });
    expect(first.failed).toHaveLength(1);
    expect(h.blockEmployee).toHaveBeenCalledTimes(1);

    // Журнал откатился вместе с транзакцией, профиль в Sigur заблокирован.
    h.logWithClient.mockClear();
    h.getEmployeeById.mockResolvedValue({ isBlocked: true });
    h.blockInfo.mockResolvedValue(null);

    const second = await runContractorPassIdleBlock({ dryRun: false, triggeredBy: 'cli' });

    expect(second).toMatchObject({ reasonAdded: 1 });
    expect(second.failed).toHaveLength(0);
    expect(auditDetails()[0]).toMatchObject({ action: 'block', mode: 'reason_only' });
    expect(h.blockEmployee).toHaveBeenCalledTimes(1);
  });

  it('сбой Sigur: ошибка из транзакции (запись откатится), прогон идёт дальше', async () => {
    h.fetchCandidates.mockResolvedValue([candidate(1), candidate(2)]);
    h.blockEmployee.mockRejectedValueOnce(new Error('Sigur unavailable'));

    const result = await runContractorPassIdleBlock({ dryRun: false, triggeredBy: 'cli' });

    expect(result.failed).toEqual([{ passNumber: '1', error: 'Sigur unavailable' }]);
    expect(result).toMatchObject({ blocked: 1, status: 'completed' });
    expect(failureStamps()).toBe(1);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('перепроверка под локом не прошла: changed, без чтения Sigur и записи', async () => {
    h.fetchCandidates.mockResolvedValue([candidate(1)]);
    h.lockCandidate.mockResolvedValue(false);

    const result = await runContractorPassIdleBlock({ dryRun: false, triggeredBy: 'cli' });

    expect(result.changed).toEqual(['1']);
    expect(h.getEmployeeById).not.toHaveBeenCalled();
    expect(h.logWithClient).not.toHaveBeenCalled();
    expect(h.blockEmployee).not.toHaveBeenCalled();
    expect(h.lockCandidate).toHaveBeenCalledWith(
      expect.anything(),
      { orgDepartmentId: candidate(1).org_department_id, passId: candidate(1).pass_id, holderId: 'holder-1' },
      expect.any(String),
    );
  });

  it('потеря lease: остановка до следующего пропуска, статус partial', async () => {
    h.fetchCandidates.mockResolvedValue(queue(3));
    let checks = 0;

    const result = await runContractorPassIdleBlock({
      dryRun: false,
      triggeredBy: 'scheduler',
      shouldAbort: () => { checks += 1; return checks > 1; },
    });

    expect(result).toMatchObject({ status: 'partial', aborted: true, blocked: 1 });
  });
});

describe('dry-run', () => {
  it('ничего не пишет и отдаёт список', async () => {
    h.fetchCandidates.mockResolvedValue(queue(2));

    const result = await runContractorPassIdleBlock({ dryRun: true, triggeredBy: 'cli' });

    expect(result).toMatchObject({ dryRun: true, status: 'completed', totalCandidates: 2, selected: 2, blocked: 0 });
    expect(result.candidates).toHaveLength(2);
    expect(h.lockCandidate).not.toHaveBeenCalled();
    expect(h.logWithClient).not.toHaveBeenCalled();
    expect(h.blockEmployee).not.toHaveBeenCalled();
  });

  it('очередь больше 300: показывает её и статус, без сигнала в Sentry', async () => {
    h.fetchCandidates.mockResolvedValue(queue(301));

    const result = await runContractorPassIdleBlock({ dryRun: true, triggeredBy: 'cli' });

    expect(result).toMatchObject({ status: 'mass_stop', totalCandidates: 301 });
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });
});

describe('предел очереди и проверка событий', () => {
  it('--limit 20 при очереди 2244: записано не больше 20, отчёт показывает оба числа', async () => {
    h.fetchCandidates.mockResolvedValue(queue(2244));

    const result = await runContractorPassIdleBlock({ dryRun: false, limit: 20, triggeredBy: 'cli' });

    expect(result).toMatchObject({ status: 'completed', totalCandidates: 2244, selected: 20, blocked: 20 });
    expect(h.blockEmployee).toHaveBeenCalledTimes(20);
  });

  it('очередь больше 300 без limit: стоп без записи и сигнал; с force идёт', async () => {
    h.fetchCandidates.mockResolvedValue(queue(301));

    const stopped = await runContractorPassIdleBlock({ dryRun: false, triggeredBy: 'scheduler' });

    expect(stopped).toMatchObject({ status: 'mass_stop', totalCandidates: 301, blocked: 0 });
    expect(h.blockEmployee).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'contractor_pass_idle_block_mass_stop', expect.objectContaining({ level: 'warning' }),
    );

    const forced = await runContractorPassIdleBlock({ dryRun: false, force: true, triggeredBy: 'cli' });
    expect(forced).toMatchObject({ status: 'completed', blocked: 301 });
  });

  it('--limit 500 без force: тоже стоп; ровно 300 проходит', async () => {
    h.fetchCandidates.mockResolvedValue(queue(600));
    expect(await runContractorPassIdleBlock({ dryRun: false, limit: 500, triggeredBy: 'cli' }))
      .toMatchObject({ status: 'mass_stop', blocked: 0 });
    expect(await runContractorPassIdleBlock({ dryRun: false, limit: 300, triggeredBy: 'cli' }))
      .toMatchObject({ status: 'completed', blocked: 300 });
  });

  it('день с малым числом проходов: стоп до сверки и очереди, force не снимает', async () => {
    eventDays[2] = { day: '2026-11-02', events: 99 };
    h.fetchCandidates.mockResolvedValue(queue(5));
    walkedAfterMark = [{ pass_id: 'p', holder_id: 'h', sigur_employee_id: 1 }];

    const result = await runContractorPassIdleBlock({ dryRun: false, force: true, triggeredBy: 'cli' });

    expect(result).toMatchObject({ status: 'events_gap', blocked: 0, restored: 0 });
    expect(result.eventGaps).toEqual([{ day: '2026-11-02', events: 99 }]);
    expect(h.fetchCandidates).not.toHaveBeenCalled();
    expect(h.getEmployeeById).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'contractor_pass_idle_block_events_gap', expect.anything(),
    );
  });

  it('день без единой строки: запрос считает ожидаемые даты, 0 останавливает', async () => {
    eventDays[0] = { day: '2026-10-31', events: 0 };

    const result = await runContractorPassIdleBlock({ dryRun: false, triggeredBy: 'scheduler' });

    expect(result.status).toBe('events_gap');
    const sql = String(h.query.mock.calls.find(call => String(call[0]).includes('generate_series'))?.[0]);
    expect(sql).toContain('CROSS JOIN LATERAL');
  });

  it('ровно 100 проходов: не дыра', async () => {
    eventDays = eventDays.map(day => ({ ...day, events: 100 }));
    expect((await runContractorPassIdleBlock({ dryRun: false, triggeredBy: 'scheduler' })).status).toBe('completed');
  });
});

describe('ошибки', () => {
  it('21 удалённый профиль: skipped, счётчик подряд не растёт, прогон доходит до остальных', async () => {
    h.fetchCandidates.mockResolvedValue(queue(25));
    for (let i = 0; i < 21; i += 1) h.getEmployeeById.mockRejectedValueOnce(notFound());

    const result = await runContractorPassIdleBlock({ dryRun: false, triggeredBy: 'cli' });

    expect(result.skipped).toHaveLength(21);
    expect(result.failed).toHaveLength(0);
    expect(result).toMatchObject({ status: 'completed', blocked: 4, stoppedOnFailures: false });
    expect(failureStamps()).toBe(21);
  });

  it('422 на записи — настоящая ошибка, а не удалённый профиль', async () => {
    h.fetchCandidates.mockResolvedValue([candidate(1)]);
    h.blockEmployee.mockRejectedValueOnce(notFound());

    const result = await runContractorPassIdleBlock({ dryRun: false, triggeredBy: 'cli' });

    expect(result.skipped).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
  });

  it('20 временных ошибок подряд: стоп, partial, у всех отметка для конца очереди', async () => {
    h.fetchCandidates.mockResolvedValue(queue(30));
    h.getEmployeeById.mockRejectedValue(new Error('Sigur down'));

    const result = await runContractorPassIdleBlock({ dryRun: false, triggeredBy: 'scheduler' });

    expect(result).toMatchObject({ status: 'partial', stoppedOnFailures: true });
    expect(result.failed).toHaveLength(IDLE_BLOCK_MAX_CONSECUTIVE_FAILURES);
    expect(failureStamps()).toBe(IDLE_BLOCK_MAX_CONSECUTIVE_FAILURES);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('успех сбрасывает счётчик подряд', async () => {
    h.fetchCandidates.mockResolvedValue(queue(40));
    for (let round = 0; round < 2; round += 1) {
      for (let i = 0; i < 19; i += 1) h.getEmployeeById.mockRejectedValueOnce(new Error('Sigur down'));
      h.getEmployeeById.mockResolvedValueOnce({ isBlocked: false });
    }

    const result = await runContractorPassIdleBlock({ dryRun: false, triggeredBy: 'cli' });

    expect(result.stoppedOnFailures).toBe(false);
    expect(result.failed).toHaveLength(38);
    expect(result.status).toBe('completed');
  });
});

describe('сверка разблокировок', () => {
  const walked = { pass_id: 'pass-9', holder_id: 'holder-9', sigur_employee_id: 1009 };

  it('разблокирован в клиенте Sigur: журнал и отметки одной транзакцией, ДО снимка очереди', async () => {
    walkedAfterMark = [walked];
    h.getEmployeeById.mockResolvedValue({ isBlocked: false });

    const result = await runContractorPassIdleBlock({ dryRun: false, triggeredBy: 'scheduler' });

    expect(result.restored).toBe(1);
    expect(auditDetails()[0]).toMatchObject({ action: 'unblock', source: 'sigur_direct', pass_id: 'pass-9' });
    expect(h.markUnblocked).toHaveBeenCalledWith(expect.anything(), 1009);
    expect(h.markUnblocked.mock.invocationCallOrder[0]).toBeLessThan(h.fetchCandidates.mock.invocationCallOrder[0]);
  });

  it('всё ещё заблокирован или ответ непонятен: отметки остаются', async () => {
    walkedAfterMark = [walked, { ...walked, sigur_employee_id: 1010 }];
    h.getEmployeeById.mockResolvedValueOnce({ isBlocked: true }).mockResolvedValueOnce({});

    const result = await runContractorPassIdleBlock({ dryRun: false, triggeredBy: 'scheduler' });

    expect(result.restored).toBe(0);
    expect(h.markUnblocked).not.toHaveBeenCalled();
  });

  it('dry-run только считает', async () => {
    walkedAfterMark = [walked];

    const result = await runContractorPassIdleBlock({ dryRun: true, triggeredBy: 'cli' });

    expect(result.restored).toBe(1);
    expect(h.markUnblocked).not.toHaveBeenCalled();
    expect(h.logWithClient).not.toHaveBeenCalled();
  });

  it('сбой чтения одного профиля не останавливает прогон', async () => {
    walkedAfterMark = [walked];
    h.getEmployeeById.mockRejectedValueOnce(new Error('Sigur down'));
    h.fetchCandidates.mockResolvedValue([candidate(1)]);

    const result = await runContractorPassIdleBlock({ dryRun: false, triggeredBy: 'scheduler' });

    expect(result).toMatchObject({ restored: 0, blocked: 1 });
  });
});

describe('откат партии', () => {
  const RUN_ID = '11111111-1111-1111-1111-111111111111';
  const auditRow = (n: number, mode = 'blocked'): Record<string, string> => ({
    id: String(n),
    sigur_employee_id: String(1000 + n),
    pass_id: `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`,
    holder_id: `holder-${n}`,
    pass_number: String(n),
    mode,
  });

  /** Ответы проверок под локом: последняя запись журнала и строка держателя. */
  const stubChecks = (lastAuditId: string | null, holderFound = true): void => {
    h.clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM audit_logs')) return { rows: lastAuditId ? [{ id: lastAuditId }] : [] };
      if (sql.includes('FROM contractor_passes p')) return { rows: holderFound ? [{ id: 'h' }] : [] };
      return { rows: [], rowCount: 1 };
    });
  };

  it('снимает запись своей партии: журнал и отметки до Sigur', async () => {
    runAuditRows = [auditRow(1)];
    stubChecks('1');

    const result = await rollbackContractorPassIdleRun({ runId: RUN_ID, dryRun: false });

    expect(result).toMatchObject({ total: 1, unblocked: 1 });
    expect(auditDetails()[0]).toMatchObject({
      action: 'unblock', source: 'contractor_pass_idle_rollback', run_id: RUN_ID,
    });
    expect(h.markUnblocked).toHaveBeenCalledWith(expect.anything(), 1001);
    expect(h.unblockEmployee).toHaveBeenCalledWith(1001, 'internal');
    expect(h.markUnblocked.mock.invocationCallOrder[0]).toBeLessThan(h.unblockEmployee.mock.invocationCallOrder[0]);
    expect(h.invalidateEmployeeCache).toHaveBeenCalledTimes(1);
    const auditQuery = h.query.mock.calls.find(call => String(call[0]).includes(`a.details->>'run_id'`));
    expect(auditQuery?.[1]).toEqual(['contractor_pass_idle', RUN_ID]);
  });

  it('ручная блокировка, разблокировка или повторный откат после партии: later_action, Sigur не трогаем', async () => {
    runAuditRows = [auditRow(1)];
    stubChecks('777');

    const result = await rollbackContractorPassIdleRun({ runId: RUN_ID, dryRun: false });

    expect(result.unblocked).toBe(0);
    expect(result.skipped.later_action).toEqual(['1']);
    expect(h.unblockEmployee).not.toHaveBeenCalled();
    expect(h.logWithClient).not.toHaveBeenCalled();
  });

  it('сменился держатель: holder_changed', async () => {
    runAuditRows = [auditRow(1)];
    stubChecks('1', false);

    const result = await rollbackContractorPassIdleRun({ runId: RUN_ID, dryRun: false });

    expect(result.skipped.holder_changed).toEqual(['1']);
    expect(h.unblockEmployee).not.toHaveBeenCalled();
  });

  it('человек в чёрном списке: не снимаем', async () => {
    runAuditRows = [auditRow(1)];
    h.guard.mockRejectedValueOnce(new h.BlacklistBlockedError('в чёрном списке'));

    const result = await rollbackContractorPassIdleRun({ runId: RUN_ID, dryRun: false });

    expect(result.skipped.blacklisted).toEqual(['1']);
    expect(h.unblockEmployee).not.toHaveBeenCalled();
  });

  it('партия только дописала причину: в Sigur не разблокируем', async () => {
    runAuditRows = [auditRow(1, 'reason_only')];

    const result = await rollbackContractorPassIdleRun({ runId: RUN_ID, dryRun: false });

    expect(result).toMatchObject({ reasonOnly: 1, unblocked: 0 });
    expect(h.guard).not.toHaveBeenCalled();
    expect(h.unblockEmployee).not.toHaveBeenCalled();
  });

  it('dry-run считает, но не пишет', async () => {
    runAuditRows = [auditRow(1)];
    stubChecks('1');

    const result = await rollbackContractorPassIdleRun({ runId: RUN_ID, dryRun: true });

    expect(result.unblocked).toBe(1);
    expect(h.logWithClient).not.toHaveBeenCalled();
    expect(h.markUnblocked).not.toHaveBeenCalled();
    expect(h.unblockEmployee).not.toHaveBeenCalled();
    expect(h.invalidateEmployeeCache).not.toHaveBeenCalled();
  });

  it('сбой Sigur по одному: в отчёт, остальные снимаются', async () => {
    runAuditRows = [auditRow(1), auditRow(2)];
    h.clientQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM audit_logs')) return { rows: [{ id: params?.[0] === '1001' ? '1' : '2' }] };
      if (sql.includes('FROM contractor_passes p')) return { rows: [{ id: 'h' }] };
      return { rows: [], rowCount: 1 };
    });
    h.unblockEmployee.mockRejectedValueOnce(new Error('Sigur down'));

    const result = await rollbackContractorPassIdleRun({ runId: RUN_ID, dryRun: false });

    expect(result.failed).toEqual([{ passNumber: '1', error: 'Sigur down' }]);
    expect(result.unblocked).toBe(1);
  });
});

describe('выключатель ночного прогона', () => {
  it.each([
    [{ value: 'true' }, true],
    [{ value: 'false' }, false],
    [{ value: null }, false],
    [null, false],
  ])('%o → %s', async (row, expected) => {
    h.queryOne.mockResolvedValueOnce(row);
    expect(await isIdleBlockNightlyEnabled()).toBe(expected);
  });

  it('включение пишет настройку и журнал; настройки нет — ошибка, а не молчаливое «включено»', async () => {
    await setIdleBlockNightlyEnabled(true);
    expect(h.clientQuery).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE system_settings'),
      ['true', 'contractor_pass_idle_block_enabled'],
    );
    expect(h.logWithClient.mock.calls[0][1]).toMatchObject({ entity_type: 'system_setting', details: { value: true } });

    h.clientQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(setIdleBlockNightlyEnabled(true)).rejects.toThrow('миграция 349');
  });
});
