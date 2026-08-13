import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  query: vi.fn(),
  execute: vi.fn(),
  getCardBindings: vi.fn(),
  applyCardExpirationChange: vi.fn(),
  patchEmployeeCardBinding: vi.fn(),
  buildCardW26ById: vi.fn(),
  invalidateSigurDirectoryCaches: vi.fn(),
  acquireLease: vi.fn(),
  leaseLost: false,
  leaseRelease: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: h.query,
  execute: h.execute,
}));
vi.mock('./sigur.service.js', () => ({
  sigurService: {
    getCardBindings: h.getCardBindings,
    patchEmployeeCardBinding: h.patchEmployeeCardBinding,
  },
}));
vi.mock('./sigur-live-cards.service.js', () => ({
  applyCardExpirationChange: h.applyCardExpirationChange,
}));
vi.mock('./sigur-card-lease.service.js', () => ({
  acquireSigurCardLease: h.acquireLease,
  SigurCardLeaseBusyError: class extends Error {},
}));

const actualAdmin = await vi.importActual<typeof import('./sigur-live-admin.service.js')>(
  './sigur-live-admin.service.js',
);
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

const {
  previewBulkExtendCards,
  prepareBulkExtendOperation,
  executePreparedBulkExtend,
  normalizeEmployeeIds,
} = await import('./sigur-bulk-cards.service.js');

// Даты считаем от текущего момента: тест не должен «протухать» со временем.
const DAY_MS = 24 * 60 * 60 * 1000;
const isoIn = (days: number): string => new Date(Date.now() + days * DAY_MS).toISOString();
const dateIn = (days: number): string => isoIn(days).slice(0, 10);

const TARGET_DATE = dateIn(365);
const TARGET_ISO = new Date(`${TARGET_DATE}T23:59:59+03:00`).toISOString();

/** Действующая карта: начало в прошлом, срок раньше целевой даты. */
const binding = (over: Partial<{
  employeeId: number; cardId: number; startDate: string | null;
  expirationDate: string | null; format: string | null;
}> = {}) => ({
  employeeId: over.employeeId ?? 1,
  cardId: over.cardId ?? 100,
  startDate: over.startDate === undefined ? isoIn(-200) : over.startDate,
  expirationDate: over.expirationDate === undefined ? isoIn(60) : over.expirationDate,
  format: over.format === undefined ? 'W26' : over.format,
});

const noopProgress = () => undefined;

/** Ответ Sigur на getCardBindings: сервис фильтрует по employeeId/cardId сам. */
const respondBindings = (rows: ReturnType<typeof binding>[]) => {
  h.getCardBindings.mockImplementation(async (filters: Record<string, unknown>) => {
    const employeeFilter = String(filters.employeeId ?? '');
    const ids = employeeFilter.split(',').map(Number).filter(Boolean);
    return rows.filter(row => {
      if (ids.length > 0 && !ids.includes(row.employeeId)) return false;
      if (filters.cardId != null && row.cardId !== Number(filters.cardId)) return false;
      return true;
    });
  });
};

