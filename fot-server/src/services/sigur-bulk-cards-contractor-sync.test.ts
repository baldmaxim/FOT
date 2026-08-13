/**
 * Синхронизация срока связанного подрядного пропуска при массовом продлении карт.
 * Проверяем главное: пропуск привязывается к КОНКРЕТНОЙ карте, локальный срок не
 * сокращается и не пишется по неподтверждённым исходам.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  query: vi.fn(),
  execute: vi.fn(),
  getCardBindings: vi.fn(),
  applyCardExpirationChange: vi.fn(),
  buildCardW26ById: vi.fn(),
  invalidateSigurDirectoryCaches: vi.fn(),
  acquireLease: vi.fn(),
  leaseRelease: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({ query: h.query, execute: h.execute }));
vi.mock('./sigur.service.js', () => ({
  sigurService: { getCardBindings: h.getCardBindings, patchEmployeeCardBinding: vi.fn() },
}));
vi.mock('./sigur-live-cards.service.js', () => ({
  applyCardExpirationChange: h.applyCardExpirationChange,
}));
vi.mock('./sigur-card-lease.service.js', () => ({
  acquireSigurCardLease: h.acquireLease,
  SigurCardLeaseBusyError: class extends Error {},
}));
vi.mock('./sigur-live-admin.service.js', async () => {
  const actual = await vi.importActual<typeof import('./sigur-live-admin.service.js')>(
    './sigur-live-admin.service.js',
  );
  return {
    ...actual,
    buildCardW26ById: h.buildCardW26ById,
    invalidateSigurDirectoryCaches: h.invalidateSigurDirectoryCaches,
  };
});

const { prepareBulkExtendOperation, executePreparedBulkExtend } =
  await import('./sigur-bulk-cards.service.js');

const DAY_MS = 24 * 60 * 60 * 1000;
const isoIn = (days: number): string => new Date(Date.now() + days * DAY_MS).toISOString();
const TARGET_DATE = isoIn(365).slice(0, 10);

/** Карта 100 ↔ W26 «35,30723»; пропуск хранит тот же UID. */
const CARD_UID = '0023780 3';
const CARD_W26 = '035,30723';

const row = {
  employeeId: 1,
  cardId: 100,
  startDate: isoIn(-200),
  expirationDate: isoIn(60),
  format: 'W26',
};

const passRow = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'pass-1',
  sigur_employee_id: 1,
  pass_number: '101',
  card_uid: CARD_UID,
  card_hex_uid: null,
  expires_at: isoIn(60).slice(0, 10),
  ...over,
});

const run = async () => {
  const prepared = await prepareBulkExtendOperation({
    operationId: 'op-sync',
    employeeIds: [1],
    expirationDate: TARGET_DATE,
    confirmExpired: false,
    expected: [{
      employeeId: row.employeeId,
      cardId: row.cardId,
      startDate: row.startDate,
      expirationDate: row.expirationDate,
      format: row.format,
    }],
    connection: undefined,
  });
  return executePreparedBulkExtend(prepared, () => undefined);
};

beforeEach(() => {
  vi.clearAllMocks();
  h.getCardBindings.mockResolvedValue([row]);
  h.applyCardExpirationChange.mockResolvedValue({ cardId: 100 });
  h.execute.mockResolvedValue(1);
  h.acquireLease.mockResolvedValue({ owner: 'op-sync', isLost: () => false, release: h.leaseRelease });
  // Карта 100 → W26 пропуска; карта 101 — чужая.
  h.buildCardW26ById.mockResolvedValue(new Map([['100', CARD_W26], ['101', '035,30724']]));
  h.query.mockResolvedValue([passRow()]);
});

describe('синхронизация contractor_passes при продлении', () => {
  it('обновляет срок пропуска строгим CAS по обоим идентификаторам карты', async () => {
    const result = await run();

    expect(result.localUpdatedPasses).toBe(1);
    const [sql, params] = h.execute.mock.calls[0];
    expect(sql).toContain('card_uid IS NOT DISTINCT FROM');
    expect(sql).toContain('card_hex_uid IS NOT DISTINCT FROM');
    expect(sql).toContain('expires_at < $1::date');
    expect(sql).not.toContain('is_active =');
    expect(sql).not.toContain('status =');
    expect(params).toEqual(expect.arrayContaining([TARGET_DATE, 'pass-1', 1, CARD_UID, null]));
  });

  it('пропуск, привязанный к другой карте, не трогается', async () => {
    h.buildCardW26ById.mockResolvedValue(new Map([['100', '035,99999']]));

    const result = await run();

    expect(h.execute).not.toHaveBeenCalled();
    expect(result.localUpdatedPasses).toBe(0);
  });

  it('локальный срок не сокращается: expires_at больше целевого — пропуск', async () => {
    h.query.mockResolvedValue([passRow({ expires_at: isoIn(500).slice(0, 10) })]);

    const result = await run();

    expect(h.execute).not.toHaveBeenCalled();
    expect(result.localUpdatedPasses).toBe(0);
  });

  it('бессрочный пропуск срочным не делаем', async () => {
    h.query.mockResolvedValue([passRow({ expires_at: null })]);

    const result = await run();

    expect(h.execute).not.toHaveBeenCalled();
    expect(result.localUpdatedPasses).toBe(0);
  });

  it('изменившийся после снимка пропуск не перезаписывается (CAS не сработал)', async () => {
    h.execute.mockResolvedValue(0);

    const result = await run();

    expect(result.localSyncFailedPasses).toBe(1);
    expect(result.localUpdatedPasses).toBe(0);
  });

  it('несколько пропусков на одну карту — fail-closed, локально не пишем', async () => {
    h.query.mockResolvedValue([passRow(), passRow({ id: 'pass-2', pass_number: '102' })]);

    const result = await run();

    expect(h.execute).not.toHaveBeenCalled();
    expect(result.localSyncFailedPasses).toBe(2);
  });

  it('на неподтверждённый исход карты (unknown) локальный срок не пишем', async () => {
    let patched = false;
    h.getCardBindings.mockImplementation(async () => {
      if (patched) throw new Error('read timeout');
      return [row];
    });
    h.applyCardExpirationChange.mockImplementation(async () => {
      patched = true;
      throw new Error('sigur 502');
    });

    const result = await run();

    expect(result.unknownCards).toBe(1);
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('сбой UPDATE: перечитывание отличает local_updated от local_sync_failed', async () => {
    h.execute.mockRejectedValue(new Error('deadlock'));
    h.query
      .mockResolvedValueOnce([passRow()])
      .mockResolvedValueOnce([{ expires_at: TARGET_DATE }]);

    const result = await run();

    expect(result.localUpdatedPasses).toBe(1);
    expect(result.localSyncFailedPasses).toBe(0);
  });

  it('сбой UPDATE и недоступное перечитывание → local_unknown', async () => {
    h.execute.mockRejectedValue(new Error('deadlock'));
    h.query
      .mockResolvedValueOnce([passRow()])
      .mockRejectedValueOnce(new Error('db down'));

    const result = await run();

    expect(result.localUnknownPasses).toBe(1);
  });
});
