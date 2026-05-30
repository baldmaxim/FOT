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
  getEmployeeById: vi.fn(async () => ({ id: 1 })),
  move: vi.fn(async () => undefined),
  update: vi.fn(async () => undefined),
  create: vi.fn(async () => ({ sigurEmployeeId: 1 })),
  bindCard: vi.fn(async () => undefined),
  isDryRun: vi.fn(() => false),
  getOrgSigurDeptId: vi.fn(async () => 555),
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
    getEmployeeById: sig.getEmployeeById,
  },
}));
vi.mock('./sigur-live-employees-crud.service.js', () => ({
  createSigurEmployee: sig.create,
  moveSigurEmployee: sig.move,
  updateSigurEmployee: sig.update,
}));
vi.mock('./sigur-live-cards.service.js', () => ({
  assignSigurEmployeeCardBinding: sig.bindCard,
}));
vi.mock('../config/contractor.js', () => ({
  isContractorSigurDryRun: sig.isDryRun,
}));
vi.mock('./contractor-scope.service.js', () => ({
  getOrgSigurDepartmentId: sig.getOrgSigurDeptId,
  ContractorScopeError: class ContractorScopeError extends Error { status = 403; },
}));
vi.mock('./settings.service.js', () => ({
  settingsService: { get: sig.settingsGet, set: vi.fn(async () => undefined) },
}));

import {
  enqueueRevoke,
  processRevokePass,
  claimRevokeTasks,
  retryRevokeSync,
  assignPoolPassesByCount,
  MAX_REVOKE_SYNC_ATTEMPTS,
} from './contractor-pool.service.js';

const lastExecuteSql = (): string => String(pgExecute.mock.calls.at(-1)?.[0] ?? '');

beforeEach(() => {
  vi.clearAllMocks();
  sig.isDryRun.mockReturnValue(false);
  sig.getBackgroundConnectionType.mockResolvedValue('external');
  sig.getEmployeeById.mockResolvedValue({ id: 1 });
  sig.move.mockResolvedValue(undefined);
  sig.update.mockResolvedValue(undefined);
  sig.settingsGet.mockResolvedValue('999');
  pgExecute.mockResolvedValue(1);
  // withTransaction(fn) → fn(fakeClient)
  pgTx.mockImplementation(async (fn: (c: { query: ReturnType<typeof vi.fn> }) => unknown) =>
    fn({ query: vi.fn(async () => ({ rows: [] })) }),
  );
});

describe('enqueueRevoke', () => {
  it('мгновенно возвращает в пул и ставит pending_revoke (есть sigur_employee_id)', async () => {
    let captured: unknown[][] = [];
    pgTx.mockImplementation(async (fn: (c: { query: ReturnType<typeof vi.fn> }) => unknown) => {
      const q = vi.fn(async () => ({ rows: [] }));
      const r = await fn({ query: q });
      captured = q.mock.calls;
      return r;
    });
    pgQueryOne.mockResolvedValue({ id: 'p1', pass_number: '001', status: 'applied', sigur_employee_id: 5 });

    const res = await enqueueRevoke({ passId: 'p1', userId: 'u1' });

    expect(res).toEqual({ pass_id: 'p1', pass_number: '001', status: 'returned_to_pool' });
    // первый client.query — UPDATE contractor_passes c параметром syncState='pending_revoke'
    expect(String(captured[0]?.[0])).toContain("status = 'in_pool'");
    expect((captured[0]?.[1] as unknown[])).toContain('pending_revoke');
  });

  it('в dry-run сразу synced (синхронизировать нечего)', async () => {
    sig.isDryRun.mockReturnValue(true);
    let captured: unknown[][] = [];
    pgTx.mockImplementation(async (fn: (c: { query: ReturnType<typeof vi.fn> }) => unknown) => {
      const q = vi.fn(async () => ({ rows: [] }));
      const r = await fn({ query: q });
      captured = q.mock.calls;
      return r;
    });
    pgQueryOne.mockResolvedValue({ id: 'p1', pass_number: '001', status: 'assigned', sigur_employee_id: 5 });

    await enqueueRevoke({ passId: 'p1', userId: 'u1' });
    expect((captured[0]?.[1] as unknown[])).toContain('synced');
  });

  it('бросает, если пропуск уже в пуле / отозван', async () => {
    pgQueryOne.mockResolvedValue({ id: 'p1', pass_number: '001', status: 'in_pool', sigur_employee_id: 5 });
    await expect(enqueueRevoke({ passId: 'p1', userId: 'u1' })).rejects.toThrow(/уже в пуле/);

    pgQueryOne.mockResolvedValue({ id: 'p1', pass_number: '001', status: 'revoked', sigur_employee_id: 5 });
    await expect(enqueueRevoke({ passId: 'p1', userId: 'u1' })).rejects.toThrow(/отозван/);
  });
});

