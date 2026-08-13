import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  query: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
  logWithClient: vi.fn(),
  getCardBindings: vi.fn(),
  applyCardExpirationChange: vi.fn(),
  acquireLease: vi.fn(),
  leaseRelease: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: h.query,
  execute: h.execute,
  withTransaction: h.withTransaction,
}));
vi.mock('./audit.service.js', () => ({
  auditService: { logWithClient: h.logWithClient },
}));
vi.mock('./sigur.service.js', () => ({
  sigurService: { getCardBindings: h.getCardBindings },
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
  return { ...actual, invalidateSigurDirectoryCaches: h.invalidate };
});

const { rollbackBulkExtendOperation } = await import('./sigur-bulk-cards-rollback.service.js');

const OPERATION_ID = 'op-42';
const PREVIOUS = '2026-09-30T20:59:59.000Z';
const TARGET_ISO = '2026-12-31T20:59:59.000Z';
const TARGET_DATE = '2026-12-31';
const START = '2026-01-01T00:00:00.000Z';

const startedRow = (over: Record<string, unknown> = {}) => ({
  details: {
    action: 'bulk_extend_cards_started',
    operationId: OPERATION_ID,
    targetIso: TARGET_ISO,
    expirationDate: TARGET_DATE,
    plan: [{
      employeeId: 1,
      cardId: 100,
      previousExpiration: PREVIOUS,
      startDate: START,
      format: 'W26',
      passes: [{
        passId: 'pass-1',
        previousExpiresAt: '2026-09-30',
        previousCardUid: 'UID-1',
        previousCardHexUid: null,
      }],
    }],
    ...over,
  },
});

const completedRow = () => ({ details: { action: 'bulk_extend_cards_completed' } });

/** Карта сейчас со сроком нашей операции — кандидат на возврат. */
const bindingWith = (expirationDate: string | null) => ([{
  employeeId: 1, cardId: 100, startDate: START, expirationDate, format: 'W26',
}]);

beforeEach(() => {
  vi.clearAllMocks();
  h.query.mockResolvedValue([startedRow(), completedRow()]);
  h.execute.mockResolvedValue(1);
  h.withTransaction.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => fn({}));
  h.logWithClient.mockResolvedValue(undefined);
  h.getCardBindings.mockResolvedValue(bindingWith(TARGET_ISO));
  h.applyCardExpirationChange.mockResolvedValue({ cardId: 100 });
  h.acquireLease.mockResolvedValue({
    owner: `rollback:${OPERATION_ID}`,
    isLost: () => false,
    release: h.leaseRelease,
  });
});

