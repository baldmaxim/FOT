import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Логика шагов операции и воркера на in-memory модели таблицы: переходы так же
// атомарны (проверка from/аренды и запись — синхронно, без await между ними),
// как одиночный UPDATE … RETURNING в БД. SQL-семантика — в *.pg.test.ts.

const store = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  bindings: new Map<string, { msisdn: string | null; employeeId: number | null; accountId: string | null }>(),
  seq: 0,
}));

vi.mock('./mts-forwarding-operations.service.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./mts-forwarding-operations.service.js')>();
  const iso = (offsetSec = 0): string => new Date(Date.now() + offsetSec * 1000).toISOString();
  const copy = (r: Record<string, unknown> | undefined) => (r ? structuredClone(r) : null) as never;
  const leaseFree = (r: Record<string, unknown>, owner?: string): boolean =>
    r.leaseUntil == null || new Date(String(r.leaseUntil)).getTime() < Date.now() || (owner != null && r.leaseOwner === owner);
  const ACTIVE = (s: unknown): boolean => !orig.FINAL_OPERATION_STATES.includes(s as never);

  const fake = {
    async reserve(input: Record<string, unknown>) {
      const hash = `h:${String(input.msisdn)}`;
      const active = [...store.rows.values()].find(r => r.accountId === input.accountId && r.msisdnHash === hash && ACTIVE(r.state));
      if (active) return { operation: copy(active), created: false };
      const id = `op-${++store.seq}`;
      const row = {
        id, accountId: input.accountId, msisdnHash: hash, employeeId: input.employeeId, requestedBy: input.requestedBy,
        forwardingType: input.forwardingType, target: input.target, noReplyTimer: input.noReplyTimer,
        state: input.initialState, serviceEventId: null, ruleEventId: null, ruleAttempts: 0, sendStartedAt: null,
        leaseOwner: null, leaseUntil: null, deadlineAt: iso(Number(input.deadlineSeconds)), nextCheckAt: iso(30),
        confirmedRules: null, lastErrorCode: null, lastErrorMessage: null, createdAt: iso(), updatedAt: iso(), finishedAt: null,
      };
      store.rows.set(id, row);
      return { operation: copy(row), created: true };
    },
    async getById(id: string) { return copy(store.rows.get(id)); },
    async getActive(accountId: string, hash: string) {
      return copy([...store.rows.values()].find(r => r.accountId === accountId && r.msisdnHash === hash && ACTIVE(r.state)));
    },
    async transition(id: string, from: readonly string[], patch: Record<string, unknown>, requireOwner?: string) {
      const r = store.rows.get(id);
      if (!r || !from.includes(String(r.state))) return null;
      if (requireOwner && r.leaseOwner !== requireOwner) return null;
      if (patch.state) { r.state = patch.state; if (orig.isOperationFinal(patch.state as never)) r.finishedAt = iso(); }
      if (patch.serviceEventId !== undefined) r.serviceEventId = patch.serviceEventId;
      if (patch.ruleEventId !== undefined) r.ruleEventId = patch.ruleEventId;
      if (patch.lease === null) { r.leaseOwner = null; r.leaseUntil = null; }
      if (patch.deadlineSeconds !== undefined) r.deadlineAt = iso(Number(patch.deadlineSeconds));
      if (patch.nextCheckSeconds !== undefined) r.nextCheckAt = iso(Number(patch.nextCheckSeconds));
      if (patch.confirmedRules !== undefined) r.confirmedRules = patch.confirmedRules;
      if (patch.error === null) { r.lastErrorCode = null; r.lastErrorMessage = null; }
      else if (patch.error) { const e = patch.error as { code: string; message: string }; r.lastErrorCode = e.code; r.lastErrorMessage = e.message; }
      return copy(r);
    },
    async claimSend(id: string, from: string, to: string, owner: string) {
      const r = store.rows.get(id);
      if (!r || r.state !== from || !leaseFree(r, owner)) return null;
      r.state = to; r.sendStartedAt = iso(); r.leaseOwner = owner; r.leaseUntil = iso(orig.SEND_LEASE_SECONDS);
      if (to === 'rule_sending') r.ruleAttempts = Number(r.ruleAttempts) + 1;
      return copy(r);
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
        if ((r.state === 'service_sending' || r.state === 'rule_sending') && new Date(String(r.leaseUntil)).getTime() < Date.now()) {
          r.state = r.state === 'service_sending' ? 'service_unknown' : 'rule_verifying';
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
    verifyCallForwarding: vi.fn(async () => null),
    getCallForwarding: vi.fn(async () => []),
    getProductInfo: vi.fn(async () => []),
    checkModifyProductStatus: vi.fn(async () => ({ status: 'unknown', raw: null })),
  },
}));
vi.mock('./mts-business-actions.service.js', () => ({ mtsBusinessActionsService: { create: vi.fn(async () => undefined) } }));
vi.mock('./mts-business-metrics-store.service.js', () => ({ mtsBusinessMetricsStoreService: { upsertSnapshot: vi.fn(async () => undefined) } }));
vi.mock('./audit.service.js', () => ({
  auditService: { log: vi.fn(async () => undefined) },
  AUDIT_ACTIONS: {
    MTS_BUSINESS_SERVICE_ADD_REQUESTED: 'MTS_BUSINESS_SERVICE_ADD_REQUESTED',
    MTS_BUSINESS_FORWARDING_SET_REQUESTED: 'MTS_BUSINESS_FORWARDING_SET_REQUESTED',
  },
}));
vi.mock('../config/postgres.js', () => ({ query: vi.fn(), queryOne: vi.fn(), execute: vi.fn() }));
vi.mock('./sigur-runtime-state.service.js', () => ({ getSigurRuntimeOwner: (s: string) => `${s}:test` }));

