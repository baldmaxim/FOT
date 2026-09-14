import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Логика шагов операции и воркера на in-memory модели таблицы: переходы так же
// атомарны (проверка from/аренды/поколения и запись — синхронно, без await между
// ними), как UPDATE … RETURNING в БД; commit откатывает переход, если записи упали.
// SQL-семантика — в *.pg.test.ts.

const store = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  bindings: new Map<string, { msisdn: string | null; employeeId: number | null; accountId: string | null }>(),
  seq: 0,
  quotaMax: 5,
}));

vi.mock('../middleware/rateLimit.js', () => ({ FORWARDING_CHANGES_PER_HOUR: 5 }));

vi.mock('./mts-forwarding-operations.service.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./mts-forwarding-operations.service.js')>();
  const iso = (offsetSec = 0): string => new Date(Date.now() + offsetSec * 1000).toISOString();
  const copy = (r: Record<string, unknown> | undefined) => (r ? structuredClone(r) : null) as never;
  const leaseFree = (r: Record<string, unknown>, owner?: string): boolean =>
    r.leaseUntil == null || new Date(String(r.leaseUntil)).getTime() < Date.now() || (owner != null && r.leaseOwner === owner);
  const ACTIVE = (s: unknown): boolean => !orig.FINAL_OPERATION_STATES.includes(s as never);

  const guardPasses = (r: Record<string, unknown>, from: readonly string[], guard: { owner?: string; expect?: { generation: number; action: unknown } } = {}) =>
    from.includes(String(r.state))
    && (!guard.owner || r.leaseOwner === guard.owner)
    && (!guard.expect || (r.sendGeneration === guard.expect.generation && (r.ruleAction ?? null) === (guard.expect.action ?? null)));

  const apply = (r: Record<string, unknown>, patch: Record<string, unknown>): void => {
    if (patch.state) { r.state = patch.state; if (orig.isOperationFinal(patch.state as never)) r.finishedAt = iso(); }
    for (const key of ['serviceEventId', 'ruleEventId', 'ruleAction', 'confirmedRules', 'unconfirmedFrom'] as const) {
      if (patch[key] !== undefined) r[key] = patch[key];
    }
    if (patch.resetRuleAttempts) r.ruleAttempts = 0;
    if (patch.lease === null) { r.leaseOwner = null; r.leaseUntil = null; }
    if (patch.deadlineSeconds !== undefined) r.deadlineAt = iso(Number(patch.deadlineSeconds));
    if (patch.nextCheckSeconds !== undefined) r.nextCheckAt = iso(Number(patch.nextCheckSeconds));
    if (patch.error === null) { r.lastErrorCode = null; r.lastErrorMessage = null; }
    else if (patch.error) { const e = patch.error as { code: string; message: string }; r.lastErrorCode = e.code; r.lastErrorMessage = e.message; }
    r.updatedAt = iso();
  };

  const fake = {
    async reserve(input: Record<string, unknown>) {
      const hash = `h:${String(input.msisdn)}`;
      const active = [...store.rows.values()].find(r => r.accountId === input.accountId && r.msisdnHash === hash && ACTIVE(r.state));
      if (active) return { operation: copy(active), created: false };
      const id = `op-${++store.seq}`;
      const row = {
        id, kind: input.kind, accountId: input.accountId, msisdnHash: hash, employeeId: input.employeeId, requestedBy: input.requestedBy,
        forwardingType: input.forwardingType, target: input.target, noReplyTimer: input.noReplyTimer,
        state: input.initialState, serviceEventId: null, ruleEventId: null, ruleAction: null, ruleAttempts: 0, sendGeneration: 0,
        sendStartedAt: null, leaseOwner: null, leaseUntil: null, deadlineAt: iso(Number(input.deadlineSeconds)), nextCheckAt: iso(30),
        confirmedRules: null, quotaCountedAt: null, unconfirmedFrom: null, lastErrorCode: null, lastErrorMessage: null,
        createdAt: iso(), updatedAt: iso(), finishedAt: null,
      };
      store.rows.set(id, row);
      return { operation: copy(row), created: true };
    },
    async getById(id: string) { return copy(store.rows.get(id)); },
    async getActive(accountId: string, hash: string) {
      return copy([...store.rows.values()].find(r => r.accountId === accountId && r.msisdnHash === hash && ACTIVE(r.state)));
    },
    async transition(id: string, from: readonly string[], patch: Record<string, unknown>, guard?: { owner?: string; expect?: { generation: number; action: unknown } }) {
      const r = store.rows.get(id);
      if (!r || !guardPasses(r, from, guard)) return null;
      apply(r, patch);
      return copy(r);
    },
    async commit(
      id: string, from: readonly string[], patch: Record<string, unknown>,
      guard: { owner?: string; expect?: { generation: number; action: unknown } },
      writes: (client: unknown, op: unknown) => Promise<void>,
    ) {
      const r = store.rows.get(id);
      if (!r || !guardPasses(r, from, guard)) return null;
      const before = structuredClone(r);
      apply(r, patch);
      try {
        await writes({ fake: 'client' }, copy(r));
      } catch (error) {
        store.rows.set(id, before); // откат транзакции
        throw error;
      }
      return copy(r);
    },
    async claimSend(id: string, from: string, to: string, owner: string, action: unknown = null) {
      const r = store.rows.get(id);
      if (!r || r.state !== from || !leaseFree(r, owner)) return null;
      r.state = to; r.sendStartedAt = iso(); r.leaseOwner = owner; r.leaseUntil = iso(orig.SEND_LEASE_SECONDS);
      r.ruleAction = action; r.sendGeneration = Number(r.sendGeneration) + 1;
      if (to !== 'service_sending') r.ruleAttempts = Number(r.ruleAttempts) + 1;
      return copy(r);
    },
    async consumeQuota(id: string, userId: string, max: number) {
      const r = store.rows.get(id);
      if (!r) return false;
      if (r.quotaCountedAt) return true;
      const used = [...store.rows.values()].filter(x => x.requestedBy === userId && x.quotaCountedAt).length;
      if (used >= max) return false;
      r.quotaCountedAt = iso();
      return true;
    },
    async claimDue(owner: string, limit: number, leaseSeconds: number) {
      const due = [...store.rows.values()]
        .filter(r => orig.DUE_OPERATION_STATES.includes(r.state as never)
          && new Date(String(r.nextCheckAt)).getTime() <= Date.now() && leaseFree(r))
        .slice(0, limit);
      for (const r of due) { r.leaseOwner = owner; r.leaseUntil = iso(leaseSeconds); }
      return due.map(r => copy(r));
    },
    async recoverStale() {
      let n = 0;
      for (const r of store.rows.values()) {
        const map: Record<string, string> = { service_sending: 'service_unknown', rule_sending: 'rule_verifying', rule_clear_sending: 'rule_clear_verifying' };
        if (map[String(r.state)] && new Date(String(r.leaseUntil)).getTime() < Date.now()) {
          r.state = map[String(r.state)];
          r.leaseOwner = null; r.leaseUntil = null; r.nextCheckAt = iso(); n++;
        }
      }
      return n;
    },
    async getNumberBinding(hash: string) { return store.bindings.get(hash) ?? null; },
  };
  return { ...orig, mtsForwardingOperationsService: fake };
});

