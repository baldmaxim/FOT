import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
  withReadOnlySnapshot: vi.fn(),
}));
vi.mock('../config/postgres.js', () => db);

const objectsService = vi.hoisted(() => ({
  loadObjectHoursByEmployee: vi.fn(),
}));
vi.mock('./employees-export-objects.service.js', async () => {
  const actual = await vi.importActual<typeof import('./employees-export-objects.service.js')>(
    './employees-export-objects.service.js',
  );
  return {
    compareObjectHours: actual.compareObjectHours,
    mainObjectsFromLists: actual.mainObjectsFromLists,
    loadObjectHoursByEmployee: objectsService.loadObjectHoursByEmployee,
  };
});

const {
  isNewerGeneration,
  loadActiveSnapshotRun,
  loadMainObjects,
  loadSnapshotData,
  rebuildMainObjectSnapshot,
  resolveSnapshotPeriod,
  SNAPSHOT_LOCK_KEY,
} = await import('./employee-main-object-snapshot.service.js');

const NOW = new Date('2026-09-14T09:00:00Z'); // 12:00 МСК 14.09
const PERIOD = { start: '2026-08-15', end: '2026-09-13' };

type SqlCall = { sql: string; params: unknown[] };
type Responder = (sql: string, params: unknown[]) => unknown[] | undefined;

/** Клиент, записывающий SQL; ответы строк — через responder; failOn — бросить на подстроке. */
const makeClient = (responder: Responder = () => [], failOn?: string) => {
  const calls: SqlCall[] = [];
  return {
    calls,
    client: {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (failOn && sql.includes(failOn)) throw new Error(`fail ${failOn}`);
        const rows = responder(sql, params) ?? [];
        return { rows, rowCount: rows.length };
      }),
    },
  };
};

const head = (sql: string): string => sql.trim().split(/\s+/).slice(0, 3).join(' ');

beforeEach(() => {
  Object.values(db).forEach(fn => fn.mockReset());
  objectsService.loadObjectHoursByEmployee.mockReset();
  db.execute.mockResolvedValue(1);
});

describe('resolveSnapshotPeriod', () => {
  it('30 полных дат: вчера (МСК) и 29 дней до него', () => {
    expect(resolveSnapshotPeriod(NOW)).toEqual(PERIOD);
  });

  it('после полуночи МСК «вчера» уже новое, хотя в UTC ещё прошлые сутки', () => {
    expect(resolveSnapshotPeriod(new Date('2026-09-13T21:30:00Z')).end).toBe('2026-09-13');
    expect(resolveSnapshotPeriod(new Date('2026-09-13T20:59:00Z')).end).toBe('2026-09-12');
  });

  it('переход через границу года', () => {
    expect(resolveSnapshotPeriod(new Date('2026-01-05T12:00:00Z'))).toEqual({ start: '2025-12-06', end: '2026-01-04' });
  });
});

describe('isNewerGeneration', () => {
  it('активного нет — публикуем', () => {
    expect(isNewerGeneration({ runId: 1, periodEnd: '2026-09-13' }, null)).toBe(true);
  });

  it('более поздний период побеждает независимо от id', () => {
    expect(isNewerGeneration({ runId: 5, periodEnd: '2026-09-13' }, { runId: 9, periodEnd: '2026-09-12' })).toBe(true);
    expect(isNewerGeneration({ runId: 9, periodEnd: '2026-09-12' }, { runId: 5, periodEnd: '2026-09-13' })).toBe(false);
  });

  it('тот же период: побеждает запуск, начатый позже (больший id); повтор самого себя — нет', () => {
    expect(isNewerGeneration({ runId: 11, periodEnd: '2026-09-13' }, { runId: 10, periodEnd: '2026-09-13' })).toBe(true);
    expect(isNewerGeneration({ runId: 10, periodEnd: '2026-09-13' }, { runId: 11, periodEnd: '2026-09-13' })).toBe(false);
    expect(isNewerGeneration({ runId: 10, periodEnd: '2026-09-13' }, { runId: 10, periodEnd: '2026-09-13' })).toBe(false);
  });
});