import { mtsForwardingOperationsService as ops, type IForwardingOperation } from './mts-forwarding-operations.service.js';
import { sendServiceRequest, sendRule, verifyRule } from './mts-forwarding-operations.runner.js';
import { runForwardingOperationsTick } from './mts-forwarding-operations.worker.js';
import { mtsBusinessCatalogService } from './mts-business-catalog.service.js';
import { mtsBusinessMetricsStoreService } from './mts-business-metrics-store.service.js';
import { MtsBusinessApiError } from './mts-business-base.service.js';

const catalog = vi.mocked(mtsBusinessCatalogService);
const metrics = vi.mocked(mtsBusinessMetricsStoreService);

const MSISDN = '79150000001';
const HASH = `h:${MSISDN}`;
const TARGET = '79161234567';
const PE0250 = [{ code: 'PE0250', name: 'Переадресация вызова (периодическая)', status: 'ACTIVE' }] as never;
const rule = (over: Record<string, unknown> = {}) => ({
  forwardingType: 'CFU', forwardingAddress: TARGET, noReplyTimer: 0, numType: 'Regular', status: null, ...over,
});

let clock = new Date('2026-09-14T10:00:00Z').getTime();
const advance = (sec: number): void => { clock += sec * 1000; vi.setSystemTime(clock); };

const reserve = async (initialState: 'service_reserved' | 'rule_ready', over: Record<string, unknown> = {}) =>
  (await ops.reserve({
    accountId: 'acc-1', msisdn: MSISDN, employeeId: 42, requestedBy: 'u-1', forwardingType: 'CFU', target: TARGET,
    noReplyTimer: null, initialState, deadlineSeconds: initialState === 'rule_ready' ? 1800 : 3600, ...over,
  } as never)).operation;

const row = (id: string): IForwardingOperation => store.rows.get(id) as unknown as IForwardingOperation;
const tick = (owner = 'w1') => runForwardingOperationsTick(`worker:${owner}`);

beforeEach(() => {
  vi.clearAllMocks();
  store.rows.clear();
  store.bindings.clear();
  store.bindings.set(HASH, { msisdn: MSISDN, employeeId: 42, accountId: 'acc-1' });
  clock = new Date('2026-09-14T10:00:00Z').getTime();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(clock);
  catalog.verifyCallForwarding.mockResolvedValue(null);
  catalog.getCallForwarding.mockResolvedValue([]);
  catalog.getProductInfo.mockResolvedValue([]);
  catalog.checkModifyProductStatus.mockResolvedValue({ status: 'unknown', raw: null });
});
afterEach(() => { vi.useRealTimers(); });