vi.mock('./mts-business-catalog.service.js', () => ({
  mtsBusinessCatalogService: {
    modifyProduct: vi.fn(),
    postCallForwarding: vi.fn(),
    verifyCallForwardingWith: vi.fn(async () => null),
    getCallForwarding: vi.fn(async () => []),
    getProductInfo: vi.fn(async () => []),
    checkModifyProductStatus: vi.fn(async () => ({ status: 'unknown', raw: null })),
  },
}));
vi.mock('./mts-business-actions.service.js', () => ({
  mtsBusinessActionsService: { create: vi.fn(async () => undefined), createCompletedWithClient: vi.fn(async () => undefined) },
}));
vi.mock('./mts-business-metrics-store.service.js', () => ({
  mtsBusinessMetricsStoreService: { upsertSnapshot: vi.fn(async () => undefined), upsertSnapshotWithClient: vi.fn(async () => undefined) },
}));
vi.mock('./audit.service.js', () => ({
  auditService: { log: vi.fn(async () => undefined), logWithClient: vi.fn(async () => undefined) },
  AUDIT_ACTIONS: {
    MTS_BUSINESS_SERVICE_ADD_REQUESTED: 'MTS_BUSINESS_SERVICE_ADD_REQUESTED',
    MTS_BUSINESS_FORWARDING_SET_REQUESTED: 'MTS_BUSINESS_FORWARDING_SET_REQUESTED',
    MTS_BUSINESS_FORWARDING_REMOVE_REQUESTED: 'MTS_BUSINESS_FORWARDING_REMOVE_REQUESTED',
  },
}));
vi.mock('../config/postgres.js', () => ({ query: vi.fn(), queryOne: vi.fn(), execute: vi.fn(), withTransaction: vi.fn() }));
vi.mock('./sigur-runtime-state.service.js', () => ({ getSigurRuntimeOwner: (s: string) => `${s}:test` }));

