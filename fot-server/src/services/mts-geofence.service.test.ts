import { describe, it, expect, vi, beforeEach } from 'vitest';

const { pgExecute, pgQuery, pgQueryOne, pgWithTransaction } = vi.hoisted(() => ({
  pgExecute: vi.fn(),
  pgQuery: vi.fn(),
  pgQueryOne: vi.fn(),
  pgWithTransaction: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  execute: pgExecute,
  query: pgQuery,
  queryOne: pgQueryOne,
  withTransaction: pgWithTransaction,
}));

import { mtsGeofenceService, GeofenceValidationError } from './mts-geofence.service.js';

const validRing = [
  { lat: 55.75, lng: 37.61 },
  { lat: 55.75, lng: 37.63 },
  { lat: 55.76, lng: 37.63 },
  { lat: 55.76, lng: 37.61 },
];

describe('mts-geofence.service createGeofence', () => {
  beforeEach(() => {
    pgExecute.mockReset();
    pgQuery.mockReset();
    pgQueryOne.mockReset();
  });

  it('отказывает при пустом name', async () => {
    await expect(
      mtsGeofenceService.createGeofence({ name: '   ', geometry: validRing }, 'user-1'),
    ).rejects.toBeInstanceOf(GeofenceValidationError);
  });

  it('отказывает при невалидной геометрии (<3 точек)', async () => {
    await expect(
      mtsGeofenceService.createGeofence({ name: 'X', geometry: [{ lat: 0, lng: 0 }] }, 'user-1'),
    ).rejects.toMatchObject({ reason: 'too_few_points' });
  });

  it('отказывает при self-intersecting', async () => {
    const bowtie = [
      { lat: 0, lng: 0 },
      { lat: 1, lng: 1 },
      { lat: 0, lng: 1 },
      { lat: 1, lng: 0 },
    ];
    await expect(
      mtsGeofenceService.createGeofence({ name: 'Bow', geometry: bowtie }, 'user-1'),
    ).rejects.toMatchObject({ reason: 'self_intersecting' });
  });

  it('успешно создаёт зону и сериализует геометрию как JSON', async () => {
    pgQueryOne
      .mockResolvedValueOnce({ id: 'geo-1' })  // INSERT RETURNING
      .mockResolvedValueOnce({                   // getById
        id: 'geo-1',
        name: 'Test',
        geometry: validRing,
        is_active: true,
        created_by: 'user-1',
        created_at: '2026-05-20T10:00:00Z',
        updated_at: '2026-05-20T10:00:00Z',
        employee_ids: [],
      });

    const created = await mtsGeofenceService.createGeofence(
      { name: '  Test  ', geometry: validRing },
      'user-1',
    );
    expect(created.id).toBe('geo-1');
    expect(created.name).toBe('Test');
    expect(created.geometry).toEqual(validRing);

    // INSERT-аргументы: name (trimmed), JSON.stringify(ring), userId
    expect(pgQueryOne.mock.calls[0][1]).toEqual(['Test', JSON.stringify(validRing), 'user-1']);
  });
});

describe('mts-geofence.service setAssignments', () => {
  beforeEach(() => {
    pgExecute.mockReset();
    pgQuery.mockReset();
    pgQueryOne.mockReset();
    pgWithTransaction.mockReset();
  });

  it('возвращает null если геозона не найдена', async () => {
    pgQueryOne.mockResolvedValueOnce(null);
    const r = await mtsGeofenceService.setAssignments('geo-x', [1, 2], 'user-1');
    expect(r).toBeNull();
  });

  it('replace-семантика: DELETE + INSERT в одной транзакции', async () => {
    pgQueryOne
      .mockResolvedValueOnce({
        id: 'geo-1',
        name: 'Test',
        geometry: validRing,
        is_active: true,
        created_by: 'user-1',
        created_at: 't',
        updated_at: 't',
        employee_ids: [],
      })
      .mockResolvedValueOnce({  // повторный getById
        id: 'geo-1',
        name: 'Test',
        geometry: validRing,
        is_active: true,
        created_by: 'user-1',
        created_at: 't',
        updated_at: 't',
        employee_ids: [1, 2],
      });

    const txQueries: { sql: string; params: unknown[] }[] = [];
    pgWithTransaction.mockImplementation(async (fn: (c: { query: (sql: string, params: unknown[]) => Promise<unknown> }) => Promise<unknown>) => {
      const fakeClient = {
        query: async (sql: string, params: unknown[]) => {
          txQueries.push({ sql, params });
          return { rowCount: 0, rows: [] };
        },
      };
      return fn(fakeClient);
    });

    const r = await mtsGeofenceService.setAssignments('geo-1', [1, 2, 2, -3], 'user-1');
    expect(r?.employeeIds).toEqual([1, 2]);

    expect(txQueries[0].sql).toContain('DELETE FROM mts_geofence_assignments');
    expect(txQueries[0].params).toEqual(['geo-1']);
    expect(txQueries[1].sql).toContain('INSERT INTO mts_geofence_assignments');
    // дедуп и отброс отрицательных
    expect(txQueries[1].params).toEqual(['geo-1', 'user-1', [1, 2]]);
  });

  it('пустой список = только DELETE, без INSERT', async () => {
    pgQueryOne
      .mockResolvedValueOnce({
        id: 'geo-1',
        name: 'Test',
        geometry: validRing,
        is_active: true,
        created_by: 'user-1',
        created_at: 't',
        updated_at: 't',
        employee_ids: [1, 2],
      })
      .mockResolvedValueOnce({
        id: 'geo-1',
        name: 'Test',
        geometry: validRing,
        is_active: true,
        created_by: 'user-1',
        created_at: 't',
        updated_at: 't',
        employee_ids: [],
      });

    const txQueries: { sql: string; params: unknown[] }[] = [];
    pgWithTransaction.mockImplementation(async (fn: (c: { query: (sql: string, params: unknown[]) => Promise<unknown> }) => Promise<unknown>) => {
      const fakeClient = {
        query: async (sql: string, params: unknown[]) => {
          txQueries.push({ sql, params });
          return { rowCount: 0, rows: [] };
        },
      };
      return fn(fakeClient);
    });

    await mtsGeofenceService.setAssignments('geo-1', [], 'user-1');
    expect(txQueries.length).toBe(1);
    expect(txQueries[0].sql).toContain('DELETE FROM mts_geofence_assignments');
  });
});

describe('mts-geofence.service openViolation', () => {
  beforeEach(() => {
    pgExecute.mockReset();
    pgQueryOne.mockReset();
  });

  it('шифрует координаты перед записью', async () => {
    pgQueryOne.mockResolvedValueOnce({ id: 'v-1' });

    await mtsGeofenceService.openViolation({
      geofenceId: 'g-1',
      employeeId: 42,
      startedAt: new Date('2026-05-20T12:00:00Z'),
      latitude: 55.751244,
      longitude: 37.618423,
      accuracyMeters: 250,
      source: 'lbs',
    });

    const params = pgQueryOne.mock.calls[0][1] as unknown[];
    // [geofenceId, employeeId, startedAt, lat_enc, lon_enc, acc_enc, src_enc]
    expect(params[0]).toBe('g-1');
    expect(params[1]).toBe(42);
    expect(params[2]).toBe('2026-05-20T12:00:00.000Z');
    // координаты НЕ должны лежать в открытом виде
    expect(String(params[3])).not.toContain('55.751244');
    expect(String(params[4])).not.toContain('37.618423');
    // ciphertext формата iv:authTag:encrypted
    expect(String(params[3]).split(':')).toHaveLength(3);
  });
});
