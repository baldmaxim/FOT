import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request } from 'express';

const db = vi.hoisted(() => {
  const txClient = { query: vi.fn() };
  return {
    txClient,
    pgQuery: vi.fn(),
    pgTx: vi.fn(async (fn: (client: typeof txClient) => Promise<unknown>) => fn(txClient)),
  };
});
vi.mock('../config/postgres.js', () => ({ query: db.pgQuery, withTransaction: db.pgTx }));

const audit = vi.hoisted(() => ({ logFromRequestWithClient: vi.fn(async () => undefined) }));
vi.mock('./audit.service.js', () => ({ auditService: audit }));

const shared = vi.hoisted(() => ({ invalidate: vi.fn(), cacheEntry: vi.fn(() => null) }));
vi.mock('./skud-shared.service.js', () => ({
  invalidateInternalPointsCache: shared.invalidate,
  getAccessPointCacheEntry: shared.cacheEntry,
}));
vi.mock('./sigur.service.js', () => ({ sigurService: { isConfigured: vi.fn(async () => false), getAccessPoints: vi.fn() } }));

const worker = vi.hoisted(() => ({ kick: vi.fn() }));
vi.mock('./access-point-zone-reconcile.service.js', () => ({ kickAccessPointZoneReconcile: worker.kick }));

import {
  AccessPointZoneError, applyZoneChange, changeAccessPointZone, validateZoneEffectiveDate,
} from './access-point-zone.service.js';

const actor = { req: { ip: '127.0.0.1', headers: {}, socket: {} } as unknown as Request, userId: 'u-1' };

/** История точки, которую вернёт SELECT внутри транзакции. */
const mockTimeline = (rows: Array<{ is_internal: boolean; effective_from: string }>): void => {
  db.txClient.query.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM skud_access_point_zone_periods')) return { rows };
    if (sql.includes('INSERT INTO skud_access_point_zone_reconcile')) return { rows: [{ id: 7 }] };
    return { rows: [] };
  });
};

const sqlCalls = (fragment: string): unknown[][] =>
  db.txClient.query.mock.calls.filter(call => String(call[0]).includes(fragment));

