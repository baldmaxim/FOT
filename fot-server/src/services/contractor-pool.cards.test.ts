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

import { addPassesToPool } from './contractor-pool.service.js';

const lastInsertSql = (): string => {
  const insertCall = pgExecute.mock.calls.find(c => String(c[0]).includes('INSERT INTO contractor_passes'));
  return String(insertCall?.[0] ?? '');
};

beforeEach(() => {
  vi.clearAllMocks();
  sig.isDryRun.mockReturnValue(false);
  sig.getBackgroundConnectionType.mockResolvedValue('external');
  sig.settingsGet.mockResolvedValue('999');
  sig.create.mockResolvedValue({ sigurEmployeeId: 1 });
  sig.bindCard.mockResolvedValue({ card: { cardId: 10 }, previousSigurEmployeeId: null, reassigned: false });
  pgQueryOne.mockResolvedValue(null); // нет дубля в пуле
  pgExecute.mockResolvedValue(1);
});

describe('addPassesToPool — карта обязательна', () => {
  it('happy path: создаёт карту (createIfMissing=true) и пишет пропуск в пул', async () => {
    const res = await addPassesToPool({
      from: 1,
      cards: [{ uid: '168,15956', sequence: 0 }],
      createdBy: 'u1',
    });

    expect(res.created).toEqual(['01']);
    expect(res.failed).toEqual([]);
    // привязка вызвана с createIfMissing=true (5-й аргумент)
    expect(sig.bindCard).toHaveBeenCalledWith(1, ['168,15956'], undefined, 'external', true);
    // профиль НЕ удаляли
    expect(sig.deleteEmployee).not.toHaveBeenCalled();
    expect(lastInsertSql()).toContain('INSERT INTO contractor_passes');
  });

  it('провал карты: пропуск в failed, профиль подчищен, в БД не пишем', async () => {
    sig.bindCard.mockRejectedValue(new Error('Sigur 400'));

    const res = await addPassesToPool({
      from: 1,
      cards: [{ uid: 'BADUID', sequence: 0 }],
      createdBy: 'u1',
    });

    expect(res.created).toEqual([]);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0]).toMatchObject({ pass_number: '01' });
    expect(res.failed[0].error).toContain('карта');
    // best-effort удаление только что созданного профиля
    expect(sig.deleteEmployee).toHaveBeenCalledWith(1, 'external');
    // INSERT в contractor_passes НЕ выполнялся
    expect(lastInsertSql()).toBe('');
  });
});