import { mtsForwardingOperationsService as ops, type IForwardingOperation } from './mts-forwarding-operations.service.js';
import { sendServiceRequest, stepRule, verifyClear } from './mts-forwarding-operations.runner.js';
import { runRuleCyclesNow } from './mts-forwarding-operations.flow.js';
import { runForwardingOperationsTick } from './mts-forwarding-operations.worker.js';
import { mtsBusinessCatalogService } from './mts-business-catalog.service.js';
import { mtsBusinessMetricsStoreService } from './mts-business-metrics-store.service.js';
import { auditService } from './audit.service.js';
import { MtsBusinessApiError } from './mts-business-base.service.js';

const catalog = vi.mocked(mtsBusinessCatalogService);
const metrics = vi.mocked(mtsBusinessMetricsStoreService);
const audit = vi.mocked(auditService);

const MSISDN = '79150000001';
const HASH = `h:${MSISDN}`;
const TARGET = '79161234567';
const PE0250 = [{ code: 'PE0250', name: 'Переадресация вызова (периодическая)', status: 'ACTIVE' }] as never;
type Rule = { forwardingType: string; forwardingAddress: string | null; noReplyTimer: number | null; numType: string; status: null };
const rule = (forwardingType: string, over: Partial<Rule> = {}): Rule => ({
  forwardingType, forwardingAddress: TARGET, noReplyTimer: 0, numType: 'Regular', status: null, ...over,
});

/**
 * Модель правил МТС: POST меняет список (как на живом контуре), GET отдаёт текущий.
 * При активном CFU условная переадресация «принимается», но не применяется.
 */
let mtsRules: Rule[] = [];
const installMtsModel = (): void => {
  catalog.getCallForwarding.mockImplementation(async () => structuredClone(mtsRules) as never);
  catalog.verifyCallForwardingWith.mockImplementation(async (_a, _m, predicate) => {
    const rules = structuredClone(mtsRules) as never;
    return predicate(rules) ? rules : null;
  });
  catalog.postCallForwarding.mockImplementation(async (_a, _m, action, opts) => {
    if (action === 'delete') {
      mtsRules = mtsRules.filter(r => r.forwardingType !== opts.forwardingType);
    } else {
      const cfuActive = mtsRules.some(r => r.forwardingType === 'CFU' && r.forwardingAddress);
      if (opts.forwardingType === 'CFU' || !cfuActive) {
        mtsRules = [...mtsRules.filter(r => r.forwardingType !== opts.forwardingType),
          rule(opts.forwardingType, { forwardingAddress: opts.forwardingAddress ?? null, noReplyTimer: opts.noReplyTimer ?? 0 })];
      }
    }
    return { eventId: null, resp: {} };
  });
};

let clock = new Date('2026-09-14T10:00:00Z').getTime();
const advance = (sec: number): void => { clock += sec * 1000; vi.setSystemTime(clock); };

