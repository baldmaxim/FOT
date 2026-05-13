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
vi.mock('./skud-shared.service.js', () => ({
  getCompanyResolveIndex: companyResolveMock,
}));

import {
  getPresenceByObject,
  invalidatePresenceByObjectCache,
  NO_COMPANY_ID,
} from './skud-presence-by-object.service.js';

function makePresenceItem(overrides: Partial<{
  employee_id: number;
  full_name: string;
  status: 'online' | 'offline' | 'unknown';
  last_access_point: string | null;
  first_entry: string | null;
  since: string | null;
  position_name: string | null;
}>) {
  return {
    employee_id: overrides.employee_id ?? 1,
    full_name: overrides.full_name ?? 'Сотрудник',
    department_name: null,
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

  pgQuery.mockResolvedValue([]);
  presenceMock.mockResolvedValue([]);
  travelMock.mockResolvedValue([]);
  companyResolveMock.mockResolvedValue({
    rootId: 'root',
    companyByDeptId: new Map(),
    companyMeta: new Map(),
  });
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
    pgQuery.mockResolvedValue([
      { id: 1, org_department_id: 'dept-A' },
      { id: 2, org_department_id: 'dept-B' },
    ]);
    companyResolveMock.mockResolvedValue({
      rootId: 'root',
      companyByDeptId: new Map([
        ['dept-A', 'company-1'],
        ['dept-B', 'company-2'],
      ]),
      companyMeta: new Map([
        ['company-1', { id: 'company-1', name: 'ООО Альфа' }],
        ['company-2', { id: 'company-2', name: 'ООО Бета' }],
      ]),
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
  });

  it('puts employee without department into __no_company__', async () => {
    travelMock.mockResolvedValue([makeTravelObject('obj-1', 'Склад', ['Турникет-1'])]);
    presenceMock.mockResolvedValue([
      makePresenceItem({ employee_id: 10, status: 'online', last_access_point: 'Турникет-1' }),
    ]);
    pgQuery.mockResolvedValue([{ id: 10, org_department_id: null }]);

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
    pgQuery.mockResolvedValue([{ id: 20, org_department_id: null }]);

    const data = await getPresenceByObject();
    const noObject = data.buckets.find(b => b.object_id === null);
    expect(noObject).toBeDefined();
    expect(noObject!.online_count).toBe(1);
    const sklad = data.buckets.find(b => b.object_id === 'obj-1');
    expect(sklad!.online_count).toBe(0);
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