describe('loadActiveSnapshotRun', () => {
  it('читает указатель state, а не последний ok по id; требует object_hours_ready', async () => {
    db.queryOne.mockResolvedValue({ id: '7', period_start: PERIOD.start, period_end: PERIOD.end, finished_at: null });
    expect(await loadActiveSnapshotRun()).toEqual({ id: 7, period: PERIOD, finishedAt: null });
    const [sql] = db.queryOne.mock.calls[0] as [string];
    expect(sql).toContain('employee_main_object_snapshot_state');
    expect(sql).toContain('r.id = s.active_run_id');
    expect(sql).toContain('r.object_hours_ready');
    expect(sql).not.toContain('ORDER BY');
  });

  it('нет опубликованного поколения — null', async () => {
    db.queryOne.mockResolvedValue(null);
    expect(await loadActiveSnapshotRun()).toBeNull();
  });
});

describe('loadSnapshotData / loadMainObjects', () => {
  const activeRun = { id: 7, period_start: PERIOD.start, period_end: PERIOD.end, finished_at: null };

  const useSnapshotClient = (responder: Responder) => {
    const made = makeClient(responder);
    db.withReadOnlySnapshot.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => fn(made.client));
    return made;
  };

  it('нет активного поколения — null, строки снимка не читаются', async () => {
    const { calls } = useSnapshotClient(() => []);
    expect(await loadSnapshotData([1, 2])).toBeNull();
    expect(calls).toHaveLength(1);
    expect(db.withReadOnlySnapshot).toHaveBeenCalledTimes(1);
  });

  it('все чтения — в одной REPEATABLE READ транзакции и только по run_id активного поколения', async () => {
    const { calls } = useSnapshotClient((sql) => {
      if (sql.includes('employee_main_object_snapshot_state')) return [activeRun];
      if (sql.includes('FROM employee_main_object_snapshot')) return [{ employee_id: '1', object_name: 'ЖК Альфа' }];
      if (sql.includes('FROM employee_object_hours_snapshot')) {
        // Порядок строк из БД нарочно «неправильный».
        return [
          { employee_id: '1', skud_object_id: 'o2', object_name: 'ЖК Бета', hours: '8.00' },
          { employee_id: '1', skud_object_id: 'o1', object_name: 'ЖК Альфа', hours: '8.00' },
          { employee_id: '1', skud_object_id: 'o3', object_name: 'ЖК Гамма', hours: '20.50' },
        ];
      }
      return [];
    });

    const data = await loadSnapshotData([1, 2, 2]);

    expect(db.withReadOnlySnapshot).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(3);
    expect(calls[1].params).toEqual([7, [1, 2]]);
    expect(calls[2].params).toEqual([7, [1, 2]]);
    expect(calls[1].sql).toContain('run_id = $1');
    expect(calls[2].sql).toContain('run_id = $1');
    expect(data?.run).toEqual({ id: 7, period: PERIOD, finishedAt: null });
    expect([...data!.objects]).toEqual([[1, 'ЖК Альфа']]);
    // Порядок — общий компаратор: часы ↓, затем название.
    expect(data!.objectLists.get(1)!.map(item => item.objectName)).toEqual(['ЖК Гамма', 'ЖК Альфа', 'ЖК Бета']);
    expect(data!.objectLists.get(1)![0].hours).toBe(20.5);
  });

  it('готовый пустой снимок — пустые списки, расчёт на лету не запускается', async () => {
    useSnapshotClient(sql => (sql.includes('employee_main_object_snapshot_state') ? [activeRun] : []));

    const result = await loadMainObjects([1], { start: '2026-08-16', end: '2026-09-14' });

    expect(result.source).toBe('snapshot');
    expect(result.period).toEqual(PERIOD);
    expect(result.objects.size).toBe(0);
    expect(result.objectNamesByEmployee.size).toBe(0);
    expect(objectsService.loadObjectHoursByEmployee).not.toHaveBeenCalled();
  });

  it('нет активного поколения — основной объект и списки из ОДНОГО расчёта на лету', async () => {
    useSnapshotClient(() => []);
    objectsService.loadObjectHoursByEmployee.mockResolvedValue(new Map([
      [1, [
        { objectId: 'o1', objectName: 'ЖК Wave', hours: 30 },
        { objectId: 'o2', objectName: 'ЖК Alia', hours: 4 },
      ]],
    ]));
    const live = { start: '2026-08-16', end: '2026-09-14' };

    const result = await loadMainObjects([1], live);

    expect(result).toEqual({
      period: live,
      objects: new Map([[1, 'ЖК Wave']]),
      objectNamesByEmployee: new Map([[1, ['ЖК Wave', 'ЖК Alia']]]),
      source: 'live',
    });
    expect(objectsService.loadObjectHoursByEmployee).toHaveBeenCalledTimes(1);
    expect(objectsService.loadObjectHoursByEmployee).toHaveBeenCalledWith([1], live);
  });

  it('порядок снимка совпадает с расчётом на лету при равных часах', async () => {
    const lists = [
      { objectId: 'o9', objectName: 'Склад', hours: 5 },
      { objectId: 'o3', objectName: 'Склад', hours: 5 },
      { objectId: 'o1', objectName: 'Альфа', hours: 5 },
    ];
    const { compareObjectHours } = await vi.importActual<typeof import('./employees-export-objects.service.js')>(
      './employees-export-objects.service.js',
    );
    const liveOrder = [...lists].sort(compareObjectHours).map(item => item.objectId);

    useSnapshotClient((sql) => {
      if (sql.includes('employee_main_object_snapshot_state')) return [activeRun];
      if (sql.includes('FROM employee_object_hours_snapshot')) {
        return lists.map(item => ({ employee_id: 1, skud_object_id: item.objectId, object_name: item.objectName, hours: item.hours }));
      }
      return [];
    });
    const data = await loadSnapshotData([1]);
    expect(data!.objectLists.get(1)!.map(item => item.objectId)).toEqual(liveOrder);
    expect(liveOrder).toEqual(['o1', 'o3', 'o9']);
  });
});

