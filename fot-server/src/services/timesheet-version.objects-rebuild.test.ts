import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';

/**
 * Редакция «только объекты» после фиксации месяца (миграция 288).
 *
 * Подача 1–15 закрыта с объектом A; месяц зафиксирован с объектом B — появляется новая
 * revision: тот же payload и content_hash, разбивка по B, source = 'objects', снимок
 * руководителей перенесён. Заменяются ТОЛЬКО сотрудники со сменой режима/объекта.
 * Повтор — no-op. Период через границу месяца материализовать нельзя.
 */

const modes = vi.hoisted(() => ({
  byEmployee: new Map<number, { mode: string; pinnedObjectId: string | null; source: string }>(),
  calls: [] as Array<unknown>,
}));

vi.mock('./timesheet-day-ownership.service.js', () => ({
  resolveDayOwnership: vi.fn(async () => new Map()),
  ownsDay: () => true,
  ownershipKey: (a: number, b: number, c: string) => `${a}|${b}|${c}`,
  enumerateDatesInclusive: () => ['2026-09-03'],
}));
vi.mock('./timesheet-export-mode.service.js', () => ({
  resolveExportModes: vi.fn(async (_ids: number[], _client: unknown, options: unknown) => {
    modes.calls.push(options);
    return new Map(modes.byEmployee);
  }),
  CURRENT_ACTIVITY_ADDRESS: 'Текущая деятельность',
  DEFAULT_EXPORT_MODE: { mode: 'skud', pinnedObjectId: null, source: 'legacy_default' },
}));
vi.mock('./timesheet-export.service.js', () => ({
  fetchTimesheetDataForEmployees: vi.fn(async () => ({
    employees: [],
    posMap: new Map(),
    entries: [],
    dataMap: new Map(),
    // Живые веса СКУД у сотрудника 2 «уехали» (Б вместо А) — его строки менять нельзя.
    objectEntries: [{
      adjustment_id: null, employee_id: 2, work_date: '2026-09-03', object_key: 'obj-b', object_id: 'obj-b',
      object_name: 'Объект Б', hours_worked: 8, display_hours_worked: 8, base_hours_worked: 8, is_correction: false,
    }],
  })),
}));

const {
  TimesheetVersionCrossMonthError,
  buildObjectsSnapshotForVersion,
  mergeObjectsSnapshots,
  rebuildVersionObjects,
} = await import('./timesheet-version.service.js');
const { computeObjectsContentHash } = await import('./timesheet-object-breakdown.service.js');

const APPROVAL = {
  id: 901, department_id: 'dept-1', manager_employee_id: null,
  start_date: '2026-09-01', end_date: '2026-09-15', status: 'approved',
};

const day = { status: 'work', hours: 8, corrected: false, hours_overridden: false };
const PAYLOAD = {
  approval: {
    id: 901,
    scope: { kind: 'department' as const, department_id: 'dept-1', department_name: 'бр. Тест', manager_employee_id: null },
    start_date: '2026-09-01', end_date: '2026-09-15', status: 'approved',
  },
  employees_count: 2,
  total_hours: 16,
  employees: [1, 2].map(id => ({
    identity: { employee_id: id, sigur_employee_id: null, tab_number: null, full_name: `Сотрудник ${id}` },
    position: null, total_hours: 8, zero_activity: false, days: { '2026-09-03': day }, object_rows: [],
  })),
};

const row = (objectId: string, name: string) => ({
  object_id: objectId, object_key: objectId, object_name: name, object_address: name,
  total_hours: 8, days: { '2026-09-03': 8 },
});

/** Сохранённая разбивка: сотрудник 1 закреплён за А, сотрудник 2 — по СКУД на А. */
const STORED_OBJECTS = {
  employees: [
    { employee_id: 1, full_name: 'Сотрудник 1', mode: 'object' as const, total_hours: 8, objects: [row('obj-a', 'Объект А')] },
    { employee_id: 2, full_name: 'Сотрудник 2', mode: 'skud' as const, total_hours: 8, objects: [row('obj-a', 'Объект А')] },
  ],
};

interface IStore {
  latest: Record<string, unknown> | null;
  inserts: Array<{ sql: string; params: unknown[] }>;
}
const store: IStore = { latest: null, inserts: [] };

const client = {
  async query(sql: string, params: unknown[] = []) {
    if (sql.includes('FROM timesheet_versions v')) return { rows: store.latest ? [store.latest] : [] };
    if (sql.includes('FROM skud_objects')) {
      return { rows: [
        { id: 'obj-a', name: 'Объект А', alt_name: null },
        { id: 'obj-b', name: 'Объект Б', alt_name: null },
      ] };
    }
    if (sql.startsWith('INSERT INTO timesheet_versions') || sql.includes('INSERT INTO timesheet_versions')) {
      store.inserts.push({ sql, params });
      return { rows: [{ id: 7777 }] };
    }
    if (sql.includes('INSERT INTO timesheet_version_objects') || sql.includes('INSERT INTO timesheet_version_managers')) {
      store.inserts.push({ sql, params });
      return { rows: [] };
    }
    return { rows: [] };
  },
} as unknown as PoolClient;

