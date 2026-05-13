import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { pgQuery } = vi.hoisted(() => ({ pgQuery: vi.fn() }));
vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

const presenceMock = vi.hoisted(() => vi.fn());
vi.mock('./skud-presence.service.js', () => ({
  getPresence: presenceMock,
  invalidatePresenceCache: vi.fn(),
}));

const travelMock = vi.hoisted(() => vi.fn());
vi.mock('./skud-travel.service.js', () => ({
  listTravelObjects: travelMock,
}));

const companyResolveMock = vi.hoisted(() => vi.fn());
const internalPointsMock = vi.hoisted(() => vi.fn());
vi.mock('./skud-shared.service.js', () => ({
  getCompanyResolveIndex: companyResolveMock,
  getInternalAccessPoints: internalPointsMock,
}));

const sigurResolveMock = vi.hoisted(() => vi.fn());
vi.mock('./sigur-presence-resolver.service.js', () => ({
  resolveSigurEmployeesByNames: sigurResolveMock,
  invalidateSigurPresenceResolverCache: vi.fn(),
  normalizeMatchName: (s: string) => s.toLowerCase().trim().replace(/\s+/g, ' ').replace(/ё/g, 'е'),
}));

import {
  getPresenceByObject,
  invalidatePresenceByObjectCache,
  NO_COMPANY_ID,
  SIGUR_COMPANY_ID_PREFIX,
} from './skud-presence-by-object.service.js';

function makePresenceItem(overrides: Partial<{
  employee_id: number;
  full_name: string;
  status: 'online' | 'offline' | 'unknown';
  last_access_point: string | null;
  first_entry: string | null;
  since: string | null;
  position_name: string | null;
  department_name: string | null;
}>) {
  return {
    employee_id: overrides.employee_id ?? 1,
    full_name: overrides.full_name ?? 'Сотрудник',
    department_name: overrides.department_name ?? null,
    position_name: overrides.position_name ?? null,
    status: overrides.status ?? 'online',
    since: overrides.since ?? '09:00:00',
    first_entry: overrides.first_entry ?? '09:00:00',
    total_hours: null,
    exit_count: 0,
    time_outside_minutes: 0,
    last_access_point: overrides.last_access_point ?? null,
    punctuality_percent: null,
  };
}

function makeSigurMatch(rootId: number, rootName: string, deptId: number, deptName: string) {
  return {
    root: { sigur_department_id: rootId, name: rootName },
    department: { sigur_department_id: deptId, name: deptName },
  };
}