const reserve = async (initialState: 'service_reserved' | 'rule_ready', over: Record<string, unknown> = {}) =>
  (await ops.reserve({
    kind: 'set', accountId: 'acc-1', msisdn: MSISDN, employeeId: 42, requestedBy: 'u-1', forwardingType: 'CFU', target: TARGET,
    noReplyTimer: null, initialState, deadlineSeconds: initialState === 'rule_ready' ? 1800 : 3600, ...over,
  } as never)).operation;

const row = (id: string): IForwardingOperation => store.rows.get(id) as unknown as IForwardingOperation;
const tick = (owner = 'w1') => runForwardingOperationsTick(`worker:${owner}`);
const posts = () => catalog.postCallForwarding.mock.calls.map(c => `${c[2]}:${c[3].forwardingType}`);

beforeEach(() => {
  vi.clearAllMocks();
  store.rows.clear();
  store.bindings.clear();
  store.bindings.set(HASH, { msisdn: MSISDN, employeeId: 42, accountId: 'acc-1' });
  clock = new Date('2026-09-14T10:00:00Z').getTime();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(clock);
  mtsRules = [];
  installMtsModel();
  catalog.getProductInfo.mockResolvedValue([]);
  catalog.checkModifyProductStatus.mockResolvedValue({ status: 'unknown', raw: null });
});
afterEach(() => { vi.useRealTimers(); });

describe('смена режима: снять мешающее → подтвердить → поставить → режим целиком', () => {
  const cases: Array<[string, Rule[], string, number | null, string[]]> = [
    ['CFU → CFNRY', [rule('CFU')], 'CFNRY', 20, ['delete:CFU', 'create:CFNRY']],
    ['CFU → CFNRC', [rule('CFU')], 'CFNRC', null, ['delete:CFU', 'create:CFNRC']],
    ['CFNRY → CFU', [rule('CFNRY', { noReplyTimer: 20 })], 'CFU', null, ['delete:CFNRY', 'create:CFU']],
    ['CFNRC → CFNRY', [rule('CFNRC')], 'CFNRY', 25, ['delete:CFNRC', 'create:CFNRY']],
  ];

  for (const [label, initial, type, timer, expected] of cases) {
    it(`${label}: два POST в нужном порядке, done, остался только выбранный режим`, async () => {
      mtsRules = initial;
      const op = await reserve('rule_ready', { forwardingType: type, noReplyTimer: timer });

      const after = await runRuleCyclesNow(op, 'http:a', MSISDN, 2);

      expect(posts()).toEqual(expected);
      expect(after.state).toBe('done');
      expect(mtsRules.map(r => r.forwardingType)).toEqual([type]);
      if (timer != null) expect(mtsRules[0].noReplyTimer).toBe(timer);
      // Аудит снятия и итоговой установки — внутри транзакций.
      expect(audit.logWithClient.mock.calls.map(c => (c[1] as { action: string }).action))
        .toEqual(['MTS_BUSINESS_FORWARDING_REMOVE_REQUESTED', 'MTS_BUSINESS_FORWARDING_SET_REQUESTED']);
    });
  }

  it('режим уже достигнут → done без POST и без квоты', async () => {
    mtsRules = [rule('CFNRY', { noReplyTimer: 20 }), rule('CFB', { forwardingAddress: '79160000000' })];
    const op = await reserve('rule_ready', { forwardingType: 'CFNRY', noReplyTimer: 20 });

    const after = await runRuleCyclesNow(op, 'http:a', MSISDN, 2);

    expect(after.state).toBe('done');
    expect(catalog.postCallForwarding).not.toHaveBeenCalled();
    expect(row(op.id).quotaCountedAt).toBeNull();
  });

  it('CFB не снимается и не мешает завершению', async () => {
    mtsRules = [rule('CFB', { forwardingAddress: '79160000000' }), rule('CFU')];
    const op = await reserve('rule_ready', { forwardingType: 'CFNRC' });

    const after = await runRuleCyclesNow(op, 'http:a', MSISDN, 2);

    expect(posts()).toEqual(['delete:CFU', 'create:CFNRC']);
    expect(after.state).toBe('done');
    expect(mtsRules.map(r => r.forwardingType)).toEqual(['CFB', 'CFNRC']);
  });

  it('отключение (remove): снимает CFNRY и CFNRC по одному, CFB остаётся, done', async () => {
    mtsRules = [rule('CFNRY', { noReplyTimer: 20 }), rule('CFNRC'), rule('CFB', { forwardingAddress: '79160000000' })];
    const op = await reserve('rule_ready', { kind: 'remove', forwardingType: 'CFNRY', target: null });

    const after = await runRuleCyclesNow(op, 'http:a', MSISDN, 3);

    expect(posts()).toEqual(['delete:CFNRY', 'delete:CFNRC']);
    expect(after.state).toBe('done');
    expect(mtsRules.map(r => r.forwardingType)).toEqual(['CFB']);
  });
});

