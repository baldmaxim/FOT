import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Пересчёт по часам сразу после снятия «Офиса» (291): правило и период ночи (по вчера),
 * строки FOR UPDATE — только у переданных сотрудников; ночной загрузчик — без блокировки.
 * Рабочему — «По СКУД» (skud), как ночью.
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

// Структура для раздела «Бригады»: технический корень → СУ-10 → папка «Бригады» → бригада.
const SU10_ROOT_ID = '2cd8a403-6454-408b-9c2b-8a2db65c7511';
const DEPARTMENTS = [
  { id: 'r0', parent_id: null, name: 'Объект', kind: 'object' },
  { id: SU10_ROOT_ID, parent_id: 'r0', name: '(СУ-10) ООО СУ-10', kind: 'department' },
  { id: 'folder', parent_id: SU10_ROOT_ID, name: 'Бригады', kind: 'department' },
  { id: 'brigade', parent_id: 'folder', name: 'бр.Тестов Т.Т.', kind: 'brigade' },
  { id: 'office', parent_id: SU10_ROOT_ID, name: 'Бухгалтерия', kind: 'department' },
];
const BRIGADES = ['folder', 'brigade'];

const row = (id: number, over: Record<string, unknown> = {}) => ({
  id, full_name: `Сотрудник ${id}`, mode: 'current_activity', object_id: null, set_by: 'auto',
  office_department: false, personal_pin: false, worker: false, ...over,
});

function fakeClient(rows: Array<Record<string, unknown>>, updatedIds: number[]) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.includes('FROM org_departments')) return { rows: DEPARTMENTS };
    if (sql.includes('FROM employees e') && sql.includes('LEFT JOIN timesheet_office_departments')) return { rows };
    if (sql.startsWith('UPDATE employees')) return { rows: updatedIds.map(id => ({ id })) };
    return { rows: [] };
  });
  return { client: { query } as never, calls };
}

const findLoad = (calls: Array<{ sql: string; params: unknown[] }>) =>
  calls.find(call => call.sql.includes('FROM employees e') && call.sql.includes('LEFT JOIN timesheet_office_departments'))!;

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
      row(6, { set_by: null, personal_pin: true }),
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
    const load = findLoad(calls);
    expect(load.sql).toContain('AND e.id = ANY($3::int[])');
    expect(load.sql).toContain('FOR UPDATE OF e');
    expect(load.params).toEqual([CONTRACTORS, BRIGADES, [3, 5, 6, 7]]);
    // Период — как у ночи: сегодняшние незакрытые часы не участвуют.
    expect(h.hours).toHaveBeenCalledWith(
      [3, 5, 6, 7],
      { start: '2026-09-01', end: '2026-09-29' },
      expect.objectContaining({ todayStr: '2026-09-30', exec: client }),
    );
    const update = calls.find(call => call.sql.startsWith('UPDATE employees'));
    expect(update?.params).toEqual([[3, 5], ['object', 'object'], ['o-metro', 'o-metro']]);
    // Назначение из окна («Офис» или объект) защищено и в самом UPDATE.
    expect(update?.sql).toContain('AND NOT (e.timesheet_export_set_by IS NULL');
    expect(update?.sql).toContain("e.timesheet_export_mode IS NOT DISTINCT FROM 'object' AND e.timesheet_export_object_id IS NOT NULL");
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

  it('рабочему — «По СКУД» без расчёта часов: skud, без объекта', async () => {
    const { client, calls } = fakeClient([
      row(8, { mode: 'object', object_id: 'o-a', worker: true }),
      row(9, { mode: 'skud', worker: true }),
    ], [8]);
    const changed = await recomputeTimesheetObjectsNow(client, [8, 9], {
      contractorIds: CONTRACTORS, now: NOW, userId: 'user-1', reason: 'office_removed',
    });
    expect(changed).toEqual([8]);
    const update = calls.find(call => call.sql.startsWith('UPDATE employees'));
    // 9 — уже skud/auto: повтор не пишется.
    expect(update?.params).toEqual([[8], ['skud'], [null]]);
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
    const load = findLoad(calls);
    expect(load.sql).not.toContain('FOR UPDATE');
    expect(load.sql).not.toContain('$3');
    expect(load.params).toEqual([CONTRACTORS, BRIGADES]);
  });

  it('признак рабочего — роль «Рабочий» или бригадник без учётки, отделы «Бригад» — параметром', async () => {
    const { client, calls } = fakeClient([row(1)], []);
    await loadOwnActiveEmployees(client, CONTRACTORS);
    const load = findLoad(calls);
    expect(load.sql).toContain("wsr.code = 'worker'");
    expect(load.sql).toContain('e.org_department_id = ANY($2::uuid[])');
    expect(load.sql).toContain('AS worker');
  });
});
