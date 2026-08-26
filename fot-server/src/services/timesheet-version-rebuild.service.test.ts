import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Фоновая пересборка версий после админской правки закрытого табеля.
 *
 * Проверяем гонки: воркер работает параллельно с правками и, возможно, во втором
 * экземпляре бэкенда — потерянная или лишняя пересборка одинаково опасны.
 */

const { pgQuery, materializeMock, invalidateMock, txPairs } = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  materializeMock: vi.fn(),
  invalidateMock: vi.fn(),
  txPairs: { value: [] as Array<{ employeeId: number; workDate: string }> },
}));

vi.mock('../config/postgres.js', () => ({ query: pgQuery }));
vi.mock('../middleware/cacheResponse.js', () => ({ invalidateCaches: invalidateMock }));

const { clientHandler, clientCalls } = vi.hoisted(() => ({
  clientHandler: { fn: null as null | ((sql: string, params: unknown[]) => unknown) },
  clientCalls: [] as Array<{ sql: string; params: unknown[] }>,
}));

vi.mock('./timesheet-snapshot-tx.js', () => ({
  withTimesheetSnapshotTransaction: async (
    pairs: Array<{ employeeId: number; workDate: string }>,
    fn: (client: unknown) => Promise<unknown>,
  ) => {
    txPairs.value = pairs;
    return fn({
      query: async (sql: string, params?: unknown[]) => {
        clientCalls.push({ sql, params: params ?? [] });
        const rows = clientHandler.fn?.(sql, params ?? []) ?? [];
        const list = Array.isArray(rows) ? rows : [rows];
        return { rows: list, rowCount: list.length };
      },
    });
  },
}));

vi.mock('./timesheet-version.service.js', async (importActual) => ({
  ...(await importActual<typeof import('./timesheet-version.service.js')>()),
  materializeVersion: materializeMock,
}));

import { __testing } from './timesheet-version-rebuild.service.js';

const APPROVAL_ID = 855;

const dirtyRow = (over: Record<string, unknown> = {}) => ({
  id: APPROVAL_ID,
  department_id: 'dept-1',
  manager_employee_id: null,
  start_date: '2026-08-01',
  end_date: '2026-08-15',
  status: 'approved',
  version_dirty_seq: 3,
  dirty_age_minutes: 1,
  ...over,
});

/** Строка, которую воркер видит под FOR UPDATE. */
const lockedRow = (over: Record<string, unknown> = {}) => ({
  status: 'approved',
  unlocked_at: null,
  version_dirty_at: '2026-08-26T10:00:00Z',
  version_dirty_seq: 3,
  ...over,
});

function setupSingleDirty(locked: Record<string, unknown> | null) {
  pgQuery.mockImplementation(async (sql: string) => {
    if (/FROM timesheet_approvals\s+WHERE version_dirty_at IS NOT NULL/i.test(sql)) return [dirtyRow()];
    if (/FROM timesheet_approval_employees/i.test(sql)) return [{ employee_id: 501 }];
    return [];
  });
  clientHandler.fn = (sql) => {
    if (/FOR UPDATE/i.test(sql)) return locked ? [locked] : [];
    return [];
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clientCalls.length = 0;
  clientHandler.fn = null;
  txPairs.value = [];
  pgQuery.mockResolvedValue([]);
  materializeMock.mockResolvedValue({ version: { revision: 2 }, created: true });
});

