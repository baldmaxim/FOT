import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Пересчёт по часам сразу после снятия «Офиса» (291): правило и период ночи (по вчера),
 * строки FOR UPDATE — только у переданных сотрудников; ночной загрузчик — без блокировки.
 */

const h = vi.hoisted(() => ({
  hours: vi.fn(),
  objects: vi.fn(),
  logWithClient: vi.fn(),
}));

vi.mock('./audit.service.js', () => ({
  AUDIT_ACTIONS: { TIMESHEET_OBJECT_AUTO_ASSIGNED: 'TIMESHEET_OBJECT_AUTO_ASSIGNED' },
  auditService: { logWithClient: h.logWithClient },
}));
vi.mock('./employee-timesheet-object.service.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./employee-timesheet-object.service.js')>()),
  loadTimesheetObjectHours: h.hours,
  loadSkudObjects: h.objects,
}));

const { recomputeTimesheetObjectsNow } = await import('./timesheet-object-recompute.service.js');
const { loadOwnActiveEmployees } = await import('./employee-timesheet-object-auto.service.js');

const CONTRACTORS = ['22222222-2222-4222-8222-222222222222'];
const NOW = new Date('2026-09-30T12:00:00+03:00');

const row = (id: number, over: Record<string, unknown> = {}) => ({
  id, full_name: `Сотрудник ${id}`, mode: 'current_activity', object_id: null, set_by: 'auto',
  office_department: false, personal_office: false, ...over,
});

function fakeClient(rows: Array<Record<string, unknown>>, updatedIds: number[]) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.includes('FROM employees e') && sql.includes('LEFT JOIN timesheet_office_departments')) return { rows };
    if (sql.startsWith('UPDATE employees')) return { rows: updatedIds.map(id => ({ id })) };
    return { rows: [] };
  });
  return { client: { query } as never, calls };
}

beforeEach(() => {
  Object.values(h).forEach(fn => fn.mockReset());
  h.objects.mockResolvedValue(new Map());
  h.hours.mockResolvedValue(new Map());
});

describe('recomputeTimesheetObjectsNow', () => {
  it('объект по часам с 1-го по вчера, в том числе поверх прежнего выбора; личный «Офис» и отдел с «Офисом» не трогаются; аудит office_removed', async () => {
    const { client, calls } = fakeClient([
      row(3),
      row(5, { mode: 'object', object_id: 'o-a', set_by: 'employee' }),
      row(6, { set_by: null, personal_office: true }),
      row(7, { office_department: true }),
    ], [3, 5]);
    h.hours.mockResolvedValue(new Map([
      [3, [{ value: 'o-metro', label: 'ЖК Метрополия', objectId: 'o-metro', hours: 120 }]],
      [5, [{ value: 'o-metro', label: 'ЖК Метрополия', objectId: 'o-metro', hours: 90 }]],
      [6, [{ value: 'o-metro', label: 'ЖК Метрополия', objectId: 'o-metro', hours: 85 }]],
      [7, [{ value: 'o-metro', label: 'ЖК Метрополия', objectId: 'o-metro', hours: 80 }]],
    ]));

    const changed = await recomputeTimesheetObjectsNow(client, [7, 6, 5, 3, 5], {
      contractorIds: CONTRACTORS, now: NOW, userId: 'user-1', reason: 'office_removed',
    });

    expect(changed).toEqual([3, 5]);
    const [load] = calls;
    expect(load.sql).toContain('AND e.id = ANY($2::int[])');
    expect(load.sql).toContain('FOR UPDATE OF e');
    expect(load.params).toEqual([CONTRACTORS, [3, 5, 6, 7]]);
    // Период — как у ночи: сегодняшние незакрытые часы не участвуют.
    expect(h.hours).toHaveBeenCalledWith(
      [3, 5, 6, 7],
      { start: '2026-09-01', end: '2026-09-29' },
      expect.objectContaining({ todayStr: '2026-09-30', exec: client }),
    );
    const update = calls.find(call => call.sql.startsWith('UPDATE employees'));
    expect(update?.params).toEqual([[3, 5], ['object', 'object'], ['o-metro', 'o-metro']]);
    // Личный «Офис» защищён и в самом UPDATE.
    expect(update?.sql).toContain('AND NOT (e.timesheet_export_mode IS NOT DISTINCT FROM \'current_activity\'');
    expect(h.logWithClient).toHaveBeenCalledWith(client, expect.objectContaining({
      user_id: 'user-1',
      action: 'TIMESHEET_OBJECT_AUTO_ASSIGNED',
      details: expect.objectContaining({ reason: 'office_removed', changed: 2 }),
    }));
  });

  it('1-го числа период пуст — объект прежний, без UPDATE и аудита', async () => {
    const { client, calls } = fakeClient([row(3)], []);
    const changed = await recomputeTimesheetObjectsNow(client, [3], {
      contractorIds: CONTRACTORS, now: new Date('2026-10-01T10:00:00+03:00'), userId: 'user-1', reason: 'office_removed',
    });
    expect(changed).toEqual([]);
    expect(h.hours).toHaveBeenCalledWith([3], { start: '2026-10-01', end: '2026-09-30' }, expect.anything());
    expect(calls.some(call => call.sql.startsWith('UPDATE'))).toBe(false);
    expect(h.logWithClient).not.toHaveBeenCalled();
  });

  it('пустой список — ни одного запроса', async () => {
    const { client, calls } = fakeClient([], []);
    expect(await recomputeTimesheetObjectsNow(client, [], {
      contractorIds: CONTRACTORS, now: NOW, userId: null, reason: 'office_removed',
    })).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('loadOwnActiveEmployees', () => {
  it('без списка id (ночь) — все и без блокировки строк', async () => {
    const { client, calls } = fakeClient([row(1)], []);
    await loadOwnActiveEmployees(client, CONTRACTORS);
    expect(calls[0].sql).not.toContain('FOR UPDATE');
    expect(calls[0].sql).not.toContain('$2');
    expect(calls[0].params).toEqual([CONTRACTORS]);
  });
});