beforeEach(() => {
  vi.useFakeTimers();
  // 13.10.2026 12:00 МСК — пример из постановки.
  vi.setSystemTime(new Date('2026-10-13T09:00:00Z'));
  db.txClient.query.mockReset();
  db.pgQuery.mockReset().mockResolvedValue([{ found: true }]);
  db.pgTx.mockClear();
  audit.logFromRequestWithClient.mockClear();
  shared.invalidate.mockClear();
  worker.kick.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('validateZoneEffectiveDate — не раньше 1-го числа текущего месяца и не позже сегодня', () => {
  it('13 октября: сентябрь нельзя, с 01.10 по 13.10 можно, 14.10 нельзя', () => {
    expect(validateZoneEffectiveDate('2026-09-01')).toContain('01.10.2026');
    expect(validateZoneEffectiveDate('2026-09-30')).toContain('01.10.2026');
    expect(validateZoneEffectiveDate('2026-10-01')).toBeNull();
    expect(validateZoneEffectiveDate('2026-10-13')).toBeNull();
    expect(validateZoneEffectiveDate('2026-10-14')).toContain('13.10.2026');
  });

  it('несуществующая дата отклоняется', () => {
    expect(validateZoneEffectiveDate('2026-10-32')).toBe('Некорректная дата');
    expect(validateZoneEffectiveDate('13.10.2026')).toBe('Некорректная дата');
  });

  it('границы считаются по Москве, а не по UTC', () => {
    // 31.10 22:30 UTC = 01.11 01:30 МСК: текущий месяц уже ноябрь.
    const now = new Date('2026-10-31T22:30:00Z');
    expect(validateZoneEffectiveDate('2026-10-31', now)).toContain('01.11.2026');
    expect(validateZoneEffectiveDate('2026-11-01', now)).toBeNull();
  });
});

describe('applyZoneChange — история точки после смены типа', () => {
  const internalAlways = [{ is_internal: true, effective_from: '2000-01-01' }];

  it('внутренняя → внешняя с 01.10 добавляет строку', () => {
    const { after, removed, inserted } = applyZoneChange(internalAlways, false, '2026-10-01');
    expect(inserted).toEqual({ is_internal: false, effective_from: '2026-10-01' });
    expect(removed).toEqual([]);
    expect(after).toEqual([...internalAlways, { is_internal: false, effective_from: '2026-10-01' }]);
  });

  it('возврат типа с той же даты схлопывает историю — лишней пары строк не остаётся', () => {
    const before = [...internalAlways, { is_internal: false, effective_from: '2026-10-01' }];
    const { after, removed, inserted } = applyZoneChange(before, true, '2026-10-01');
    expect(inserted).toBeNull();
    expect(removed).toEqual([{ is_internal: false, effective_from: '2026-10-01' }]);
    expect(after).toEqual(internalAlways);
  });

  it('смена с более ранней даты месяца заменяет более позднюю', () => {
    const before = [...internalAlways, { is_internal: false, effective_from: '2026-10-10' }];
    const { after, removed } = applyZoneChange(before, false, '2026-10-05');
    expect(removed).toEqual([{ is_internal: false, effective_from: '2026-10-10' }]);
    expect(after).toEqual([...internalAlways, { is_internal: false, effective_from: '2026-10-05' }]);
  });

  it('точка без истории внешняя: «внутренняя с 05.10» — одна строка, «внешняя» — ничего', () => {
    expect(applyZoneChange([], true, '2026-10-05').after).toEqual([{ is_internal: true, effective_from: '2026-10-05' }]);
    expect(applyZoneChange([], false, '2026-10-05').after).toEqual([]);
  });
});

describe('changeAccessPointZone', () => {
  it('дата раньше 1-го числа месяца → 400, в БД не ходим', async () => {
    await expect(changeAccessPointZone(
      { accessPointName: 'кпп ASTERUS', isInternal: false, effectiveFrom: '2026-09-01' }, actor,
    )).rejects.toMatchObject({ status: 400 });
    expect(db.pgTx).not.toHaveBeenCalled();
  });

  it('неизвестная точка → 400 (история для опечатки не создаётся)', async () => {
    db.pgQuery.mockResolvedValue([{ found: false }]);
    await expect(changeAccessPointZone(
      { accessPointName: 'кпп ASTERUSS', isInternal: false, effectiveFrom: '2026-10-01' }, actor,
    )).rejects.toBeInstanceOf(AccessPointZoneError);
    expect(db.pgTx).not.toHaveBeenCalled();
  });

  it('смена типа: блокировка по имени, запись истории, задача пересборки и аудит — в одной транзакции', async () => {
    mockTimeline([{ is_internal: true, effective_from: '2000-01-01' }]);

    const result = await changeAccessPointZone(
      { accessPointName: '  кпп ASTERUS ', isInternal: false, effectiveFrom: '2026-10-01' }, actor,
    );

    expect(result).toEqual({
      changed: true,
      reconcileTaskId: 7,
      periods: [
        { access_point_name: 'кпп ASTERUS', is_internal: true, effective_from: '2000-01-01' },
        { access_point_name: 'кпп ASTERUS', is_internal: false, effective_from: '2026-10-01' },
      ],
    });
    // Имя нормализовано до блокировки.
    expect(sqlCalls('pg_advisory_xact_lock')[0][1]).toEqual(['skud_ap_zone:кпп ASTERUS']);
    expect(sqlCalls('DELETE FROM skud_access_point_zone_periods')[0][1]).toEqual(['кпп ASTERUS', '2026-10-01']);
    expect(sqlCalls('INSERT INTO skud_access_point_zone_periods')[0][1]).toEqual(['кпп ASTERUS', false, '2026-10-01']);
    // Тип «на сегодня» для экранов портала: внешняя точка — строки в прежней таблице нет.
    expect(sqlCalls('DELETE FROM skud_access_point_settings')[0][1]).toEqual(['кпп ASTERUS']);
    expect(sqlCalls('INSERT INTO skud_access_point_settings')).toHaveLength(0);
    // Пересборка — с даты смены по сегодня (МСК).
    expect(sqlCalls('INSERT INTO skud_access_point_zone_reconcile')[0][1]).toEqual(['кпп ASTERUS', '2026-10-01', '2026-10-13']);

    const auditCall = audit.logFromRequestWithClient.mock.calls[0] as unknown as [unknown, unknown, string, string, { details: Record<string, unknown> }];
    expect(auditCall[0]).toBe(db.txClient);
    expect(auditCall[3]).toBe('SKUD_ACCESS_POINT_ZONE_CHANGED');
    expect(auditCall[4].details).toMatchObject({
      timeline_before: [{ is_internal: true, effective_from: '2000-01-01' }],
      removed_periods: [],
      timeline_after: [
        { is_internal: true, effective_from: '2000-01-01' },
        { is_internal: false, effective_from: '2026-10-01' },
      ],
      reconcile_task_id: 7,
    });

    expect(shared.invalidate).toHaveBeenCalledTimes(1);
    expect(worker.kick).toHaveBeenCalledTimes(1);
  });

  it('повтор той же смены: ни записи, ни задачи, ни аудита, ни пересборки', async () => {
    mockTimeline([
      { is_internal: true, effective_from: '2000-01-01' },
      { is_internal: false, effective_from: '2026-10-01' },
    ]);

    const result = await changeAccessPointZone(
      { accessPointName: 'кпп ASTERUS', isInternal: false, effectiveFrom: '2026-10-01' }, actor,
    );

    expect(result.changed).toBe(false);
    expect(result.reconcileTaskId).toBeNull();
    expect(sqlCalls('DELETE FROM')).toHaveLength(0);
    expect(sqlCalls('INSERT INTO')).toHaveLength(0);
    expect(audit.logFromRequestWithClient).not.toHaveBeenCalled();
    expect(worker.kick).not.toHaveBeenCalled();
  });

  it('отмена смены этого месяца удаляет строку и не вставляет новую', async () => {
    mockTimeline([
      { is_internal: true, effective_from: '2000-01-01' },
      { is_internal: false, effective_from: '2026-10-01' },
    ]);

    const result = await changeAccessPointZone(
      { accessPointName: 'кпп ASTERUS', isInternal: true, effectiveFrom: '2026-10-01' }, actor,
    );

    expect(result.changed).toBe(true);
    expect(result.periods).toEqual([{ access_point_name: 'кпп ASTERUS', is_internal: true, effective_from: '2000-01-01' }]);
    expect(sqlCalls('DELETE FROM skud_access_point_zone_periods')).toHaveLength(1);
    expect(sqlCalls('INSERT INTO skud_access_point_zone_periods')).toHaveLength(0);
    expect(sqlCalls('INSERT INTO skud_access_point_zone_reconcile')).toHaveLength(1);
    // Точка снова внутренняя на сегодня — строка в прежней таблице возвращается.
    expect(sqlCalls('INSERT INTO skud_access_point_settings')[0][1]).toEqual(['кпп ASTERUS']);
    expect(sqlCalls('DELETE FROM skud_access_point_settings')).toHaveLength(0);
  });
});