describe('rollbackBulkExtendOperation', () => {
  it('dry-run ничего не пишет ни в Sigur, ни в БД, ни в аудит', async () => {
    const result = await rollbackBulkExtendOperation({ operationId: OPERATION_ID, apply: false });

    expect(h.applyCardExpirationChange).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.logWithClient).not.toHaveBeenCalled();
    expect(result.restoredCards).toBe(1);
  });

  it('apply возвращает прежний срок через общее ядро', async () => {
    const result = await rollbackBulkExtendOperation({ operationId: OPERATION_ID, apply: true });

    expect(h.applyCardExpirationChange).toHaveBeenCalledWith(expect.objectContaining({
      sigurEmployeeId: 1,
      cardId: 100,
      startDate: START,
      expirationDate: PREVIOUS,
    }));
    expect(result.restoredCards).toBe(1);
  });

  it('rollback_started пишется до первой записи, итог — после', async () => {
    const order: string[] = [];
    h.logWithClient.mockImplementation(async (_client: unknown, entry: { details: { action: string } }) => {
      order.push(entry.details.action);
    });
    h.applyCardExpirationChange.mockImplementation(async () => {
      order.push('patch');
      return { cardId: 100 };
    });

    await rollbackBulkExtendOperation({ operationId: OPERATION_ID, apply: true });

    expect(order).toEqual([
      'bulk_extend_cards_rollback_started',
      'patch',
      'bulk_extend_cards_rollback_completed',
    ]);
  });

  it('работает без итоговой записи операции и предупреждает об этом', async () => {
    h.query.mockResolvedValue([startedRow()]);

    const result = await rollbackBulkExtendOperation({ operationId: OPERATION_ID, apply: false });

    expect(result.missingCompleted).toBe(true);
    expect(result.warnings.some(warning => warning.includes('итоговой записи'))).toBe(true);
    expect(result.restoredCards).toBe(1);
  });

  it('карта, изменённая после операции, не трогается', async () => {
    h.getCardBindings.mockResolvedValue(bindingWith('2027-05-05T00:00:00.000Z'));

    const result = await rollbackBulkExtendOperation({ operationId: OPERATION_ID, apply: true });

    expect(h.applyCardExpirationChange).not.toHaveBeenCalled();
    expect(result.changedAfterOperation).toBe(1);
  });

  it('ошибка PATCH: контрольное чтение показало прежний срок → возврат засчитан', async () => {
    let patched = false;
    h.getCardBindings.mockImplementation(async () => bindingWith(patched ? PREVIOUS : TARGET_ISO));
    h.applyCardExpirationChange.mockImplementation(async () => {
      patched = true;
      throw new Error('socket hang up');
    });

    const result = await rollbackBulkExtendOperation({ operationId: OPERATION_ID, apply: true });

    expect(result.restoredCards).toBe(1);
    expect(result.failedCards).toBe(0);
  });

  it('ошибка PATCH: срок остался нашим → rollback_failed', async () => {
    h.applyCardExpirationChange.mockRejectedValue(new Error('sigur 400'));

    const result = await rollbackBulkExtendOperation({ operationId: OPERATION_ID, apply: true });

    expect(result.failedCards).toBe(1);
  });

  it('ошибка PATCH + недоступное чтение → rollback_unknown', async () => {
    let patched = false;
    h.getCardBindings.mockImplementation(async () => {
      if (patched) throw new Error('read timeout');
      return bindingWith(TARGET_ISO);
    });
    h.applyCardExpirationChange.mockImplementation(async () => {
      patched = true;
      throw new Error('sigur 502');
    });

    const result = await rollbackBulkExtendOperation({ operationId: OPERATION_ID, apply: true });

    expect(result.unknownCards).toBe(1);
  });

  it('локальный срок возвращается строгим CAS и только после успеха в Sigur', async () => {
    const result = await rollbackBulkExtendOperation({ operationId: OPERATION_ID, apply: true });

    const [sql, params] = h.execute.mock.calls[0];
    expect(sql).toContain('card_uid IS NOT DISTINCT FROM');
    expect(sql).toContain('card_hex_uid IS NOT DISTINCT FROM');
    expect(params).toEqual(expect.arrayContaining(['2026-09-30', 'pass-1', 1, 'UID-1', null, TARGET_DATE]));
    expect(result.restoredPasses).toBe(1);
  });

  it('локальный пропуск, изменённый после операции, не перезаписывается', async () => {
    h.execute.mockResolvedValue(0);

    const result = await rollbackBulkExtendOperation({ operationId: OPERATION_ID, apply: true });

    expect(result.restoredPasses).toBe(0);
    expect(result.items[0].passes[0].status).toBe('local_changed_after_operation');
  });

  it('каждая попытка берёт lease со своим rollbackAttemptId', async () => {
    const first = await rollbackBulkExtendOperation({ operationId: OPERATION_ID, apply: true });
    const second = await rollbackBulkExtendOperation({ operationId: OPERATION_ID, apply: true });

    expect(first.rollbackAttemptId).not.toBe(second.rollbackAttemptId);
    const owners = h.acquireLease.mock.calls.map(call => (call[0] as { owner: string }).owner);
    expect(owners[0]).toContain(`rollback:${OPERATION_ID}:`);
    expect(owners[0]).not.toBe(owners[1]);
    expect(h.leaseRelease).toHaveBeenCalledTimes(2);
  });

  it('неизвестная операция — понятная ошибка, lease не берётся', async () => {
    h.query.mockResolvedValue([]);

    await expect(rollbackBulkExtendOperation({ operationId: 'нет-такой', apply: true }))
      .rejects.toThrow('не найдена в журнале');
    expect(h.acquireLease).not.toHaveBeenCalled();
  });
});
