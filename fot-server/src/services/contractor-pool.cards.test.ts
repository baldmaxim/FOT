import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Моки БД и Sigur ---
const { pgQuery, pgQueryOne, pgExecute, pgTx } = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  pgQueryOne: vi.fn(),
  pgExecute: vi.fn(),
  pgTx: vi.fn(),
}));

const sig = vi.hoisted(() => ({
  getBackgroundConnectionType: vi.fn(async () => 'external'),
  deleteEmployee: vi.fn(async () => undefined),
  getEmployees: vi.fn(async () => [] as Record<string, unknown>[]),
  create: vi.fn(async () => ({ sigurEmployeeId: 1 })),
  bindCard: vi.fn(async () => ({ card: { cardId: 10 }, previousSigurEmployeeId: null, reassigned: false })),
  isDryRun: vi.fn(() => false),
  settingsGet: vi.fn(async () => '999'),
}));

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: pgQueryOne,
  execute: pgExecute,
  withTransaction: pgTx,
}));
vi.mock('./sigur.service.js', () => ({
  sigurService: {
    getBackgroundConnectionType: sig.getBackgroundConnectionType,
    deleteEmployee: sig.deleteEmployee,
    getEmployees: sig.getEmployees,
  },
}));
vi.mock('./sigur-live-employees-crud.service.js', () => ({
  createSigurEmployee: sig.create,
  moveSigurEmployee: vi.fn(async () => undefined),
  updateSigurEmployee: vi.fn(async () => undefined),
}));
vi.mock('./sigur-live-cards.service.js', () => ({
  assignSigurEmployeeCardBinding: sig.bindCard,
}));
vi.mock('../config/contractor.js', () => ({
  isContractorSigurDryRun: sig.isDryRun,
}));
vi.mock('./contractor-scope.service.js', () => ({
  getOrgSigurDepartmentId: vi.fn(async () => 555),
  ContractorScopeError: class ContractorScopeError extends Error { status = 403; },
}));
vi.mock('./settings.service.js', () => ({
  settingsService: { get: sig.settingsGet, set: vi.fn(async () => undefined) },
}));

import { addPassesToPool, retryStuckPoolPasses } from './contractor-pool.service.js';

/**
 * pgQueryOne обслуживает в reserve две разные команды (отличаем по SQL):
 *   - preflight числового дубля: `pass_number::bigint = $1` (params[0] = num);
 *   - reserve INSERT ... RETURNING id (params[0] = passNumber).
 * dupNumbers — числовые номера, по которым preflight «находит» существующий пропуск.
 */
const setupDb = (opts?: { dupNumbers?: number[] }) => {
  const dup = new Set(opts?.dupNumbers ?? []);
  pgQueryOne.mockImplementation(async (sql: string, params: unknown[]) => {
    const s = String(sql);
    if (s.includes('pass_number::bigint')) {
      return dup.has(Number(params[0])) ? { id: `existing-${params[0]}` } : null;
    }
    if (s.includes('INSERT INTO contractor_passes') && s.includes('RETURNING id')) {
      return { id: `row-${params[0]}` };
    }
    return null;
  });
};

const insertedPassNumbers = (): string[] =>
  pgQueryOne.mock.calls
    .filter(c => String(c[0]).includes('INSERT INTO contractor_passes') && String(c[0]).includes('RETURNING id'))
    .map(c => String((c[1] as unknown[])[0]));

const failedStatusUpdates = (): number =>
  pgExecute.mock.calls.filter(c => String(c[0]).includes("status = 'provisioning_failed'")).length;

beforeEach(() => {
  vi.clearAllMocks();
  sig.isDryRun.mockReturnValue(false);
  sig.getBackgroundConnectionType.mockResolvedValue('external');
  sig.settingsGet.mockResolvedValue('999');
  sig.getEmployees.mockResolvedValue([]);
  sig.create.mockResolvedValue({ sigurEmployeeId: 1 });
  sig.bindCard.mockResolvedValue({ card: { cardId: 10 }, previousSigurEmployeeId: null, reassigned: false });
  pgExecute.mockResolvedValue(1);
  setupDb();
});