describe('смена режима: сбои и восстановление', () => {
  it('чтение правил перед шагом падает → мутаций нет, повтор позже', async () => {
    catalog.getCallForwarding.mockRejectedValueOnce(new MtsBusinessApiError('bad gateway', 502));
    const op = await reserve('rule_ready', { forwardingType: 'CFNRY', noReplyTimer: 20 });

    const after = await stepRule(op, 'http:a', MSISDN);

    expect(catalog.postCallForwarding).not.toHaveBeenCalled();
    expect(after.state).toBe('rule_ready');
  });

  it('перезапуск во время снятия (rule_clear_sending, аренда истекла) → сверка, delete не повторяется; затем установка', async () => {
    mtsRules = [rule('CFU')];
    const op = await reserve('rule_ready', { forwardingType: 'CFNRC' });
    await ops.claimSend(op.id, 'rule_ready', 'rule_clear_sending', 'http:dead', 'delete:CFU');
    mtsRules = []; // POST успел уйти и примениться, ответ потерян
    advance(400);

    await tick();
    expect(row(op.id).state).toBe('rule_ready');
    await tick();
    advance(61); await tick();

    expect(posts()).toEqual(['create:CFNRC']);
    expect(row(op.id).state).toBe('done');
  });

  it('перезапуск после подтверждённого снятия (rule_ready) → воркер ставит новое правило', async () => {
    mtsRules = [rule('CFU')];
    const op = await reserve('rule_ready', { forwardingType: 'CFNRY', noReplyTimer: 20 });
    await stepRule(op, 'http:a', MSISDN);
    await verifyClear(row(op.id), undefined, MSISDN, true);
    expect(row(op.id).state).toBe('rule_ready');

    advance(1); await tick();
    advance(61); await tick();

    expect(posts()).toEqual(['delete:CFU', 'create:CFNRY']);
    expect(row(op.id).state).toBe('done');
  });

  it('запоздавшая проверка снятия (старое поколение) после начала установки: ни перехода, ни снимка, ни аудита', async () => {
    mtsRules = [rule('CFU')];
    const op = await reserve('rule_ready', { forwardingType: 'CFNRY', noReplyTimer: 20 });
    await stepRule(op, 'http:a', MSISDN);
    const staleClearView = structuredClone(row(op.id)); // rule_clear_verifying, поколение 1
    await verifyClear(row(op.id), undefined, MSISDN, true); // актуальная проверка → rule_ready
    // Воркер начал установку: новое поколение, состояние rule_verifying.
    await stepRule(row(op.id), 'worker:w1', MSISDN);
    expect(row(op.id).state).toBe('rule_verifying');
    vi.clearAllMocks();
    installMtsModel();

    // Запоздавший результат проверки снятия приходит только сейчас.
    Object.assign(staleClearView, { state: 'rule_clear_verifying' });
    await verifyClear(staleClearView as IForwardingOperation, undefined, MSISDN, false);

    expect(row(op.id).state).toBe('rule_verifying');
    expect(metrics.upsertSnapshotWithClient).not.toHaveBeenCalled();
    expect(audit.logWithClient).not.toHaveBeenCalled();
  });

  it('то же состояние, другое поколение: поздняя проверка первого снятия не трогает второе', async () => {
    mtsRules = [rule('CFNRY', { noReplyTimer: 20 }), rule('CFNRC')];
    const op = await reserve('rule_ready', { kind: 'remove', forwardingType: 'CFNRY', target: null });
    await stepRule(op, 'http:a', MSISDN);                       // delete:CFNRY, поколение 1
    const staleFirst = structuredClone(row(op.id));
    await verifyClear(row(op.id), undefined, MSISDN, true);     // → rule_ready
    await stepRule(row(op.id), 'http:a', MSISDN);               // delete:CFNRC, поколение 2
    expect(row(op.id)).toMatchObject({ state: 'rule_clear_verifying', sendGeneration: 2, ruleAction: 'delete:CFNRC' });
    vi.clearAllMocks();
    installMtsModel();

    await verifyClear(staleFirst as IForwardingOperation, undefined, MSISDN, false);

    expect(row(op.id)).toMatchObject({ state: 'rule_clear_verifying', sendGeneration: 2, ruleAction: 'delete:CFNRC' });
    expect(metrics.upsertSnapshotWithClient).not.toHaveBeenCalled();
    expect(audit.logWithClient).not.toHaveBeenCalled();
  });

  it('снятие прошло, установку МТС отклонил → failed, текст про снятую переадресацию, снимок фактических правил', async () => {
    mtsRules = [rule('CFU')];
    const op = await reserve('rule_ready', { forwardingType: 'CFNRY', noReplyTimer: 20 });
    catalog.postCallForwarding
      .mockImplementationOnce(async () => { mtsRules = []; return { eventId: null, resp: {} }; })
      .mockRejectedValueOnce(new MtsBusinessApiError('Недопустимый номер', 400, '2001'));

    const after = await runRuleCyclesNow(op, 'http:a', MSISDN, 2);

    expect(after.state).toBe('failed');
    expect(after.lastErrorMessage).toContain('Прежняя переадресация снята');
    expect(after.confirmedRules).toEqual([]);
    const snapshots = metrics.upsertSnapshotWithClient.mock.calls.map(c => c[1] as { metric: string; payload: unknown });
    expect(snapshots.at(-1)).toEqual(expect.objectContaining({ metric: 'forwarding', payload: [] }));
  });

  it('unknown на снятии → сверка без повторного delete', async () => {
    mtsRules = [rule('CFU')];
    catalog.postCallForwarding.mockRejectedValueOnce(new MtsBusinessApiError('timeout', 0));
    const op = await reserve('rule_ready', { forwardingType: 'CFNRC' });

    await stepRule(op, 'http:a', MSISDN);
    for (let i = 0; i < 3; i++) { advance(61); await tick(); }

    expect(posts()).toEqual(['delete:CFU']);
    expect(row(op.id).state).toBe('rule_clear_verifying');
  });

  it('отказ снятия (4xx) → failed «Не удалось снять текущую переадресацию»', async () => {
    mtsRules = [rule('CFU')];
    catalog.postCallForwarding.mockRejectedValueOnce(new MtsBusinessApiError('Запрещено', 400, '2002'));
    const op = await reserve('rule_ready', { forwardingType: 'CFNRC' });

    const after = await stepRule(op, 'http:a', MSISDN);

    expect(after.state).toBe('failed');
    expect(after.lastErrorMessage).toContain('Не удалось снять текущую переадресацию');
  });

  it('запись итогового снимка упала → транзакция откатывается, rule_confirmed, следующий тик доводит без мутаций', async () => {
    mtsRules = [rule('CFU')];
    const op = await reserve('rule_ready');
    metrics.upsertSnapshotWithClient.mockRejectedValueOnce(new Error('db down'));

    const after = await runRuleCyclesNow(op, 'http:a', MSISDN, 1);
    expect(after.state).toBe('rule_confirmed');

    advance(61); await tick();
    expect(row(op.id).state).toBe('done');
    expect(catalog.postCallForwarding).not.toHaveBeenCalled();
  });
});

