import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));
vi.mock('../config/postgres.js', () => db);

const objectsService = vi.hoisted(() => ({
  loadMainObjectByEmployee: vi.fn(),
  loadMainObjectDetailedByEmployee: vi.fn(),
}));
vi.mock('./employees-export-objects.service.js', () => objectsService);

const {
  loadMainObjects,
  loadMainObjectsFromSnapshot,
  rebuildMainObjectSnapshot,
  resolveSnapshotPeriod,
  SNAPSHOT_LOCK_KEY,
} = await import('./employee-main-object-snapshot.service.js');

const NOW = new Date('2026-09-14T09:00:00Z'); // 12:00 МСК 14.09

/** Клиент транзакции, записывающий SQL и параметры. */
const makeClient = (failOn?: string) => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    client: {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (failOn && sql.includes(failOn)) throw new Error(`fail ${failOn}`);
        return { rows: [], rowCount: 0 };
      }),
    },
  };
};

beforeEach(() => {
  Object.values(db).forEach(fn => fn.mockReset());
  Object.values(objectsService).forEach(fn => fn.mockReset());
  db.execute.mockResolvedValue(1);
});

describe('resolveSnapshotPeriod', () => {
  it('30 полных дат: вчера (МСК) и 29 дней до него', () => {
    expect(resolveSnapshotPeriod(NOW)).toEqual({ start: '2026-08-15', end: '2026-09-13' });
  });

  it('после полуночи МСК «вчера» уже новое, хотя в UTC ещё прошлые сутки', () => {
    // 21:30 UTC 13.09 = 00:30 МСК 14.09 → вчера = 13.09.
    expect(resolveSnapshotPeriod(new Date('2026-09-13T21:30:00Z')).end).toBe('2026-09-13');
    // 20:59 UTC 13.09 = 23:59 МСК 13.09 → вчера = 12.09.
    expect(resolveSnapshotPeriod(new Date('2026-09-13T20:59:00Z')).end).toBe('2026-09-12');
  });

  it('переход через границу года', () => {
    expect(resolveSnapshotPeriod(new Date('2026-01-05T12:00:00Z'))).toEqual({ start: '2025-12-06', end: '2026-01-04' });
  });
});

describe('loadMainObjectsFromSnapshot / loadMainObjects', () => {
  it('нет успешного расчёта — null, строки не читаются', async () => {
    db.queryOne.mockResolvedValue(null);
    expect(await loadMainObjectsFromSnapshot([1, 2])).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
    const [sql] = db.queryOne.mock.calls[0] as [string];
    expect(sql).toContain(`status = 'ok'`);
  });

  it('есть снимок — период последнего ok-расчёта и объекты по id', async () => {
    db.queryOne.mockResolvedValue({ id: 5, period_start: '2026-08-15', period_end: '2026-09-13', finished_at: null });
    db.query.mockResolvedValue([{ employee_id: '1', object_name: 'ЖК Ситибэй' }]);

    const result = await loadMainObjects([1, 2, 2], { start: '2026-08-16', end: '2026-09-14' });

    expect(result.source).toBe('snapshot');
    expect(result.period).toEqual({ start: '2026-08-15', end: '2026-09-13' });
    expect([...result.objects]).toEqual([[1, 'ЖК Ситибэй']]);
    expect(db.query.mock.calls[0][1]).toEqual([[1, 2]]);
    expect(objectsService.loadMainObjectByEmployee).not.toHaveBeenCalled();
  });

  it('снимка нет — расчёт на лету за переданный период', async () => {
    db.queryOne.mockResolvedValue(null);
    objectsService.loadMainObjectByEmployee.mockResolvedValue(new Map([[1, 'ЖК Wave']]));
    const live = { start: '2026-08-16', end: '2026-09-14' };

    const result = await loadMainObjects([1], live);

    expect(result).toEqual({ period: live, objects: new Map([[1, 'ЖК Wave']]), source: 'live' });
    expect(objectsService.loadMainObjectByEmployee).toHaveBeenCalledWith([1], live);
  });
});