describe('addPassesToPool — reserve-then-provision', () => {
  it('happy path: резервирует строку и провижинит (создаёт профиль + карта)', async () => {
    const res = await addPassesToPool({
      from: 1,
      cards: [{ uid: '168,15956', sequence: 0 }],
      createdBy: 'u1',
    });

    expect(res.reserved).toEqual(['1']);
    expect(res.created).toEqual(['1']);
    expect(res.failed).toEqual([]);
    expect(res.missing).toEqual([]);
    // safe-only + createIfMissing=true при привязке карты
    expect(sig.bindCard).toHaveBeenCalledWith(1, ['168,15956'], undefined, 'external', true, { reassignPolicy: 'safe-only' });
    expect(sig.deleteEmployee).not.toHaveBeenCalled();
  });

  it('(6) формат: новый номер канонический "2241", без ведущих нулей', async () => {
    const res = await addPassesToPool({
      from: 2241,
      cards: [{ uid: '168,1', sequence: 0 }],
      createdBy: 'u1',
    });
    expect(res.reserved).toEqual(['2241']);
    expect(res.created).toEqual(['2241']);
    expect(insertedPassNumbers()).toEqual(['2241']);
  });

  it('(1) сбой Sigur на 3-й из 10: строка provisioning_failed, номер в failed, дыр нет', async () => {
    let bindCalls = 0;
    sig.bindCard.mockImplementation(async () => {
      bindCalls += 1;
      if (bindCalls === 3) throw new Error('Sigur 422 карта');
      return { card: { cardId: 10 }, previousSigurEmployeeId: null, reassigned: false };
    });

    const cards = Array.from({ length: 10 }, (_, i) => ({ uid: `168,${i}`, sequence: i }));
    const res = await addPassesToPool({ from: 1, cards, createdBy: 'u1' });

    // Все 10 номеров материализованы (дыр нет), 9 выпущено, 1 — провал карты.
    expect(res.reserved).toHaveLength(10);
    expect(res.created).toHaveLength(9);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].stage).toBe('card');
    expect(res.missing).toEqual([]);
    // строка переведена в provisioning_failed (а не удалена), профиль НЕ удалён
    expect(failedStatusUpdates()).toBe(1);
    expect(sig.deleteEmployee).not.toHaveBeenCalled();
  });

  it('(2) reconcile.missing пуст; дырявый sequence на входе → failed{input}', async () => {
    // sequences [0,1,3] → числа 1,2,4; дыра seq=2 → номер 3 (нет карты).
    const res = await addPassesToPool({
      from: 1,
      cards: [
        { uid: '168,0', sequence: 0 },
        { uid: '168,1', sequence: 1 },
        { uid: '168,3', sequence: 3 },
      ],
      createdBy: 'u1',
    });

    expect(res.missing).toEqual([]);
    expect(res.reserved).toEqual(['1', '2', '4']);
    const inputFail = res.failed.find(f => f.stage === 'input');
    expect(inputFail?.pass_number).toBe('3');
  });

  it('(3a) идемпотентность: повтор номера → failed{duplicate}, профиль не создаётся', async () => {
    setupDb({ dupNumbers: [1] });
    const res = await addPassesToPool({
      from: 1,
      cards: [{ uid: '168,0', sequence: 0 }],
      createdBy: 'u1',
    });

    expect(res.created).toEqual([]);
    expect(res.reserved).toEqual([]);
    expect(res.failed[0]).toMatchObject({ pass_number: '1', stage: 'duplicate' });
    expect(sig.create).not.toHaveBeenCalled();
    expect(insertedPassNumbers()).toEqual([]); // INSERT не выполнялся
  });

  it('(5) числовой дубль: новый 991 при legacy 0991 → failed{duplicate}', async () => {
    setupDb({ dupNumbers: [991] }); // в пуле уже лежит legacy "0991" (bigint 991)
    const res = await addPassesToPool({
      from: 991,
      cards: [{ uid: '168,9', sequence: 0 }],
      createdBy: 'u1',
    });
    expect(res.failed[0]).toMatchObject({ pass_number: '991', stage: 'duplicate' });
    expect(sig.create).not.toHaveBeenCalled();
  });

  it('номер вне пула (> to) → failed{range}, без резерва', async () => {
    const res = await addPassesToPool({
      from: 1,
      to: 1,
      cards: [{ uid: '168,0', sequence: 0 }, { uid: '168,1', sequence: 1 }],
      createdBy: 'u1',
    });
    expect(res.reserved).toEqual(['1']);
    const rangeFail = res.failed.find(f => f.stage === 'range');
    expect(rangeFail?.pass_number).toBe('2');
  });
});

describe('retryStuckPoolPasses', () => {
  it('(4) provisioning_failed и stale provisioning → in_pool', async () => {
    pgQuery.mockResolvedValue([
      { id: 'r1', pass_number: '10', card_uid: '168,10', sigur_employee_id: 777 },
      { id: 'r2', pass_number: '11', card_uid: '168,11', sigur_employee_id: null },
    ]);

    const res = await retryStuckPoolPasses();

    expect(res.retried).toBe(2);
    expect(res.created.sort()).toEqual(['10', '11']);
    expect(res.failed).toEqual([]);
    // r1 переиспользует profile 777 (без create); r2 создаёт новый (lookup пуст).
    expect(sig.bindCard).toHaveBeenCalledWith(777, ['168,10'], undefined, 'external', true, { reassignPolicy: 'safe-only' });
    expect(sig.create).toHaveBeenCalledTimes(1);
  });

  it('(3b) lookup по FOT-POOL:{n} переиспользует профиль, второй не создаёт', async () => {
    pgQuery.mockResolvedValue([
      { id: 'r2', pass_number: '11', card_uid: '168,11', sigur_employee_id: null },
    ]);
    sig.getEmployees.mockResolvedValue([
      { id: 888, description: 'FOT-POOL:11', name: 'Пропуск 11' },
    ]);

    const res = await retryStuckPoolPasses(['11']);

    expect(res.created).toEqual(['11']);
    expect(sig.create).not.toHaveBeenCalled();
    expect(sig.bindCard).toHaveBeenCalledWith(888, ['168,11'], undefined, 'external', true, { reassignPolicy: 'safe-only' });
  });
});
