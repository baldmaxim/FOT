import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/node';

const m = vi.hoisted(() => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
  clientQuery: vi.fn(),
  bgConn: vi.fn(),
  invalidateCards: vi.fn(),
  getCardsCached: vi.fn(),
  collect: vi.fn(),
  readLive: vi.fn(),
  acquireLease: vi.fn(),
  releaseLease: vi.fn(),
  leaseLost: { value: false },
  logWithClient: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({ query: m.query, withTransaction: m.withTransaction }));
vi.mock('./sigur.service.js', () => ({
  sigurService: {
    getBackgroundConnectionType: m.bgConn,
    invalidateCardListCache: m.invalidateCards,
    getCardsCached: m.getCardsCached,
  },
}));
vi.mock('./sigur-bulk-cards.service.js', () => ({ collectCardBindings: m.collect }));
vi.mock('./old-card-block.collect.js', () => ({ readLiveBindingsByCard: m.readLive }));
vi.mock('./sigur-card-lease.service.js', () => ({ acquireSigurCardLease: m.acquireLease }));
vi.mock('./audit.service.js', () => ({
  auditService: { logWithClient: m.logWithClient },
  AUDIT_ACTIONS: { CONTRACTOR_PASS_EXPIRY_SYNCED: 'CONTRACTOR_PASS_EXPIRY_SYNCED' },
}));
vi.mock('./sigur-live-admin.service.js', () => ({
  normalizeInt: (value: unknown): number | null => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed)) return parsed;
    }
    return null;
  },
}));
vi.mock('./sigur-sync-shared.js', () => ({
  resolveField: (obj: Record<string, unknown>, ...keys: string[]): unknown =>
    keys.map(key => obj[key]).find(value => value !== undefined),
}));

import {
  buildCardIdsByW26,
  isMassChange,
  planPassExpiryChanges,
  runContractorPassExpirySync,
  sigurExpirationToMoscowDate,
  type IExpiryPassRow,
} from './contractor-pass-expiry-sync.service.js';
import type { IEmployeeCardBinding } from './sigur-live-admin.service.js';

// ── фикстуры ────────────────────────────────────────────────────────────────────────

/** Запись каталога Sigur: value — 6 hex (deriveCardW26 его не принимает), W26 — из formattedValue. */
const catalogCard = (id: number | string, formatted: string, value = 'ABCDEF'): Record<string, unknown> =>
  ({ id, value, formattedValue: formatted });

const passRow = (over: Partial<IExpiryPassRow> = {}): IExpiryPassRow => ({
  id: 'pass-64',
  pass_number: '64',
  sigur_employee_id: 100,
  card_uid: '72,30689',
  // CSN: W26 здесь — первые 3 байта; deriveCardW26 вывел бы из него чужой 119,57600.
  card_hex_uid: '4877E100',
  expires_at: '2026-12-31',
  ...over,
});

const binding = (employeeId: number, cardId: number | null, expirationDate: string | null): IEmployeeCardBinding =>
  ({ employeeId, cardId, expirationDate, startDate: '2026-06-06 21:00:00', format: 'W26' });

const plan = (params: {
  passes: IExpiryPassRow[];
  bindings?: IEmployeeCardBinding[];
  unreadable?: number[];
  catalog?: Record<string, unknown>[];
}) => {
  const byEmployee = new Map<number, IEmployeeCardBinding[]>();
  (params.bindings ?? []).forEach(item => {
    byEmployee.set(item.employeeId, [...(byEmployee.get(item.employeeId) ?? []), item]);
  });
  return planPassExpiryChanges({
    passes: params.passes,
    bindingsByEmployee: byEmployee,
    unreadableEmployeeIds: new Set(params.unreadable ?? []),
    cardIdsByW26: buildCardIdsByW26(params.catalog ?? [catalogCard(500, '072,30689')]),
  });
};

// ── дата ────────────────────────────────────────────────────────────────────────────