const prepareWithExpected = async (rows: ReturnType<typeof binding>[], over: Partial<{
  employeeIds: number[]; confirmExpired: boolean; expected: unknown[];
}> = {}) => {
  const employeeIds = over.employeeIds ?? [1];
  const expected = over.expected ?? rows.map(row => ({
    employeeId: row.employeeId,
    cardId: row.cardId,
    startDate: row.startDate,
    expirationDate: row.expirationDate,
    format: row.format,
  }));
  return prepareBulkExtendOperation({
    operationId: 'op-1',
    employeeIds,
    expirationDate: TARGET_DATE,
    confirmExpired: over.confirmExpired ?? false,
    expected: expected as never,
    connection: undefined,
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  h.leaseLost = false;
  h.query.mockResolvedValue([]);
  h.execute.mockResolvedValue(1);
  h.buildCardW26ById.mockResolvedValue(new Map());
  h.applyCardExpirationChange.mockResolvedValue({ cardId: 100 });
  h.acquireLease.mockImplementation(async () => ({
    owner: 'op-1',
    isLost: () => h.leaseLost,
    release: h.leaseRelease,
  }));
});

describe('normalizeEmployeeIds', () => {
  it('оставляет только положительные целые и дедуплицирует', () => {
    expect(normalizeEmployeeIds([1, 1, '2', 0, -3, 'x', 4.5])).toEqual([1, 2]);
  });
});

describe('маппер привязки', () => {
  it('нормализует format — он нужен для PATCH', () => {
    const mapped = actualAdmin.toEmployeeCardBinding({
      employeeId: 7, cardId: 70, startDate: 'a', expirationDate: 'b', format: 'W26',
    });
    expect(mapped).toMatchObject({ employeeId: 7, cardId: 70, format: 'W26' });
  });
});

describe('previewBulkExtendCards', () => {
  it('считает кандидатов и раскладывает пропуски по причинам', async () => {
    respondBindings([
      binding({ employeeId: 1, cardId: 100 }),
      binding({ employeeId: 2, cardId: 200, expirationDate: isoIn(500) }),
      binding({ employeeId: 3, cardId: 300, expirationDate: null }),
      binding({ employeeId: 4, cardId: 400, startDate: null }),
    ]);

    const preview = await previewBulkExtendCards({
      employeeIds: [1, 2, 3, 4],
      expirationDate: TARGET_DATE,
    });

    expect(preview.willExtendCards).toBe(1);
    expect(preview.byReason).toMatchObject({
      already_longer: 1,
      no_expiration: 1,
      no_start_date: 1,
    });
    expect(preview.cards).toHaveLength(1);
  });

  it('истёкшая карта попадает в кандидаты, но помечена expired', async () => {
    respondBindings([binding({ expirationDate: isoIn(-5) })]);

    const preview = await previewBulkExtendCards({ employeeIds: [1], expirationDate: TARGET_DATE });

    expect(preview.expiredCards).toBe(1);
    expect(preview.cards[0].expired).toBe(true);
  });

  it('сотрудник без карт не считается ошибкой', async () => {
    respondBindings([]);
    const preview = await previewBulkExtendCards({ employeeIds: [1], expirationDate: TARGET_DATE });
    expect(preview.noCardEmployees).toBe(1);
    expect(preview.unreadableEmployees).toBe(0);
  });

  it('неполный батч дочитывается индивидуально, а не объявляется «нет карты»', async () => {
    const rows = [binding({ employeeId: 1, cardId: 100 }), binding({ employeeId: 2, cardId: 200 })];
    h.getCardBindings.mockImplementation(async (filters: Record<string, unknown>) => {
      const raw = String(filters.employeeId ?? '');
      // Батч отвечает только про первого — как наблюдалось на проде.
      if (raw.includes(',')) return [rows[0]];
      return rows.filter(row => row.employeeId === Number(raw));
    });

    const preview = await previewBulkExtendCards({ employeeIds: [1, 2], expirationDate: TARGET_DATE });

    expect(preview.willExtendCards).toBe(2);
    expect(preview.noCardEmployees).toBe(0);
  });

  it('ошибка чтения даёт unreadable, а не «нет карты»', async () => {
    h.getCardBindings.mockRejectedValue(new Error('timeout'));
    const preview = await previewBulkExtendCards({ employeeIds: [1], expirationDate: TARGET_DATE });
    expect(preview.unreadableEmployees).toBe(1);
    expect(preview.noCardEmployees).toBe(0);
  });
});

describe('executePreparedBulkExtend', () => {
  it('пишет через общее ядро с исходным startDate и ISO конца дня МСК', async () => {
    const row = binding();
    respondBindings([row]);
    const prepared = await prepareWithExpected([row]);

    const result = await executePreparedBulkExtend(prepared, noopProgress);

    expect(h.patchEmployeeCardBinding).not.toHaveBeenCalled();
    expect(h.applyCardExpirationChange).toHaveBeenCalledWith(expect.objectContaining({
      sigurEmployeeId: 1,
      cardId: 100,
      startDate: row.startDate,
      expirationDate: TARGET_ISO,
      format: 'W26',
    }));
    expect(result.updatedCards).toBe(1);
    expect(result.updatedEmployees).toBe(1);
  });

  it('несколько карт сотрудника: ошибка одной не мешает второй', async () => {
    const rows = [binding({ cardId: 100 }), binding({ cardId: 101 })];
    respondBindings(rows);
    h.applyCardExpirationChange.mockImplementation(async ({ cardId }: { cardId: number }) => {
      if (cardId === 101) throw new Error('sigur 500');
      return { cardId };
    });

    const prepared = await prepareWithExpected(rows);
    const result = await executePreparedBulkExtend(prepared, noopProgress);

    expect(result.updatedCards).toBe(1);
    expect(result.failedCards).toBe(1);
    expect(result.updatedEmployees).toBe(1);
  });

  it('истёкшая карта без подтверждения пропускается, PATCH не уходит', async () => {
    const expired = binding({ expirationDate: isoIn(-5) });
    respondBindings([expired]);

    const prepared = await prepareWithExpected([expired], { confirmExpired: false });
    const result = await executePreparedBulkExtend(prepared, noopProgress);

    expect(h.applyCardExpirationChange).not.toHaveBeenCalled();
    expect(result.items[0]).toMatchObject({ status: 'skipped', reason: 'expired_not_confirmed' });
  });

  it('истёкшая карта с подтверждением продлевается и считается отдельно', async () => {
    const expired = binding({ expirationDate: isoIn(-5) });
    respondBindings([expired]);

    const prepared = await prepareWithExpected([expired], { confirmExpired: true });
    const result = await executePreparedBulkExtend(prepared, noopProgress);

    expect(result.updatedCards).toBe(1);
    expect(result.expiredExtendedCards).toBe(1);
  });

  it('карта, которой не было в предпросмотре, пропускается', async () => {
    const rows = [binding({ cardId: 100 }), binding({ cardId: 999 })];
    respondBindings(rows);

    const prepared = await prepareWithExpected(rows, {
      expected: [{
        employeeId: 1, cardId: 100,
        startDate: rows[0].startDate, expirationDate: rows[0].expirationDate, format: 'W26',
      }],
    });
    const result = await executePreparedBulkExtend(prepared, noopProgress);

    expect(result.items.find(item => item.cardId === 999)).toMatchObject({
      status: 'skipped', reason: 'not_in_preview',
    });
    expect(result.updatedCards).toBe(1);
  });

  it('дублирующая привязка не PATCH-ится', async () => {
    const rows = [binding({ cardId: 100 }), binding({ cardId: 100 })];
    respondBindings(rows);

    const prepared = await prepareWithExpected(rows);
    const result = await executePreparedBulkExtend(prepared, noopProgress);

    expect(h.applyCardExpirationChange).not.toHaveBeenCalled();
    expect(result.items.every(item => item.reason === 'duplicate_binding')).toBe(true);
  });

  it('дата начала в день целевой даты допустима', async () => {
    const sameDay = binding({ startDate: `${TARGET_DATE}T00:00:00.000Z` });
    respondBindings([sameDay]);

    const prepared = await prepareWithExpected([sameDay]);
    const result = await executePreparedBulkExtend(prepared, noopProgress);

    expect(result.updatedCards).toBe(1);
  });

  it('дата начала позже целевой — пропуск (Sigur отклонил бы PATCH)', async () => {
    const late = binding({ startDate: isoIn(400) });
    respondBindings([late]);

    const prepared = await prepareWithExpected([late]);
    const result = await executePreparedBulkExtend(prepared, noopProgress);

    expect(result.items[0]).toMatchObject({ status: 'skipped', reason: 'start_after_target' });
  });

  it('ошибка PATCH: срок уже целевой → extended_after_retry', async () => {
    const row = binding();
    let patched = false;
    h.getCardBindings.mockImplementation(async () => [
      patched ? { ...row, expirationDate: TARGET_ISO } : row,
    ]);
    h.applyCardExpirationChange.mockImplementation(async () => {
      patched = true;
      throw new Error('socket hang up');
    });

    const prepared = await prepareWithExpected([row]);
    const result = await executePreparedBulkExtend(prepared, noopProgress);

    expect(result.retriedCards).toBe(1);
    expect(result.updatedCards).toBe(1);
    expect(result.failedCards).toBe(0);
  });

  it('ошибка PATCH: срок прежний → failed', async () => {
    respondBindings([binding()]);
    h.applyCardExpirationChange.mockRejectedValue(new Error('sigur 400'));

    const prepared = await prepareWithExpected([binding()]);
    const result = await executePreparedBulkExtend(prepared, noopProgress);

    expect(result.failedCards).toBe(1);
    expect(result.items[0].status).toBe('failed');
  });

  it('ошибка PATCH: срок чужой → changed_during_write с фактическим значением', async () => {
    const row = binding();
    const foreign = isoIn(700);
    let patched = false;
    h.getCardBindings.mockImplementation(async () => [
      patched ? { ...row, expirationDate: foreign } : row,
    ]);
    h.applyCardExpirationChange.mockImplementation(async () => {
      patched = true;
      throw new Error('sigur 500');
    });

    const prepared = await prepareWithExpected([row]);
    const result = await executePreparedBulkExtend(prepared, noopProgress);

    expect(result.changedDuringWriteCards).toBe(1);
    expect(result.items[0].observedExpiration).toBe(foreign);
  });

  it('ошибка PATCH + недоступное чтение → unknown', async () => {
    const row = binding();
    let patched = false;
    h.getCardBindings.mockImplementation(async () => {
      if (patched) throw new Error('read timeout');
      return [row];
    });
    h.applyCardExpirationChange.mockImplementation(async () => {
      patched = true;
      throw new Error('sigur 502');
    });

    const prepared = await prepareWithExpected([row]);
    const result = await executePreparedBulkExtend(prepared, noopProgress);

    expect(result.unknownCards).toBe(1);
  });

  it('перечитывание перед записью ловит чужую правку срока', async () => {
    const row = binding();
    let prepareDone = false;
    h.getCardBindings.mockImplementation(async () => [
      prepareDone ? { ...row, expirationDate: isoIn(600) } : row,
    ]);

    const prepared = await prepareWithExpected([row]);
    prepareDone = true;
    const result = await executePreparedBulkExtend(prepared, noopProgress);

    expect(h.applyCardExpirationChange).not.toHaveBeenCalled();
    expect(result.items[0]).toMatchObject({ status: 'skipped', reason: 'changed_since_snapshot' });
  });

  it('потеря lease останавливает новые записи', async () => {
    const rows = [binding({ cardId: 100 }), binding({ cardId: 101 })];
    respondBindings(rows);
    const prepared = await prepareWithExpected(rows);
    h.leaseLost = true;

    const result = await executePreparedBulkExtend(prepared, noopProgress);

    expect(h.applyCardExpirationChange).not.toHaveBeenCalled();
    expect(result.warnings.some(warning => warning.includes('Блокировка'))).toBe(true);
  });
});