function makeTravelObject(id: string, name: string, accessPoints: string[]) {
  return {
    id,
    name,
    is_active: true,
    access_points: accessPoints,
    has_map: false,
    mapped_points_count: 0,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

beforeEach(() => {
  invalidatePresenceByObjectCache();
  pgQuery.mockReset();
  presenceMock.mockReset();
  travelMock.mockReset();
  companyResolveMock.mockReset();
  internalPointsMock.mockReset();
  sigurResolveMock.mockReset();

  pgQuery.mockResolvedValue([]);
  presenceMock.mockResolvedValue([]);
  travelMock.mockResolvedValue([]);
  companyResolveMock.mockResolvedValue({
    rootId: 'root',
    companyByDeptId: new Map(),
    companyMeta: new Map(),
    companyBySigurId: new Map(),
    companyByNormalizedName: new Map(),
  });
  internalPointsMock.mockResolvedValue(new Set());
  sigurResolveMock.mockResolvedValue(new Map());
});

afterEach(() => {
  invalidatePresenceByObjectCache();
});

describe('getPresenceByObject', () => {
  it('returns empty buckets when no presence and no travel objects', async () => {
    const data = await getPresenceByObject();
    expect(data.total_online).toBe(0);
    expect(data.buckets).toEqual([]);
  });

  it('includes travel object with zero online when no one is at it', async () => {
    travelMock.mockResolvedValue([makeTravelObject('obj-1', 'Склад', ['Турникет-1'])]);
    const data = await getPresenceByObject();
    expect(data.total_online).toBe(0);
    expect(data.buckets).toHaveLength(1);
    expect(data.buckets[0]).toMatchObject({ object_id: 'obj-1', online_count: 0, companies: [] });
  });

  it('filters offline employees and groups online by object/company', async () => {
    travelMock.mockResolvedValue([
      makeTravelObject('obj-1', 'Склад', ['Турникет-1']),
      makeTravelObject('obj-2', 'Офис', ['Дверь-А']),
    ]);
    presenceMock.mockResolvedValue([
      makePresenceItem({ employee_id: 1, full_name: 'Иванов', status: 'online', last_access_point: 'Турникет-1', first_entry: '08:00:00' }),
      makePresenceItem({ employee_id: 2, full_name: 'Петров', status: 'online', last_access_point: 'Дверь-А', first_entry: '09:30:00' }),
      makePresenceItem({ employee_id: 3, full_name: 'Сидоров', status: 'offline', last_access_point: 'Турникет-1' }),
    ]);
    pgQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM employees')) {
        return Promise.resolve([
          { id: 1, org_department_id: 'dept-A' },
          { id: 2, org_department_id: 'dept-B' },
        ]);
      }
      return Promise.resolve([]);
    });
    companyResolveMock.mockResolvedValue({
      rootId: 'root',
      companyByDeptId: new Map([
        ['dept-A', 'company-1'],
        ['dept-B', 'company-2'],
      ]),
      companyMeta: new Map([
        ['company-1', { id: 'company-1', name: 'ООО Альфа', sigur_department_id: 100 }],
        ['company-2', { id: 'company-2', name: 'ООО Бета', sigur_department_id: 200 }],
      ]),
      companyBySigurId: new Map([[100, 'company-1'], [200, 'company-2']]),
      companyByNormalizedName: new Map([['ооо альфа', 'company-1'], ['ооо бета', 'company-2']]),
    });

    const data = await getPresenceByObject();
    expect(data.total_online).toBe(2);
    expect(data.buckets).toHaveLength(2);

    const totalFromBuckets = data.buckets.reduce((sum, b) => sum + b.online_count, 0);
    expect(totalFromBuckets).toBe(2);

    for (const bucket of data.buckets) {
      const sum = bucket.companies.reduce((s, c) => s + c.online_count, 0);
      expect(sum).toBe(bucket.online_count);
    }

    const sklad = data.buckets.find(b => b.object_id === 'obj-1')!;
    expect(sklad.online_count).toBe(1);
    expect(sklad.companies[0].company_name).toBe('ООО Альфа');
    expect(sklad.companies[0].employees[0].full_name).toBe('Иванов');
    expect(sklad.companies[0].employees[0].is_unsynced).toBe(false);
  });

  it('propagates department_name from synced presence into employee row', async () => {
    travelMock.mockResolvedValue([makeTravelObject('obj-1', 'Склад', ['Турникет-1'])]);
    presenceMock.mockResolvedValue([
      makePresenceItem({
        employee_id: 1,
        full_name: 'Иванов',
        status: 'online',
        last_access_point: 'Турникет-1',
        department_name: 'Бригада №3',
      }),
    ]);
    pgQuery.mockImplementation((sql: string) =>
      Promise.resolve(sql.includes('FROM employees') ? [{ id: 1, org_department_id: 'dept-A' }] : []),
    );
    companyResolveMock.mockResolvedValue({
      rootId: 'root',
      companyByDeptId: new Map([['dept-A', 'company-1']]),
      companyMeta: new Map([['company-1', { id: 'company-1', name: 'ООО Альфа', sigur_department_id: 100 }]]),
      companyBySigurId: new Map([[100, 'company-1']]),
      companyByNormalizedName: new Map([['ооо альфа', 'company-1']]),
    });

    const data = await getPresenceByObject();
    const emp = data.buckets[0].companies[0].employees[0];
    expect(emp.department_name).toBe('Бригада №3');
  });

  it('puts employee without department into __no_company__', async () => {
    travelMock.mockResolvedValue([makeTravelObject('obj-1', 'Склад', ['Турникет-1'])]);
    presenceMock.mockResolvedValue([
      makePresenceItem({ employee_id: 10, status: 'online', last_access_point: 'Турникет-1' }),
    ]);
    pgQuery.mockImplementation((sql: string) =>
      Promise.resolve(sql.includes('FROM employees') ? [{ id: 10, org_department_id: null }] : []),
    );

    const data = await getPresenceByObject();
    expect(data.total_online).toBe(1);
    const bucket = data.buckets.find(b => b.object_id === 'obj-1')!;
    expect(bucket.companies[0].company_id).toBe(NO_COMPANY_ID);
  });

  it('routes employee with unmatched access_point to "Без объекта" bucket', async () => {
    travelMock.mockResolvedValue([makeTravelObject('obj-1', 'Склад', ['Турникет-1'])]);
    presenceMock.mockResolvedValue([
      makePresenceItem({ employee_id: 20, status: 'online', last_access_point: 'Незнакомая-точка' }),
    ]);
    pgQuery.mockImplementation((sql: string) =>
      Promise.resolve(sql.includes('FROM employees') ? [{ id: 20, org_department_id: null }] : []),
    );

    const data = await getPresenceByObject();
    const noObject = data.buckets.find(b => b.object_id === null);
    expect(noObject).toBeDefined();
    expect(noObject!.online_count).toBe(1);
    const sklad = data.buckets.find(b => b.object_id === 'obj-1');
    expect(sklad!.online_count).toBe(0);
  });

  it('includes unsynced events with Sigur company resolved into virtual company', async () => {
    travelMock.mockResolvedValue([makeTravelObject('obj-1', 'Склад', ['Турникет-1'])]);
    presenceMock.mockResolvedValue([]);
    pgQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM skud_events') && sql.includes('employee_id IS NULL')) {
        return Promise.resolve([
          { physical_person: 'Иванов Иван', event_time: '09:00:00', direction: 'entry', access_point: 'Турникет-1' },
        ]);
      }
      return Promise.resolve([]);
    });
    sigurResolveMock.mockResolvedValue(new Map([
      ['иванов иван', makeSigurMatch(999, 'Подрядчик X', 555, 'Электромонтаж')],
    ]));

    const data = await getPresenceByObject();
    expect(data.total_online).toBe(1);
    const sklad = data.buckets.find(b => b.object_id === 'obj-1')!;
    expect(sklad.online_count).toBe(1);
    expect(sklad.companies[0].company_id).toBe(`${SIGUR_COMPANY_ID_PREFIX}999`);
    expect(sklad.companies[0].company_name).toBe('Подрядчик X');
    expect(sklad.companies[0].employees[0].is_unsynced).toBe(true);
    expect(sklad.companies[0].employees[0].full_name).toBe('Иванов Иван');
    expect(sklad.companies[0].employees[0].department_name).toBe('Электромонтаж');
  });

  it('merges unsynced into local company when sigur_department_id matches', async () => {
    travelMock.mockResolvedValue([makeTravelObject('obj-1', 'Склад', ['Турникет-1'])]);
    presenceMock.mockResolvedValue([
      makePresenceItem({ employee_id: 1, full_name: 'Synced One', status: 'online', last_access_point: 'Турникет-1', first_entry: '08:00:00' }),
    ]);
    pgQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM employees')) {
        return Promise.resolve([{ id: 1, org_department_id: 'dept-A' }]);
      }
      if (sql.includes('FROM skud_events') && sql.includes('employee_id IS NULL')) {
        return Promise.resolve([
          { physical_person: 'Чужой Иван', event_time: '09:00:00', direction: 'entry', access_point: 'Турникет-1' },
        ]);
      }
      return Promise.resolve([]);
    });
    companyResolveMock.mockResolvedValue({
      rootId: 'root',
      companyByDeptId: new Map([['dept-A', 'company-1']]),
      companyMeta: new Map([['company-1', { id: 'company-1', name: 'ООО Альфа', sigur_department_id: 100 }]]),
      companyBySigurId: new Map([[100, 'company-1']]),
      companyByNormalizedName: new Map([['ооо альфа', 'company-1']]),
    });
    sigurResolveMock.mockResolvedValue(new Map([
      ['чужой иван', makeSigurMatch(100, 'ООО Альфа', 110, 'Бригада №2')],
    ]));

    const data = await getPresenceByObject();
    expect(data.total_online).toBe(2);
    const sklad = data.buckets.find(b => b.object_id === 'obj-1')!;
    expect(sklad.online_count).toBe(2);
    // Одна компания вместо двух — мердж по sigur_department_id.
    expect(sklad.companies).toHaveLength(1);
    expect(sklad.companies[0].company_id).toBe('company-1');
    expect(sklad.companies[0].online_count).toBe(2);
    const syncedFlags = sklad.companies[0].employees.map(e => e.is_unsynced);
    expect(syncedFlags).toContain(true);
    expect(syncedFlags).toContain(false);
  });

  it('merges unsynced into local company by name when sigur_department_id does not match (Bug #1 fix)', async () => {
    // Сценарий из прода: у local company sigur_department_id отличается от Sigur root,
    // но имена идентичны → раньше получали два блока «(СУ-10) ООО СУ-10», теперь один.
    travelMock.mockResolvedValue([makeTravelObject('obj-1', 'ЖК Инжой', ['Турникет-1'])]);
    presenceMock.mockResolvedValue([
      makePresenceItem({ employee_id: 1, full_name: 'Synced One', status: 'online', last_access_point: 'Турникет-1' }),
    ]);
    pgQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM employees')) {
        return Promise.resolve([{ id: 1, org_department_id: 'dept-A' }]);
      }
      if (sql.includes('FROM skud_events') && sql.includes('employee_id IS NULL')) {
        return Promise.resolve([
          { physical_person: 'Чужой Иван', event_time: '09:00:00', direction: 'entry', access_point: 'Турникет-1' },
        ]);
      }
      return Promise.resolve([]);
    });
    companyResolveMock.mockResolvedValue({
      rootId: 'root',
      companyByDeptId: new Map([['dept-A', 'company-1']]),
      companyMeta: new Map([['company-1', { id: 'company-1', name: '(СУ-10) ООО СУ-10', sigur_department_id: 100 }]]),
      companyBySigurId: new Map([[100, 'company-1']]),
      companyByNormalizedName: new Map([['(су-10) ооо су-10', 'company-1']]),
    });
    // ВАЖНО: Sigur root id (999) НЕ совпадает с local sigur_department_id (100),
    // но имя совпадает → должны мерджить.
    sigurResolveMock.mockResolvedValue(new Map([
      ['чужой иван', makeSigurMatch(999, '(СУ-10) ООО СУ-10', 110, 'Бригада №2')],
    ]));

    const data = await getPresenceByObject();
    const sklad = data.buckets.find(b => b.object_id === 'obj-1')!;
    // Один блок, не два.
    expect(sklad.companies).toHaveLength(1);
    expect(sklad.companies[0].company_id).toBe('company-1');
    expect(sklad.companies[0].online_count).toBe(2);
  });

  it('puts unsynced person into __no_company__ when Sigur did not resolve', async () => {
    travelMock.mockResolvedValue([makeTravelObject('obj-1', 'Склад', ['Турникет-1'])]);
    pgQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM skud_events') && sql.includes('employee_id IS NULL')) {
        return Promise.resolve([
          { physical_person: 'Гость Безымянный', event_time: '09:00:00', direction: 'entry', access_point: 'Турникет-1' },
        ]);
      }
      return Promise.resolve([]);
    });
    // sigurResolveMock возвращает пустую Map (по умолчанию)
    const data = await getPresenceByObject();
    const sklad = data.buckets.find(b => b.object_id === 'obj-1')!;
    expect(sklad.companies[0].company_id).toBe(NO_COMPANY_ID);
    expect(sklad.companies[0].employees[0].is_unsynced).toBe(true);
  });

  it('treats unsynced with last event=exit as offline (not in online_count)', async () => {
    travelMock.mockResolvedValue([makeTravelObject('obj-1', 'Склад', ['Турникет-1'])]);
    pgQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM skud_events') && sql.includes('employee_id IS NULL')) {
        // events DESC: latest event is exit at 18:00, earlier entry at 09:00.
        return Promise.resolve([
          { physical_person: 'Уходящий', event_time: '18:00:00', direction: 'exit', access_point: 'Турникет-1' },
          { physical_person: 'Уходящий', event_time: '09:00:00', direction: 'entry', access_point: 'Турникет-1' },
        ]);
      }
      return Promise.resolve([]);
    });

    const data = await getPresenceByObject();
    expect(data.total_online).toBe(0);
  });

  it('excludes events on internal access points', async () => {
    internalPointsMock.mockResolvedValue(new Set(['Внутренний-1']));
    travelMock.mockResolvedValue([makeTravelObject('obj-1', 'Склад', ['Турникет-1'])]);
    pgQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM skud_events') && sql.includes('employee_id IS NULL')) {
        return Promise.resolve([
          { physical_person: 'Тестовый', event_time: '09:00:00', direction: 'entry', access_point: 'Внутренний-1' },
        ]);
      }
      return Promise.resolve([]);
    });

    const data = await getPresenceByObject();
    expect(data.total_online).toBe(0);
  });

  it('sorts buckets by online_count DESC then by name', async () => {
    travelMock.mockResolvedValue([
      makeTravelObject('a', 'Антарктида', ['ap-a']),
      makeTravelObject('b', 'Бункер', ['ap-b']),
      makeTravelObject('c', 'Вышка', ['ap-c']),
    ]);
    presenceMock.mockResolvedValue([
      makePresenceItem({ employee_id: 1, status: 'online', last_access_point: 'ap-b' }),
      makePresenceItem({ employee_id: 2, status: 'online', last_access_point: 'ap-b' }),
      makePresenceItem({ employee_id: 3, status: 'online', last_access_point: 'ap-c' }),
    ]);
    pgQuery.mockResolvedValue([
      { id: 1, org_department_id: null },
      { id: 2, org_department_id: null },
      { id: 3, org_department_id: null },
    ]);

    const data = await getPresenceByObject();
    expect(data.buckets.map(b => b.object_id)).toEqual(['b', 'c', 'a']);
  });

  it('caches result within TTL', async () => {
    travelMock.mockResolvedValue([makeTravelObject('obj-1', 'Склад', ['Турникет-1'])]);
    await getPresenceByObject();
    await getPresenceByObject();
    expect(travelMock).toHaveBeenCalledTimes(1);
    expect(presenceMock).toHaveBeenCalledTimes(1);
  });

  it('reloads after invalidation', async () => {
    travelMock.mockResolvedValue([]);
    await getPresenceByObject();
    invalidatePresenceByObjectCache();
    await getPresenceByObject();
    expect(travelMock).toHaveBeenCalledTimes(2);
  });
});