describe('операция переадресации: один отправитель', () => {
  it('контроллер и воркер одновременно на одной строке → ModifyProduct ровно один раз', async () => {
    catalog.modifyProduct.mockResolvedValue({ eventId: 'EV-S' });
    const op = await reserve('service_reserved');

    await Promise.all([sendServiceRequest(op, 'http:a', MSISDN), sendServiceRequest(op, 'worker:b', MSISDN)]);

    expect(catalog.modifyProduct).toHaveBeenCalledTimes(1);
    expect(catalog.modifyProduct).toHaveBeenCalledWith('acc-1', MSISDN, 'create', 'PE0250');
    expect(row(op.id).state).toBe('service_accepted');
  });

  it('два воркера в одном тике → одна отправка', async () => {
    catalog.modifyProduct.mockResolvedValue({ eventId: 'EV-S' });
    const op = await reserve('service_reserved');
    advance(31); // контроллер «упал» после резерва — строка стала доступна воркерам

    await Promise.all([tick('w1'), tick('w2')]);

    expect(catalog.modifyProduct).toHaveBeenCalledTimes(1);
    expect(row(op.id).state).toBe('service_accepted');
  });

  it('повторный резерв по номеру с активной (в т.ч. unconfirmed) операцией → created=false', async () => {
    const op = await reserve('service_reserved');
    store.rows.get(op.id)!.state = 'unconfirmed';
    const again = await ops.reserve({
      accountId: 'acc-1', msisdn: MSISDN, employeeId: 42, requestedBy: 'u-1', forwardingType: 'CFU', target: TARGET,
      noReplyTimer: null, initialState: 'service_reserved', deadlineSeconds: 3600,
    });
    expect(again.created).toBe(false);
    expect(again.operation.id).toBe(op.id);
  });
});

describe('операция переадресации: неизвестный исход не повторяется', () => {
  it('тайм-аут ModifyProduct → service_unknown, одна отправка; срок истёк → unconfirmed, отправок больше нет', async () => {
    catalog.modifyProduct.mockRejectedValue(new MtsBusinessApiError('timeout of 20000ms exceeded', 0));
    const op = await reserve('service_reserved');

    const after = await sendServiceRequest(op, 'http:a', MSISDN);
    expect(after.state).toBe('service_unknown');

    for (let i = 0; i < 70; i++) { advance(61); await tick(); }

    expect(catalog.modifyProduct).toHaveBeenCalledTimes(1);
    expect(row(op.id).state).toBe('unconfirmed');
  });

  it('502 на ModifyProduct → unknown; 4xx → failed (подтверждённый отказ)', async () => {
    catalog.modifyProduct.mockRejectedValueOnce(new MtsBusinessApiError('bad gateway', 502));
    const a = await sendServiceRequest(await reserve('service_reserved'), 'http:a', MSISDN);
    expect(a.state).toBe('service_unknown');

    store.rows.clear();
    catalog.modifyProduct.mockRejectedValueOnce(new MtsBusinessApiError('Услуга недоступна', 400, '2005'));
    const b = await sendServiceRequest(await reserve('service_reserved'), 'http:a', MSISDN);
    expect(b.state).toBe('failed');
    expect(b.lastErrorMessage).toBe('Услуга недоступна');
  });

  it('перезапуск после маркера отправки (service_sending, аренда истекла) → сверка без ModifyProduct', async () => {
    const op = await reserve('service_reserved');
    await ops.claimSend(op.id, 'service_reserved', 'service_sending', 'http:dead');
    advance(400);
    catalog.getProductInfo.mockResolvedValue(PE0250);
    catalog.postCallForwarding.mockResolvedValue({ eventId: null, resp: {} });

    await tick();

    expect(catalog.modifyProduct).not.toHaveBeenCalled();
    expect(row(op.id).state).toBe('rule_ready');
  });

  it('POST правила принят, проверка правил падает 421 → rule_verifying, второго POST нет', async () => {
    catalog.postCallForwarding.mockResolvedValue({ eventId: null, resp: {} });
    catalog.getCallForwarding.mockRejectedValue(new MtsBusinessApiError('Сервис Foris временно недоступен', 421, '3003'));
    const op = await reserve('rule_ready');

    await sendRule(op, 'http:a', MSISDN);
    for (let i = 0; i < 5; i++) { advance(61); await tick(); }

    expect(catalog.postCallForwarding).toHaveBeenCalledTimes(1);
    expect(row(op.id).state).toBe('rule_verifying');
  });

  it('перезапуск во время POST правила → rule_verifying, повторного POST нет', async () => {
    const op = await reserve('rule_ready');
    await ops.claimSend(op.id, 'rule_ready', 'rule_sending', 'http:dead');
    advance(400);

    await tick();

    expect(catalog.postCallForwarding).not.toHaveBeenCalled();
    expect(['rule_verifying']).toContain(row(op.id).state);
  });
});