describe('rebuildMainObjectSnapshot', () => {
  const lists = new Map([
    [1, [
      { objectId: 'o1', objectName: 'ЖК Ситибэй', hours: 120.5 },
      { objectId: 'o3', objectName: 'ЖК Alia', hours: 2 },
    ]],
    [2, [{ objectId: 'o2', objectName: 'ЖК Wave', hours: 8 }]],
  ]);

  /** Состояние указателя: active — текущее активное поколение или null. */
  const stateResponder = (active: { id: number; periodEnd: string } | null): Responder => (sql) => {
    if (sql.includes('FROM employee_main_object_snapshot_state')) {
      return [{ active_run_id: active?.id ?? null, period_end: active?.periodEnd ?? null }];
    }
    return [];
  };

  const useTx = (made: ReturnType<typeof makeClient>) => {
    db.withTransaction.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => fn(made.client));
  };

  beforeEach(() => {
    db.queryOne.mockResolvedValue({ id: 77 }); // INSERT run RETURNING id
    db.query.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }]); // охват
    objectsService.loadObjectHoursByEmployee.mockResolvedValue(lists);
  });

  it('успех: lock → state FOR UPDATE → DELETE обеих → INSERT с run_id → run ok+ready → указатель', async () => {
    const made = makeClient(stateResponder({ id: 70, periodEnd: '2026-09-12' }));
    useTx(made);

    const result = await rebuildMainObjectSnapshot({ now: NOW });

    expect(result).toMatchObject({ period: PERIOD, employees: 3, withObject: 2, dryRun: false, published: true });
    const [scopeSql, scopeParams] = db.query.mock.calls[0] as [string, unknown[]];
    expect(scopeSql).toContain('is_archived = false');
    expect(scopeSql).toContain('dismissal_date >= $1::date');
    expect(scopeParams).toEqual(['2026-08-15']);
    expect(objectsService.loadObjectHoursByEmployee).toHaveBeenCalledWith([1, 2, 3], PERIOD);

    const { calls } = made;
    expect(calls.map(c => head(c.sql))).toEqual([
      'SELECT pg_advisory_xact_lock($1::bigint)',
      'SELECT s.active_run_id, to_char(r.period_end,',
      'DELETE FROM employee_main_object_snapshot',
      'DELETE FROM employee_object_hours_snapshot',
      'INSERT INTO employee_main_object_snapshot',
      'INSERT INTO employee_object_hours_snapshot',
      'UPDATE employee_main_object_snapshot_runs SET',
      'UPDATE employee_main_object_snapshot_state SET',
    ]);
    expect(calls[0].params).toEqual([SNAPSHOT_LOCK_KEY]);
    expect(calls[1].sql).toContain('FOR UPDATE OF s');

    const mainInsert = calls[4];
    expect(mainInsert.sql).toContain('JOIN employees e ON e.id = u.employee_id');
    expect(mainInsert.params).toEqual([[1, 2], ['o1', 'o2'], ['ЖК Ситибэй', 'ЖК Wave'], [120.5, 8], PERIOD.start, PERIOD.end, 77]);

    const objectsInsert = calls[5];
    expect(objectsInsert.sql).toContain('JOIN employees e ON e.id = u.employee_id');
    expect(objectsInsert.params).toEqual([[1, 1, 2], ['o1', 'o3', 'o2'], ['ЖК Ситибэй', 'ЖК Alia', 'ЖК Wave'], [120.5, 2, 8], 77]);

    expect(calls[6].sql).toContain(`status = 'ok'`);
    expect(calls[6].sql).toContain('object_hours_ready = true');
    expect(calls[6].params.slice(0, 3)).toEqual([77, 3, 2]);
    expect(calls[7].params).toEqual([77]);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('двукратная пересборка на тех же входах: бизнес-поля снимков совпадают, строки привязаны к своему запуску', async () => {
    const businessRows = (calls: SqlCall[]) => {
      const main = calls.find(c => head(c.sql) === 'INSERT INTO employee_main_object_snapshot')!.params;
      const objects = calls.find(c => head(c.sql) === 'INSERT INTO employee_object_hours_snapshot')!.params;
      return { main: main.slice(0, 6), objects: objects.slice(0, 4), mainRun: main[6], objectsRun: objects[4] };
    };

    db.queryOne.mockResolvedValueOnce({ id: 80 });
    const first = makeClient(stateResponder({ id: 70, periodEnd: '2026-09-12' }));
    useTx(first);
    await rebuildMainObjectSnapshot({ now: NOW });

    db.queryOne.mockResolvedValueOnce({ id: 81 });
    const second = makeClient(stateResponder({ id: 80, periodEnd: PERIOD.end }));
    useTx(second);
    const result = await rebuildMainObjectSnapshot({ now: NOW });

    const a = businessRows(first.calls);
    const b = businessRows(second.calls);
    expect(b.main).toEqual(a.main);
    expect(b.objects).toEqual(a.objects);
    expect([a.mainRun, a.objectsRun]).toEqual([80, 80]);
    expect([b.mainRun, b.objectsRun]).toEqual([81, 81]);
    expect(result.published).toBe(true);
    // Обе пересборки начинают с полного DELETE: объекты, пропавшие из расчёта, не остаются.
    expect(second.calls.filter(c => c.sql.startsWith('DELETE'))).toHaveLength(2);
  });

  it('объект, пропавший из расчёта, не переживает пересборку (DELETE до INSERT)', async () => {
    objectsService.loadObjectHoursByEmployee.mockResolvedValue(new Map([[2, [{ objectId: 'o2', objectName: 'ЖК Wave', hours: 8 }]]]));
    const made = makeClient(stateResponder(null));
    useTx(made);

    await rebuildMainObjectSnapshot({ now: NOW });

    const order = made.calls.map(c => head(c.sql));
    expect(order.indexOf('DELETE FROM employee_object_hours_snapshot')).toBeLessThan(order.indexOf('INSERT INTO employee_object_hours_snapshot'));
    const objectsInsert = made.calls.find(c => head(c.sql) === 'INSERT INTO employee_object_hours_snapshot')!;
    expect(objectsInsert.params[0]).toEqual([2]);
  });

  it('конкурирующие запуски за один период: A стартовал раньше, B уже опубликован → A superseded, снимок не трогается', async () => {
    db.queryOne.mockResolvedValue({ id: 90 }); // A
    const made = makeClient(stateResponder({ id: 91, periodEnd: PERIOD.end })); // B активен
    useTx(made);

    const result = await rebuildMainObjectSnapshot({ now: NOW });

    expect(result.published).toBe(false);
    expect(made.calls.map(c => head(c.sql))).toEqual([
      'SELECT pg_advisory_xact_lock($1::bigint)',
      'SELECT s.active_run_id, to_char(r.period_end,',
      'UPDATE employee_main_object_snapshot_runs SET',
    ]);
    expect(made.calls[2].sql).toContain(`status = 'superseded'`);
    expect(made.calls[2].params[0]).toBe(90);
    expect(made.calls.some(c => c.sql.includes('employee_main_object_snapshot_state') && c.sql.startsWith('UPDATE'))).toBe(false);
  });

  it('расчёт за более старый период поверх более свежего не публикуется', async () => {
    db.queryOne.mockResolvedValue({ id: 95 });
    const made = makeClient(stateResponder({ id: 60, periodEnd: '2026-09-20' }));
    useTx(made);

    const result = await rebuildMainObjectSnapshot({ now: NOW });

    expect(result.published).toBe(false);
    expect(made.calls.some(c => c.sql.startsWith('DELETE'))).toBe(false);
  });

  it('нет строки state — ошибка, запуск помечается error', async () => {
    const made = makeClient(() => []);
    useTx(made);

    await expect(rebuildMainObjectSnapshot({ now: NOW })).rejects.toThrow('employee_main_object_snapshot_state');
    expect(String(db.execute.mock.calls[0][0])).toContain(`status = 'error'`);
  });

  it('ошибка расчёта: транзакция не открывается, прошлый снимок цел, run = error', async () => {
    objectsService.loadObjectHoursByEmployee.mockRejectedValue(new Error('СКУД недоступен'));

    await expect(rebuildMainObjectSnapshot({ now: NOW })).rejects.toThrow('СКУД недоступен');

    expect(db.withTransaction).not.toHaveBeenCalled();
    const [sql, params] = db.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(`status = 'error'`);
    expect(params[0]).toBe(77);
    expect(params[2]).toBe('СКУД недоступен');
  });

  it('ошибка INSERT списка объектов: исключение выходит из транзакции (ROLLBACK обеих таблиц и указателя)', async () => {
    const made = makeClient(stateResponder(null), 'INSERT INTO employee_object_hours_snapshot');
    let txError: unknown = null;
    db.withTransaction.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => {
      try { return await fn(made.client); } catch (error) { txError = error; throw error; }
    });

    await expect(rebuildMainObjectSnapshot({ now: NOW })).rejects.toThrow('fail INSERT');

    expect(txError).toBeInstanceOf(Error);
    // После сбоя ни отметки ok, ни перевода указателя в той же транзакции не было.
    expect(made.calls.some(c => c.sql.includes(`status = 'ok'`))).toBe(false);
    expect(made.calls.some(c => c.sql.includes('UPDATE employee_main_object_snapshot_state'))).toBe(false);
    expect(String(db.execute.mock.calls[0][0])).toContain(`status = 'error'`);
  });

  it('сбой отметки error не маскирует исходную ошибку', async () => {
    objectsService.loadObjectHoursByEmployee.mockRejectedValue(new Error('исходная'));
    db.execute.mockRejectedValue(new Error('журнал недоступен'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(rebuildMainObjectSnapshot({ now: NOW })).rejects.toThrow('исходная');
    err.mockRestore();
  });

  it('dry-run: считает, но в БД ничего не пишет (ни журнал, ни снимок)', async () => {
    const result = await rebuildMainObjectSnapshot({ now: NOW, dryRun: true });

    expect(result).toMatchObject({ dryRun: true, published: false, employees: 3, withObject: 2 });
    expect(result.preview?.get(1)).toEqual({ objectId: 'o1', objectName: 'ЖК Ситибэй', hours: 120.5 });
    expect(result.previewLists).toBe(lists);
    expect(db.queryOne).not.toHaveBeenCalled();
    expect(db.withTransaction).not.toHaveBeenCalled();
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('пустой результат: обе таблицы очищаются, INSERT нет, поколение публикуется (ready)', async () => {
    objectsService.loadObjectHoursByEmployee.mockResolvedValue(new Map());
    const made = makeClient(stateResponder(null));
    useTx(made);

    const result = await rebuildMainObjectSnapshot({ now: NOW });

    expect(result).toMatchObject({ withObject: 0, published: true });
    expect(made.calls.filter(c => c.sql.startsWith('DELETE'))).toHaveLength(2);
    expect(made.calls.some(c => c.sql.includes('INSERT INTO'))).toBe(false);
    expect(made.calls.some(c => c.sql.includes('object_hours_ready = true'))).toBe(true);
    expect(made.calls.some(c => c.sql.includes('UPDATE employee_main_object_snapshot_state'))).toBe(true);
  });
});