describe('sigurExpirationToMoscowDate', () => {
  it('строка с зоной — дата по МСК, переход через полночь МСК в обе стороны', () => {
    expect(sigurExpirationToMoscowDate('2026-12-31T20:59:59Z')).toEqual({ kind: 'date', date: '2026-12-31' });
    expect(sigurExpirationToMoscowDate('2026-12-31T20:59:59.999Z')).toEqual({ kind: 'date', date: '2026-12-31' });
    expect(sigurExpirationToMoscowDate('2026-12-31T21:00:00Z')).toEqual({ kind: 'date', date: '2027-01-01' });
    expect(sigurExpirationToMoscowDate('2026-12-31T23:59:59+03:00')).toEqual({ kind: 'date', date: '2026-12-31' });
    expect(sigurExpirationToMoscowDate('2027-01-01T00:30:00+03:00')).toEqual({ kind: 'date', date: '2027-01-01' });
    expect(sigurExpirationToMoscowDate('2026-12-31T23:59:59+0300')).toEqual({ kind: 'date', date: '2026-12-31' });
  });

  it('слетевший пояс Sigur (+02:00) переводится через момент времени', () => {
    // 23:30+02:00 = 21:30Z = 00:30 МСК следующих суток.
    expect(sigurExpirationToMoscowDate('2026-12-31T23:30:00+02:00')).toEqual({ kind: 'date', date: '2027-01-01' });
    expect(sigurExpirationToMoscowDate('2026-12-31T20:00:00+02:00')).toEqual({ kind: 'date', date: '2026-12-31' });
  });

  it('строка без зоны — дата как есть, без пересчёта поясом процесса', () => {
    expect(sigurExpirationToMoscowDate('2026-12-31 20:59:59')).toEqual({ kind: 'date', date: '2026-12-31' });
    expect(sigurExpirationToMoscowDate('2026-12-31 23:59:59')).toEqual({ kind: 'date', date: '2026-12-31' });
    expect(sigurExpirationToMoscowDate('2026-12-31T00:00')).toEqual({ kind: 'date', date: '2026-12-31' });
    expect(sigurExpirationToMoscowDate('2026-12-31')).toEqual({ kind: 'date', date: '2026-12-31' });
  });

  it('результат не зависит от пояса процесса', () => {
    // Под МСК «дата-часть» и «new Date + дата МСК» совпадают — разница видна только в чужом поясе.
    const saved = process.env.TZ;
    try {
      for (const tz of ['UTC', 'Asia/Almaty', 'America/New_York']) {
        process.env.TZ = tz;
        expect(sigurExpirationToMoscowDate('2026-12-31 23:59:59'), tz).toEqual({ kind: 'date', date: '2026-12-31' });
        expect(sigurExpirationToMoscowDate('2026-12-31 00:30:00'), tz).toEqual({ kind: 'date', date: '2026-12-31' });
        expect(sigurExpirationToMoscowDate('2026-12-31T21:00:00Z'), tz).toEqual({ kind: 'date', date: '2027-01-01' });
      }
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });

  it('мусор и несуществующие даты — invalid, а не соседний день', () => {
    for (const raw of [
      '2026-12-31 garbage',
      '2026-02-30',
      '2026-02-30 10:00:00',
      '2026-02-30T10:00:00Z',
      '2026-12-31T25:00:00',
      '2026-12-31T10:60:00Z',
      '2026-12-31T10:00:00+15:00',
      '31.12.2026',
      'бессрочно',
    ]) {
      expect(sigurExpirationToMoscowDate(raw), raw).toEqual({ kind: 'invalid' });
    }
  });

  it('пусто — бессрочно', () => {
    expect(sigurExpirationToMoscowDate(null)).toEqual({ kind: 'indefinite' });
    expect(sigurExpirationToMoscowDate(undefined)).toEqual({ kind: 'indefinite' });
    expect(sigurExpirationToMoscowDate('   ')).toEqual({ kind: 'indefinite' });
  });
});

// ── каталог и сопоставление ────────────────────────────────────────────────────────

describe('buildCardIdsByW26', () => {
  it('канонический W26, повтор той же записи не даёт неоднозначности', () => {
    const index = buildCardIdsByW26([
      catalogCard(500, '072,30689'),
      catalogCard('500', '72,30689'),
      catalogCard(501, '038,60836'),
      catalogCard(502, '038,60836'),
      { id: 503, value: 'ABCDEF' },
    ]);
    expect([...(index.get('072,30689') ?? [])]).toEqual([500]);
    expect([...(index.get('038,60836') ?? [])]).toEqual([501, 502]);
    expect(index.size).toBe(2);
  });
});

describe('planPassExpiryChanges', () => {
  it('срок в Sigur другой — правка; совпадает — без изменений', () => {
    const changed = plan({ passes: [passRow()], bindings: [binding(100, 500, '2027-03-31T20:59:59Z')] });
    expect(changed.changes).toEqual([expect.objectContaining({
      passId: 'pass-64',
      cardId: 500,
      oldExpiresAt: '2026-12-31',
      newExpiresAt: '2027-03-31',
      sigurExpiration: '2027-03-31T20:59:59Z',
      outcome: 'planned',
    })]);

    const same = plan({ passes: [passRow()], bindings: [binding(100, 500, '2026-12-31 20:59:59')] });
    expect(same.changes).toEqual([]);
    expect(same.unchanged).toBe(1);
  });

  it('сокращение срока и заполнение пустого', () => {
    const shorter = plan({ passes: [passRow()], bindings: [binding(100, 500, '2026-10-01T20:59:59Z')] });
    expect(shorter.changes[0]).toMatchObject({ oldExpiresAt: '2026-12-31', newExpiresAt: '2026-10-01' });

    const filled = plan({ passes: [passRow({ expires_at: null })], bindings: [binding(100, 500, '2026-12-31T20:59:59Z')] });
    expect(filled.changes[0]).toMatchObject({ oldExpiresAt: null, newExpiresAt: '2026-12-31' });
  });

  it('бессрочная привязка → NULL; уже NULL — без изменений', () => {
    const indefinite = plan({ passes: [passRow()], bindings: [binding(100, 500, null)] });
    expect(indefinite.changes[0]).toMatchObject({ oldExpiresAt: '2026-12-31', newExpiresAt: null });

    const alreadyNull = plan({ passes: [passRow({ expires_at: null })], bindings: [binding(100, 500, null)] });
    expect(alreadyNull.changes).toEqual([]);
    expect(alreadyNull.unchanged).toBe(1);
  });

  it('нераспознанный срок — в отчёт, не в NULL', () => {
    const result = plan({ passes: [passRow()], bindings: [binding(100, 500, '31.12.2026')] });
    expect(result.changes).toEqual([]);
    expect(result.skipped.invalid_date).toEqual(['64']);
  });

  it('W26 только из card_uid: CSN в card_hex_uid на матч не влияет', () => {
    const result = plan({
      passes: [passRow()],
      // Карта с W26 «из CSN» тоже привязана к профилю — её трогать нельзя.
      catalog: [catalogCard(500, '072,30689'), catalogCard(900, '119,57600')],
      bindings: [binding(100, 500, '2027-01-31T20:59:59Z'), binding(100, 900, '2030-01-01T20:59:59Z')],
    });
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({ cardId: 500, newExpiresAt: '2027-01-31' });
  });

  it('card_uid кадром ридера разбирается так же, как W26', () => {
    const result = plan({
      passes: [passRow({ card_uid: '184877E100000000', card_hex_uid: null })],
      bindings: [binding(100, 500, '2027-01-31T20:59:59Z')],
    });
    expect(result.changes[0]).toMatchObject({ cardId: 500, newExpiresAt: '2027-01-31' });
  });

  it('неоднозначность и отсутствие привязки — в отчёт без правок', () => {
    const result = plan({
      passes: [
        passRow({ id: 'a', pass_number: '1', card_uid: 'мусор' }),
        passRow({ id: 'b', pass_number: '2', card_uid: '99,1' }),
        passRow({ id: 'c', pass_number: '3', card_uid: '38,60836', sigur_employee_id: 103 }),
        passRow({ id: 'd', pass_number: '4', card_uid: '40,1', sigur_employee_id: 104 }),
        passRow({ id: 'e', pass_number: '5', card_uid: '40,1', sigur_employee_id: 105 }),
        passRow({ id: 'f', pass_number: '6', card_uid: '41,1', sigur_employee_id: 106 }),
        passRow({ id: 'g', pass_number: '7', card_uid: '42,1', sigur_employee_id: 107 }),
        passRow({ id: 'h', pass_number: '8', card_uid: '43,1', sigur_employee_id: 108 }),
        passRow({ id: 'i', pass_number: '9', card_uid: '44,1', sigur_employee_id: 109 }),
      ],
      catalog: [
        catalogCard(601, '038,60836'), catalogCard(602, '038,60836'),
        catalogCard(700, '040,00001'),
        catalogCard(710, '041,00001'),
        catalogCard(720, '042,00001'),
        catalogCard(730, '043,00001'),
        catalogCard(740, '044,00001'),
      ],
      bindings: [
        binding(104, 700, '2027-01-31T20:59:59Z'),
        binding(105, 700, '2027-01-31T20:59:59Z'),
        binding(106, 710, '2027-01-31T20:59:59Z'),
        // 107: карта 720 на ДРУГОМ профиле, у самого 107 — чужая карта.
        binding(999, 720, '2027-01-31T20:59:59Z'),
        binding(107, 730, '2027-01-31T20:59:59Z'),
        binding(108, 730, '2027-01-31T20:59:59Z'),
        binding(108, 730, '2027-01-31T20:59:59Z'),
      ],
      unreadable: [106],
    });

    expect(result.changes).toEqual([]);
    expect(result.skipped).toEqual({
      invalid_card_uid: ['1'],
      ambiguous_w26: ['3'],
      card_multi_pass: ['4', '5'],
      no_binding: ['2', '7', '9'],
      duplicate_binding: ['8'],
      invalid_date: [],
      unreadable: ['6'],
    });
    expect(result.eligible).toBe(9);
  });
});

describe('isMassChange', () => {
  it('строгие границы: > 100 правок И > половины скоупа', () => {
    expect(isMassChange(100, 100)).toBe(false);
    expect(isMassChange(101, 202)).toBe(false);
    expect(isMassChange(101, 201)).toBe(true);
    expect(isMassChange(0, 0)).toBe(false);
  });
});

// ── прогон ──────────────────────────────────────────────────────────────────────────

interface IWire {
  passes?: IExpiryPassRow[];
  bindings?: IEmployeeCardBinding[];
  unreadable?: number[];
  catalog?: Record<string, unknown>[];
  live?: (cardId: number) => Promise<Array<Record<string, unknown>>>;
  rowCount?: number;
}

const wire = ({
  passes = [passRow()],
  bindings = [binding(100, 500, '2027-03-31T20:59:59Z')],
  unreadable = [],
  catalog = [catalogCard(500, '072,30689')],
  live,
  rowCount = 1,
}: IWire = {}): void => {
  const byEmployee = new Map<number, IEmployeeCardBinding[]>();
  bindings.forEach(item => byEmployee.set(item.employeeId, [...(byEmployee.get(item.employeeId) ?? []), item]));
  m.query.mockResolvedValue(passes);
  m.collect.mockResolvedValue({ byEmployee, unreadable });
  m.getCardsCached.mockResolvedValue(catalog);
  m.readLive.mockImplementation(live ?? (async (cardId: number) =>
    bindings
      .filter(item => item.cardId === cardId)
      .map(item => ({ employeeId: item.employeeId, cardId, startDate: item.startDate, expirationDate: item.expirationDate }))));
  m.clientQuery.mockResolvedValue({ rowCount });
};

beforeEach(() => {
  vi.clearAllMocks();
  m.leaseLost.value = false;
  m.bgConn.mockResolvedValue('external');
  m.acquireLease.mockResolvedValue({ owner: 'o', isLost: () => m.leaseLost.value, release: m.releaseLease });
  m.withTransaction.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => fn({ query: m.clientQuery }));
  m.logWithClient.mockResolvedValue(undefined);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('runContractorPassExpirySync', () => {
  it('dry-run: без lock, без перечитывания и без записи', async () => {
    wire();
    const result = await runContractorPassExpirySync({ dryRun: true, triggeredBy: 'cli' });

    expect(result.status).toBe('completed');
    expect(result.changes).toHaveLength(1);
    expect(result.updated).toBe(0);
    expect(m.acquireLease).not.toHaveBeenCalled();
    expect(m.readLive).not.toHaveBeenCalled();
    expect(m.withTransaction).not.toHaveBeenCalled();
  });

  it('apply: перечитывание по карте, CAS по снимку и аудит в одной транзакции', async () => {
    wire();
    const result = await runContractorPassExpirySync({ dryRun: false, triggeredBy: 'scheduler' });

    expect(result.status).toBe('completed');
    expect(result.updated).toBe(1);
    expect(result.changes[0].outcome).toBe('updated');
    expect(m.readLive).toHaveBeenCalledWith(500, 'external');
    // Каталог читается заново, а не из 60-секундного кэша.
    expect(m.invalidateCards.mock.invocationCallOrder[0]).toBeLessThan(m.getCardsCached.mock.invocationCallOrder[0]);
    // Lock берётся ДО снимка БД.
    expect(m.acquireLease.mock.invocationCallOrder[0]).toBeLessThan(m.query.mock.invocationCallOrder[0]);

    const [sql, params] = m.clientQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('card_uid IS NOT DISTINCT FROM $4::text');
    expect(sql).toContain('card_hex_uid IS NOT DISTINCT FROM $5::text');
    expect(sql).toContain('expires_at IS NOT DISTINCT FROM $6::date');
    expect(sql).toContain("(status = 'applied' OR is_active = true)");
    expect(params).toEqual(['2027-03-31', 'pass-64', 100, '72,30689', '4877E100', '2026-12-31']);

    expect(m.logWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      user_id: null,
      action: 'CONTRACTOR_PASS_EXPIRY_SYNCED',
      entity_type: 'contractor_pass',
      entity_id: 'pass-64',
      details: expect.objectContaining({
        pass_number: '64',
        old_expires_at: '2026-12-31',
        new_expires_at: '2027-03-31',
        sigur_employee_id: 100,
        card_id: 500,
        run_id: result.runId,
        triggered_by: 'scheduler',
      }),
    }));
    expect(m.releaseLease).toHaveBeenCalledTimes(1);
  });

  it('повторный прогон по актуальным данным — 0 правок', async () => {
    wire({ passes: [passRow({ expires_at: '2027-03-31' })] });
    const result = await runContractorPassExpirySync({ dryRun: false, triggeredBy: 'scheduler' });

    expect(result.status).toBe('completed');
    expect(result.changes).toEqual([]);
    expect(result.unchanged).toBe(1);
    expect(m.withTransaction).not.toHaveBeenCalled();
  });

  it('бессрочная: перечитывание обязано снова показать бессрочность', async () => {
    wire({ bindings: [binding(100, 500, null)] });
    const ok = await runContractorPassExpirySync({ dryRun: false, triggeredBy: 'scheduler' });
    expect(ok.updated).toBe(1);
    expect((m.clientQuery.mock.calls[0] as [string, unknown[]])[1][0]).toBeNull();

    vi.clearAllMocks();
    m.acquireLease.mockResolvedValue({ owner: 'o', isLost: () => false, release: m.releaseLease });
    m.withTransaction.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => fn({ query: m.clientQuery }));
    m.bgConn.mockResolvedValue('external');
    wire({
      bindings: [binding(100, 500, null)],
      live: async () => [{ employeeId: 100, cardId: 500, startDate: null, expirationDate: '2027-01-31T20:59:59Z' }],
    });
    const changed = await runContractorPassExpirySync({ dryRun: false, triggeredBy: 'scheduler' });
    expect(changed.status).toBe('partial');
    expect(changed.writeIssues.changed_during_run).toEqual(['64']);
    expect(m.withTransaction).not.toHaveBeenCalled();
  });

  it('пустой каталог — фатальная ошибка, lock отпущен', async () => {
    wire({ catalog: [] });
    await expect(runContractorPassExpirySync({ dryRun: false, triggeredBy: 'scheduler' }))
      .rejects.toThrow('Каталог карт Sigur пуст');
    expect(m.withTransaction).not.toHaveBeenCalled();
    expect(m.releaseLease).toHaveBeenCalledTimes(1);
  });

  it('lock занят — прогон не начинается', async () => {
    wire();
    m.acquireLease.mockRejectedValue(new Error('busy'));
    await expect(runContractorPassExpirySync({ dryRun: false, triggeredBy: 'scheduler' })).rejects.toThrow('busy');
    expect(m.query).not.toHaveBeenCalled();
  });

  describe('предохранитель', () => {
    const massive = (changed: number, total: number): IWire => {
      const passes: IExpiryPassRow[] = [];
      const catalog: Record<string, unknown>[] = [];
      const bindings: IEmployeeCardBinding[] = [];
      for (let i = 1; i <= total; i += 1) {
        passes.push(passRow({ id: `p${i}`, pass_number: String(i), sigur_employee_id: 1000 + i, card_uid: `10,${i}` }));
        catalog.push(catalogCard(5000 + i, `010,${String(i).padStart(5, '0')}`));
        bindings.push(binding(1000 + i, 5000 + i, i <= changed ? '2027-06-30T20:59:59Z' : '2026-12-31T20:59:59Z'));
      }
      return { passes, catalog, bindings };
    };

    it('101 из 201 — блок: ни UPDATE, ни аудита, одно событие в Sentry', async () => {
      wire(massive(101, 201));
      const result = await runContractorPassExpirySync({ dryRun: false, triggeredBy: 'scheduler' });

      expect(result.status).toBe('blocked');
      expect(result.massChange).toBe(true);
      expect(m.withTransaction).not.toHaveBeenCalled();
      expect(m.logWithClient).not.toHaveBeenCalled();
      expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    });

    it('101 из 202 — не блок', async () => {
      wire(massive(101, 202));
      const result = await runContractorPassExpirySync({ dryRun: false, triggeredBy: 'scheduler' });
      expect(result.status).toBe('completed');
      expect(result.updated).toBe(101);
    });

    it('dry-run показывает блок, но в Sentry не шлёт; force снимает только предохранитель', async () => {
      wire(massive(101, 201));
      const dry = await runContractorPassExpirySync({ dryRun: true, triggeredBy: 'cli' });
      expect(dry.status).toBe('blocked');
      expect(Sentry.captureMessage).not.toHaveBeenCalled();

      const forced = await runContractorPassExpirySync({ dryRun: false, force: true, triggeredBy: 'cli' });
      expect(forced.status).toBe('completed');
      expect(forced.updated).toBe(101);
      expect(m.readLive).toHaveBeenCalledTimes(101);
    });
  });

  describe('временные сбои → partial', () => {
    it('перечитывание: карта на другом профиле, две привязки, ошибка чтения', async () => {
      const passes = [
        passRow({ id: 'a', pass_number: '1', sigur_employee_id: 101, card_uid: '20,1' }),
        passRow({ id: 'b', pass_number: '2', sigur_employee_id: 102, card_uid: '20,2' }),
        passRow({ id: 'c', pass_number: '3', sigur_employee_id: 103, card_uid: '20,3' }),
      ];
      wire({
        passes,
        catalog: [catalogCard(801, '020,00001'), catalogCard(802, '020,00002'), catalogCard(803, '020,00003')],
        bindings: [
          binding(101, 801, '2027-01-31T20:59:59Z'),
          binding(102, 802, '2027-01-31T20:59:59Z'),
          binding(103, 803, '2027-01-31T20:59:59Z'),
        ],
        live: async (cardId: number) => {
          if (cardId === 801) return [{ employeeId: 555, cardId, startDate: null, expirationDate: '2027-01-31T20:59:59Z' }];
          if (cardId === 802) {
            return [
              { employeeId: 102, cardId, startDate: null, expirationDate: '2027-01-31T20:59:59Z' },
              { employeeId: 102, cardId, startDate: null, expirationDate: '2027-01-31T20:59:59Z' },
            ];
          }
          throw new Error('Sigur timeout');
        },
      });

      const result = await runContractorPassExpirySync({ dryRun: false, triggeredBy: 'scheduler' });
      expect(result.status).toBe('partial');
      expect(result.writeIssues.changed_during_run).toEqual(['1', '2']);
      expect(result.writeIssues.reread_failed).toEqual(['3']);
      expect(m.withTransaction).not.toHaveBeenCalled();
    });

    it('CAS вернул 0 строк — conflict, без аудита', async () => {
      wire({ rowCount: 0 });
      const result = await runContractorPassExpirySync({ dryRun: false, triggeredBy: 'scheduler' });
      expect(result.status).toBe('partial');
      expect(result.writeIssues.conflict).toEqual(['64']);
      expect(result.updated).toBe(0);
      expect(m.logWithClient).not.toHaveBeenCalled();
    });

    it('ошибка аудита откатывает транзакцию — правка не засчитана', async () => {
      wire();
      m.logWithClient.mockRejectedValue(new Error('audit insert failed'));
      const result = await runContractorPassExpirySync({ dryRun: false, triggeredBy: 'scheduler' });
      expect(result.status).toBe('partial');
      expect(result.updated).toBe(0);
      expect(result.writeIssues.db_error).toEqual(['64']);
      expect(result.changes[0].outcome).toBe('db_error');
      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    });

    it('непрочитанный профиль — partial и в dry-run', async () => {
      wire({ unreadable: [100] });
      const result = await runContractorPassExpirySync({ dryRun: true, triggeredBy: 'cli' });
      expect(result.status).toBe('partial');
      expect(result.skipped.unreadable).toEqual(['64']);
    });

    it('потеря lock карт или сигнал планировщика — остановка записи', async () => {
      wire();
      m.leaseLost.value = true;
      const lost = await runContractorPassExpirySync({ dryRun: false, triggeredBy: 'scheduler' });
      expect(lost.status).toBe('partial');
      expect(lost.writeIssues.aborted).toEqual(['64']);
      expect(m.readLive).not.toHaveBeenCalled();

      m.leaseLost.value = false;
      const aborted = await runContractorPassExpirySync({
        dryRun: false,
        triggeredBy: 'scheduler',
        shouldAbort: () => true,
      });
      expect(aborted.writeIssues.aborted).toEqual(['64']);
      expect(m.withTransaction).not.toHaveBeenCalled();
    });
  });
});