describe('операция переадресации: цепочка и подтверждение фактом', () => {
  it('услуга активировалась → правило сохранёнными параметрами → совпало → done + снапшот', async () => {
    catalog.modifyProduct.mockResolvedValue({ eventId: 'EV-S' });
    const op = await reserve('service_reserved', { forwardingType: 'CFNRY', noReplyTimer: 25 });
    await sendServiceRequest(op, 'http:a', MSISDN);

    catalog.getProductInfo.mockResolvedValue(PE0250);
    advance(61); await tick();
    expect(row(op.id).state).toBe('rule_ready');

    catalog.postCallForwarding.mockResolvedValue({ eventId: null, resp: {} });
    await tick();
    expect(catalog.postCallForwarding).toHaveBeenCalledWith('acc-1', MSISDN, 'create', {
      forwardingType: 'CFNRY', forwardingAddress: TARGET, noReplyTimer: 25,
    });
    expect(row(op.id).state).toBe('rule_verifying');

    const actual = [rule({ forwardingType: 'CFNRY', noReplyTimer: 25 })];
    catalog.getCallForwarding.mockResolvedValue(actual);
    advance(61); await tick();

    expect(row(op.id).state).toBe('done');
    expect(metrics.upsertSnapshot).toHaveBeenCalledWith(expect.objectContaining({ metric: 'forwarding', payload: actual }));
  });

  it('CFNRY с другим таймером у МТС → не done', async () => {
    const op = await reserve('rule_ready', { forwardingType: 'CFNRY', noReplyTimer: 25 });
    store.rows.get(op.id)!.state = 'rule_verifying';
    catalog.getCallForwarding.mockResolvedValue([rule({ forwardingType: 'CFNRY', noReplyTimer: 30 })]);

    advance(61); await tick();

    expect(row(op.id).state).toBe('rule_verifying');
  });

  it('421 на POST правила (отказ) → повтор через 2 мин, всего 3 попытки, затем failed', async () => {
    catalog.postCallForwarding.mockRejectedValue(new MtsBusinessApiError('Сервис Foris временно недоступен', 421, '3003'));
    const op = await reserve('rule_ready');

    await sendRule(op, 'http:a', MSISDN);
    expect(row(op.id).state).toBe('rule_ready');
    for (let i = 0; i < 6; i++) { advance(121); await tick(); }

    expect(catalog.postCallForwarding).toHaveBeenCalledTimes(3);
    expect(row(op.id).state).toBe('failed');
  });

  it('снапшот не записался → остаёмся в rule_confirmed, следующий тик доводит до done без мутаций', async () => {
    const op = await reserve('rule_ready');
    store.rows.get(op.id)!.state = 'rule_verifying';
    catalog.getCallForwarding.mockResolvedValue([rule()]);
    metrics.upsertSnapshot.mockRejectedValueOnce(new Error('db down'));

    advance(61); await tick();
    expect(row(op.id).state).toBe('rule_confirmed');

    advance(61); await tick();
    expect(row(op.id).state).toBe('done');
    expect(catalog.postCallForwarding).not.toHaveBeenCalled();
  });

  it('быстрая проверка в контроллере: verifyCallForwarding совпал → done', async () => {
    catalog.verifyCallForwarding.mockResolvedValue([rule()] as never);
    const op = await reserve('rule_ready');
    store.rows.get(op.id)!.state = 'rule_verifying';

    const after = await verifyRule(row(op.id), undefined, MSISDN, true);

    expect(after.state).toBe('done');
  });
});

describe('операция переадресации: привязка номера и срок жизни', () => {
  it('номер перепривязан до отправки правила → cancelled, POST нет', async () => {
    const op = await reserve('rule_ready');
    store.bindings.set(HASH, { msisdn: MSISDN, employeeId: 99, accountId: 'acc-1' });

    advance(31); await tick();

    expect(row(op.id).state).toBe('cancelled');
    expect(catalog.postCallForwarding).not.toHaveBeenCalled();
  });

  it('unconfirmed: правило появилось позже → done; 24 ч без подтверждения → expired', async () => {
    const a = await reserve('rule_ready');
    Object.assign(store.rows.get(a.id)!, { state: 'unconfirmed', ruleAttempts: 1 });
    catalog.getCallForwarding.mockResolvedValue([rule()]);
    advance(31); await tick();
    expect(row(a.id).state).toBe('done');

    store.rows.clear();
    catalog.getCallForwarding.mockResolvedValue([]);
    const b = await reserve('service_reserved');
    Object.assign(store.rows.get(b.id)!, { state: 'unconfirmed' });
    advance(24 * 3600 + 1); await tick();
    expect(row(b.id).state).toBe('expired');
    expect(catalog.modifyProduct).not.toHaveBeenCalled();
  });
});