beforeEach(() => {
  modes.byEmployee = new Map([
    [1, { mode: 'object', pinnedObjectId: 'obj-b', source: 'employee_explicit' }],
    [2, { mode: 'skud', pinnedObjectId: null, source: 'legacy_default' }],
  ]);
  modes.calls = [];
  store.inserts = [];
  store.latest = {
    id: 5001, revision: 1, content_hash: 'hash-payload', payload: PAYLOAD, scope_kind: 'department',
    employees_count: 2, total_hours: 16, membership_windows: {},
    objects_content_hash: computeObjectsContentHash(STORED_OBJECTS, []),
    objects_payload: STORED_OBJECTS,
    config_errors: [],
  };
});

describe('mergeObjectsSnapshots', () => {
  it('заменяет только сотрудника со сменой закреплённого объекта', () => {
    const fresh = {
      payload: {
        employees: [
          { employee_id: 1, full_name: 'Сотрудник 1', mode: 'object' as const, total_hours: 8, objects: [row('obj-b', 'Объект Б')] },
          { employee_id: 2, full_name: 'Сотрудник 2', mode: 'skud' as const, total_hours: 8, objects: [row('obj-b', 'Объект Б')] },
        ],
      },
      hash: 'x', configErrors: [], employeesCount: 2, totalHours: 16,
    };
    const merged = mergeObjectsSnapshots({ payload: STORED_OBJECTS, configErrors: [] }, fresh);
    expect(merged.changedEmployeeIds).toEqual([1]);
    expect(merged.payload.employees[0].objects[0].object_id).toBe('obj-b');
    // Веса СКУД у сотрудника 2 уехали, но его строки остались как были.
    expect(merged.payload.employees[1]).toBe(STORED_OBJECTS.employees[1]);
    expect(merged.totalHours).toBe(16);
  });

  it('смены режима нет — хэш прежний', () => {
    const merged = mergeObjectsSnapshots(
      { payload: STORED_OBJECTS, configErrors: [] },
      { payload: STORED_OBJECTS, hash: 'x', configErrors: [], employeesCount: 2, totalHours: 16 },
    );
    expect(merged.changedEmployeeIds).toEqual([]);
    expect(merged.hash).toBe(computeObjectsContentHash(STORED_OBJECTS, []));
  });
});

describe('rebuildVersionObjects', () => {
  it('объект сменился: новая revision с тем же payload, source = objects, руководители перенесены', async () => {
    const result = await rebuildVersionObjects(client, APPROVAL, null);

    expect(result).toMatchObject({ created: true, revision: 2, changedEmployeeIds: [1] });
    // Режим — месяца подачи (фиксация).
    expect(modes.calls).toContainEqual({ month: '2026-09-01' });

    const version = store.inserts.find(i => i.sql.includes('INSERT INTO timesheet_versions'))!;
    expect(version.sql).toContain("'objects'");
    expect(version.params[1]).toBe(2);
    expect(version.params[2]).toBe('hash-payload');
    expect(JSON.parse(String(version.params[3]))).toEqual(PAYLOAD);

    const objects = store.inserts.find(i => i.sql.includes('INSERT INTO timesheet_version_objects'))!;
    const payload = JSON.parse(String(objects.params[2]));
    expect(payload.employees[0].objects.map((o: { object_id: string }) => o.object_id)).toEqual(['obj-b']);
    expect(payload.employees[1]).toEqual(STORED_OBJECTS.employees[1]);

    const managers = store.inserts.find(i => i.sql.includes('INSERT INTO timesheet_version_managers'))!;
    expect(managers.params).toEqual([7777, 5001]);
  });

  it('повтор после пересборки — без новой revision', async () => {
    await rebuildVersionObjects(client, APPROVAL, null);
    const objects = store.inserts.find(i => i.sql.includes('INSERT INTO timesheet_version_objects'))!;
    store.latest = {
      ...store.latest!,
      id: 7777,
      revision: 2,
      objects_payload: JSON.parse(String(objects.params[2])),
      objects_content_hash: objects.params[1],
      config_errors: [],
    };
    store.inserts = [];

    const again = await rebuildVersionObjects(client, APPROVAL, null);
    expect(again.created).toBe(false);
    expect(store.inserts).toEqual([]);
  });

  it('объект не менялся — no-op, даже если живые веса СКУД уехали', async () => {
    modes.byEmployee.set(1, { mode: 'object', pinnedObjectId: 'obj-a', source: 'employee_explicit' });
    const result = await rebuildVersionObjects(client, APPROVAL, null);
    expect(result.created).toBe(false);
    expect(store.inserts).toEqual([]);
  });

  it('редакции без снимка объектов не трогаем (это бэкфилл)', async () => {
    store.latest = { ...store.latest!, objects_content_hash: null, objects_payload: null };
    expect((await rebuildVersionObjects(client, APPROVAL, null)).created).toBe(false);
  });
});

describe('период через границу месяца', () => {
  it('материализация разбивки отказывает TimesheetVersionCrossMonthError', async () => {
    const crossMonth = {
      ...PAYLOAD,
      approval: { ...PAYLOAD.approval, start_date: '2026-08-16', end_date: '2026-09-15' },
    };
    await expect(buildObjectsSnapshotForVersion(
      client,
      { ...APPROVAL, start_date: '2026-08-16', end_date: '2026-09-15' },
      crossMonth,
    )).rejects.toBeInstanceOf(TimesheetVersionCrossMonthError);
  });
});