describe('rebuildMainObjectSnapshot', () => {
  const mains = new Map([
    [1, { objectId: 'o1', objectName: 'ЖК Ситибэй', hours: 120.5 }],
    [2, { objectId: 'o2', objectName: 'ЖК Wave', hours: 8 }],
  ]);

  beforeEach(() => {
    db.queryOne.mockResolvedValue({ id: 77 }); // INSERT run RETURNING id
    db.query.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }]); // охват
    objectsService.loadMainObjectDetailedByEmployee.mockResolvedValue(mains);
  });

  it('успех: расчёт за полные сутки, в транзакции lock → DELETE → INSERT → run ok', async () => {
    const { client, calls } = makeClient();
    db.withTransaction.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => fn(client));

    const result = await rebuildMainObjectSnapshot({ now: new Date('2026-09-14T09:00:00Z') });

    expect(result).toMatchObject({ period: { start: '2026-08-15', end: '2026-09-13' }, employees: 3, withObject: 2, dryRun: false });
    // Охват: не архивные, уволенные не раньше начала периода.
    const [scopeSql, scopeParams] = db.query.mock.calls[0] as [string, unknown[]];
    expect(scopeSql).toContain('is_archived = false');
    expect(scopeSql).toContain('dismissal_date >= $1::date');
    expect(scopeParams).toEqual(['2026-08-15']);
    expect(objectsService.loadMainObjectDetailedByEmployee).toHaveBeenCalledWith([1, 2, 3], { start: '2026-08-15', end: '2026-09-13' });

    expect(calls.map(c => c.sql.trim().split(/\s+/).slice(0, 3).join(' '))).toEqual([
      'SELECT pg_advisory_xact_lock($1::bigint)',
      'DELETE FROM employee_main_object_snapshot',
      'INSERT INTO employee_main_object_snapshot',
      'UPDATE employee_main_object_snapshot_runs SET',
    ]);
    expect(calls[0].params).toEqual([SNAPSHOT_LOCK_KEY]);
    const insert = calls[2];
    // Удалённого за время расчёта сотрудника пропускаем, а не роняем запись на FK.
    expect(insert.sql).toContain('JOIN employees e ON e.id = u.employee_id');
    expect(insert.params).toEqual([[1, 2], ['o1', 'o2'], ['ЖК Ситибэй', 'ЖК Wave'], [120.5, 8], '2026-08-15', '2026-09-13']);
    expect(calls[3].sql).toContain(`status = 'ok'`);
    expect(calls[3].params.slice(0, 3)).toEqual([77, 3, 2]);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('ошибка расчёта: транзакция не открывается, прошлый снимок цел, run = error', async () => {
    objectsService.loadMainObjectDetailedByEmployee.mockRejectedValue(new Error('СКУД недоступен'));

    await expect(rebuildMainObjectSnapshot({ now: NOW })).rejects.toThrow('СКУД недоступен');

    expect(db.withTransaction).not.toHaveBeenCalled();
    const [sql, params] = db.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(`status = 'error'`);
    expect(params[0]).toBe(77);
    expect(params[2]).toBe('СКУД недоступен');
  });

  it('ошибка INSERT: исключение выходит из транзакции (ROLLBACK), run = error', async () => {
    const { client, calls } = makeClient('INSERT INTO employee_main_object_snapshot');
    let txError: unknown = null;
    db.withTransaction.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => {
      try { return await fn(client); } catch (error) { txError = error; throw error; }
    });

    await expect(rebuildMainObjectSnapshot({ now: NOW })).rejects.toThrow('fail INSERT');

    expect(txError).toBeInstanceOf(Error);
    expect(calls.some(c => c.sql.includes(`status = 'ok'`))).toBe(false);
    expect(String(db.execute.mock.calls[0][0])).toContain(`status = 'error'`);
  });

  it('сбой отметки error не маскирует исходную ошибку', async () => {
    objectsService.loadMainObjectDetailedByEmployee.mockRejectedValue(new Error('исходная'));
    db.execute.mockRejectedValue(new Error('журнал недоступен'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(rebuildMainObjectSnapshot({ now: NOW })).rejects.toThrow('исходная');
    err.mockRestore();
  });

  it('dry-run: считает, но в БД ничего не пишет (ни журнал, ни снимок)', async () => {
    const result = await rebuildMainObjectSnapshot({ now: NOW, dryRun: true });

    expect(result).toMatchObject({ dryRun: true, employees: 3, withObject: 2 });
    expect(result.preview).toBe(mains);
    expect(db.queryOne).not.toHaveBeenCalled();
    expect(db.withTransaction).not.toHaveBeenCalled();
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('пустой результат расчёта — снимок очищается (объектов ни у кого нет), run ok', async () => {
    objectsService.loadMainObjectDetailedByEmployee.mockResolvedValue(new Map());
    const { client, calls } = makeClient();
    db.withTransaction.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => fn(client));

    const result = await rebuildMainObjectSnapshot({ now: NOW });

    expect(result.withObject).toBe(0);
    expect(calls.some(c => c.sql.includes('DELETE FROM employee_main_object_snapshot'))).toBe(true);
    expect(calls.some(c => c.sql.includes('INSERT INTO employee_main_object_snapshot'))).toBe(false);
  });
});