describe('runRebuildCycle', () => {
  it('нет dirty-подач — ничего не делает', async () => {
    pgQuery.mockResolvedValue([]);
    await __testing.runRebuildCycle();
    expect(materializeMock).not.toHaveBeenCalled();
    expect(invalidateMock).not.toHaveBeenCalled();
  });

  it('выборка учитывает debounce и backoff', async () => {
    pgQuery.mockResolvedValue([]);
    await __testing.runRebuildCycle();

    const sql = String(pgQuery.mock.calls[0]![0]);
    expect(sql).toContain('version_dirty_at IS NOT NULL');
    expect(sql).toContain("status = 'approved'");
    expect(sql).toContain('unlocked_at IS NULL');
    // Без backoff-фильтра постоянно падающие подачи заняли бы весь батч.
    expect(sql).toContain('version_rebuild_after IS NULL OR version_rebuild_after <= NOW()');
  });

  it('пересобирает подачу и снимает метку по совпадению seq', async () => {
    setupSingleDirty(lockedRow());
    await __testing.runRebuildCycle();

    expect(materializeMock).toHaveBeenCalledOnce();
    expect(materializeMock.mock.calls[0]![2]).toBe('rebuild');

    const clear = clientCalls.find(c => /SET version_dirty_at = NULL/i.test(c.sql));
    expect(clear).toBeDefined();
    // Условная очистка: правка во время сборки инкрементит seq и метка останется.
    expect(clear!.sql).toContain('version_dirty_seq = $2');
    expect(clear!.params).toEqual([APPROVAL_ID, 3]);

    expect(invalidateMock).toHaveBeenCalledWith('timesheet-1c-status');
  });

  it('advisory-локи берутся по составу подачи', async () => {
    setupSingleDirty(lockedRow());
    await __testing.runRebuildCycle();
    expect(txPairs.value).toEqual([{ employeeId: 501, workDate: '2026-08-01' }]);
  });

  it('период успели открыть — версию открытого табеля не создаём', async () => {
    setupSingleDirty(lockedRow({ unlocked_at: '2026-08-26T11:00:00Z' }));
    await __testing.runRebuildCycle();

    expect(materializeMock).not.toHaveBeenCalled();
    expect(clientCalls.some(c => /SET version_dirty_at = NULL/i.test(c.sql))).toBe(false);
  });

  it('подача больше не утверждена — пропускаем', async () => {
    setupSingleDirty(lockedRow({ status: 'returned' }));
    await __testing.runRebuildCycle();
    expect(materializeMock).not.toHaveBeenCalled();
  });

  it('второй экземпляр после ожидания лока видит version_dirty_at=NULL и не пересобирает', async () => {
    // seq при этом ТОТ ЖЕ — по нему одному отличить «задание уже сделано» нельзя.
    setupSingleDirty(lockedRow({ version_dirty_at: null }));
    await __testing.runRebuildCycle();

    expect(materializeMock).not.toHaveBeenCalled();
  });

  it('правка во время сборки изменила seq — пересборку не делаем, метка остаётся', async () => {
    setupSingleDirty(lockedRow({ version_dirty_seq: 4 }));
    await __testing.runRebuildCycle();

    expect(materializeMock).not.toHaveBeenCalled();
    expect(clientCalls.some(c => /SET version_dirty_at = NULL/i.test(c.sql))).toBe(false);
  });

  it('содержимое не изменилось — метка снята, новой редакции нет', async () => {
    setupSingleDirty(lockedRow());
    materializeMock.mockResolvedValue({ version: { revision: 1 }, created: false });

    await __testing.runRebuildCycle();

    expect(clientCalls.some(c => /SET version_dirty_at = NULL/i.test(c.sql))).toBe(true);
    // Редакции не появилось — обновлять статус в HR незачем.
    expect(invalidateMock).not.toHaveBeenCalled();
  });

  it('ошибка сборки: метка остаётся, выставляется backoff', async () => {
    setupSingleDirty(lockedRow());
    materializeMock.mockRejectedValue(new Error('boom'));

    await __testing.runRebuildCycle();

    const retry = pgQuery.mock.calls
      .map(call => String(call[0]))
      .find(sql => /version_rebuild_attempts   = version_rebuild_attempts \+ 1/.test(sql));
    expect(retry).toBeDefined();
    expect(retry).toContain('version_rebuild_after');
    expect(clientCalls.some(c => /SET version_dirty_at = NULL/i.test(c.sql))).toBe(false);
  });

  it('падающая подача не мешает остальным в батче', async () => {
    pgQuery.mockImplementation(async (sql: string) => {
      if (/FROM timesheet_approvals\s+WHERE version_dirty_at IS NOT NULL/i.test(sql)) {
        return [dirtyRow({ id: 111 }), dirtyRow({ id: 222 })];
      }
      if (/FROM timesheet_approval_employees/i.test(sql)) return [{ employee_id: 501 }];
      return [];
    });
    clientHandler.fn = (sql) => (/FOR UPDATE/i.test(sql) ? [lockedRow()] : []);
    materializeMock
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ version: { revision: 2 }, created: true });

    await __testing.runRebuildCycle();

    expect(materializeMock).toHaveBeenCalledTimes(2);
    expect(invalidateMock).toHaveBeenCalledWith('timesheet-1c-status');
  });

  it('параллельный тик не запускается поверх текущего', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>(resolve => { release = resolve; });
    setupSingleDirty(lockedRow());
    materializeMock.mockImplementation(async () => {
      await gate;
      return { version: { revision: 2 }, created: true };
    });

    const first = __testing.runRebuildCycle();
    await __testing.runRebuildCycle(); // должен выйти сразу
    release!();
    await first;

    expect(materializeMock).toHaveBeenCalledOnce();
  });
});