describe('квота изменений (общая на включение и отключение)', () => {
  it('3 включения + 3 отключения при max=5 → шестая операция cancelled/rate_limited без мутаций', async () => {
    for (let i = 0; i < 6; i++) {
      const kind = i < 3 ? 'set' : 'remove';
      store.bindings.set(`h:7915000010${i}`, { msisdn: `7915000010${i}`, employeeId: 42, accountId: 'acc-1' });
      mtsRules = kind === 'set' ? [] : [rule('CFU')];
      const op = (await ops.reserve({
        kind, accountId: 'acc-1', msisdn: `7915000010${i}`, employeeId: 42, requestedBy: 'u-1', forwardingType: 'CFU',
        target: kind === 'set' ? TARGET : null, noReplyTimer: null, initialState: 'rule_ready', deadlineSeconds: 1800,
      })).operation;
      const after = await runRuleCyclesNow(op, 'http:a', `7915000010${i}`, 2);
      if (i < 5) expect(after.state).toBe('done');
      else {
        expect(after.state).toBe('cancelled');
        expect(after.lastErrorCode).toBe('rate_limited');
      }
    }
    expect(catalog.postCallForwarding).toHaveBeenCalledTimes(5);
  });
});

describe('подключение PE0250 и прежние гарантии', () => {
  it('контроллер и воркер одновременно → ModifyProduct ровно один раз', async () => {
    catalog.modifyProduct.mockResolvedValue({ eventId: 'EV-S' });
    const op = await reserve('service_reserved');

    await Promise.all([sendServiceRequest(op, 'http:a', MSISDN), sendServiceRequest(op, 'worker:b', MSISDN)]);

    expect(catalog.modifyProduct).toHaveBeenCalledTimes(1);
    expect(row(op.id).state).toBe('service_accepted');
  });

  it('тайм-аут ModifyProduct → service_unknown; срок истёк → unconfirmed; отправок больше нет', async () => {
    catalog.modifyProduct.mockRejectedValue(new MtsBusinessApiError('timeout of 20000ms exceeded', 0));
    const op = await reserve('service_reserved');

    expect((await sendServiceRequest(op, 'http:a', MSISDN)).state).toBe('service_unknown');
    for (let i = 0; i < 70; i++) { advance(61); await tick(); }

    expect(catalog.modifyProduct).toHaveBeenCalledTimes(1);
    expect(row(op.id).state).toBe('unconfirmed');
    expect(row(op.id).unconfirmedFrom).toBe('service_unknown');
  });

  it('услуга активировалась → CFU поверх пустых правил → done', async () => {
    catalog.modifyProduct.mockResolvedValue({ eventId: 'EV-S' });
    const op = await reserve('service_reserved');
    await sendServiceRequest(op, 'http:a', MSISDN);
    catalog.getProductInfo.mockResolvedValue(PE0250);

    advance(61); await tick(); // → rule_ready
    await tick();              // → POST create → rule_verifying
    advance(61); await tick(); // → done

    expect(posts()).toEqual(['create:CFU']);
    expect(row(op.id).state).toBe('done');
  });

  it('номер перепривязан до шага правила → cancelled, POST нет', async () => {
    mtsRules = [rule('CFU')];
    const op = await reserve('rule_ready', { forwardingType: 'CFNRY', noReplyTimer: 20 });
    store.bindings.set(HASH, { msisdn: MSISDN, employeeId: 99, accountId: 'acc-1' });

    advance(31); await tick();

    expect(row(op.id).state).toBe('cancelled');
    expect(catalog.postCallForwarding).not.toHaveBeenCalled();
  });

  it('unconfirmed после снятия: правило снялось позже → rule_ready; 24 ч без подтверждения → expired', async () => {
    mtsRules = [rule('CFU')];
    const a = await reserve('rule_ready', { forwardingType: 'CFNRC' });
    Object.assign(store.rows.get(a.id)!, {
      state: 'unconfirmed', unconfirmedFrom: 'rule_clear_verifying', ruleAction: 'delete:CFU', sendGeneration: 1, ruleAttempts: 1,
    });
    mtsRules = [];
    advance(31); await tick();
    expect(row(a.id).state).toBe('rule_ready');

    store.rows.clear();
    const b = await reserve('service_reserved');
    Object.assign(store.rows.get(b.id)!, { state: 'unconfirmed', unconfirmedFrom: 'service_unknown' });
    advance(24 * 3600 + 1); await tick();
    expect(row(b.id).state).toBe('expired');
    expect(catalog.modifyProduct).not.toHaveBeenCalled();
  });
});