describe('processRevokePass', () => {
  it('пропускает незаклеймленную строку (sigur_sync_state != revoking)', async () => {
    pgQueryOne.mockResolvedValue({ pass_number: '001', status: 'in_pool', sigur_sync_state: 'pending_revoke', sigur_employee_id: 5 });
    await processRevokePass('p1');
    expect(sig.move).not.toHaveBeenCalled();
    expect(pgExecute).not.toHaveBeenCalled();
  });

  it('переназначенный (status != in_pool) — отзыв отменяется без Sigur', async () => {
    pgQueryOne.mockResolvedValue({ pass_number: '001', status: 'assigned', sigur_sync_state: 'revoking', sigur_employee_id: 5 });
    await processRevokePass('p1');
    expect(sig.move).not.toHaveBeenCalled();
    expect(lastExecuteSql()).toContain("sigur_sync_state = 'synced'");
  });

  it('happy path: move + rename/block → synced', async () => {
    pgQueryOne.mockResolvedValue({ pass_number: '001', status: 'in_pool', sigur_sync_state: 'revoking', sigur_employee_id: 5 });
    await processRevokePass('p1');
    expect(sig.move).toHaveBeenCalledWith(5, 999, 'external');
    expect(sig.update).toHaveBeenCalled();
    expect(lastExecuteSql()).toContain("sigur_sync_state = 'synced'");
  });

  it('orphan (Sigur 422 на probe) — пропускает move, обнуляет профиль', async () => {
    pgQueryOne.mockResolvedValue({ pass_number: '001', status: 'in_pool', sigur_sync_state: 'revoking', sigur_employee_id: 5 });
    sig.getEmployeeById.mockRejectedValue({ response: { status: 422 } });
    await processRevokePass('p1');
    expect(sig.move).not.toHaveBeenCalled();
    // orphan=true → execute с параметром true (обнуление sigur_employee_id)
    expect(pgExecute.mock.calls.at(-1)?.[1]).toContain(true);
  });

  it('ошибка Sigur (не 404/422) — инкремент попыток и проброс', async () => {
    pgQueryOne.mockResolvedValue({ pass_number: '001', status: 'in_pool', sigur_sync_state: 'revoking', sigur_employee_id: 5 });
    sig.move.mockRejectedValue({ response: { status: 500 }, message: 'boom' });
    await expect(processRevokePass('p1')).rejects.toBeDefined();
    expect(lastExecuteSql()).toContain('sigur_sync_attempts = sigur_sync_attempts + 1');
    expect(pgExecute.mock.calls.at(-1)?.[1]).toContain(MAX_REVOKE_SYNC_ATTEMPTS);
  });
});

describe('claimRevokeTasks', () => {
  it('клеймит строки атомарно через FOR UPDATE SKIP LOCKED', async () => {
    pgQuery.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    const ids = await claimRevokeTasks();
    expect(ids).toEqual(['a', 'b']);
    const sql = String(pgQuery.mock.calls.at(-1)?.[0]);
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain("sigur_sync_state = 'revoking'");
  });
});

describe('retryRevokeSync', () => {
  it('сбрасывает failed → pending_revoke (true при затронутой строке)', async () => {
    pgExecute.mockResolvedValue(1);
    await expect(retryRevokeSync('p1')).resolves.toBe(true);
    const sql = lastExecuteSql();
    expect(sql).toContain("sigur_sync_state = 'pending_revoke'");
    expect(sql).toContain("AND sigur_sync_state = 'failed'");
  });

  it('false, если строка не была failed', async () => {
    pgExecute.mockResolvedValue(0);
    await expect(retryRevokeSync('p1')).resolves.toBe(false);
  });
});

describe('assignPoolPassesByCount', () => {
  it('назначает первые N свободных по возрастанию номера', async () => {
    sig.isDryRun.mockReturnValue(true);
    pgQuery
      .mockResolvedValueOnce([{ id: 'p1' }, { id: 'p2' }]) // выбор первых N id
      .mockResolvedValueOnce([
        { id: 'p1', pass_number: '001', sigur_employee_id: null, status: 'in_pool', sigur_sync_state: 'synced' },
        { id: 'p2', pass_number: '002', sigur_employee_id: null, status: 'in_pool', sigur_sync_state: 'synced' },
      ]);

    const res = await assignPoolPassesByCount({ count: 2, orgDepartmentId: 'org', userId: 'u1' });
    expect(res.assigned).toEqual(['001', '002']);
    const selSql = String(pgQuery.mock.calls[0]?.[0]);
    expect(selSql).toContain('ORDER BY pass_number::int ASC');
    expect(selSql).toContain('LIMIT $1');
  });

  it('пустой пул — ничего не назначает', async () => {
    pgQuery.mockResolvedValueOnce([]);
    const res = await assignPoolPassesByCount({ count: 5, orgDepartmentId: 'org', userId: 'u1' });
    expect(res).toEqual({ assigned: [], failed: [] });
  });
});
