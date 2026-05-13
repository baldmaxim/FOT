import { beforeEach, describe, expect, it, vi } from 'vitest';

const { pgQuery, pgQueryOne, pgExecute, pgTx } = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  pgQueryOne: vi.fn(),
  pgExecute: vi.fn(),
  pgTx: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: pgQueryOne,
  execute: pgExecute,
  withTransaction: pgTx,
}));

const mockedState = vi.hoisted(() => ({
  uploadUrl: 'https://storage.example/upload',
  downloadUrl: 'https://storage.example/download',
  ensuredObjects: [] as Array<{ bucket: string; path: string }>,
  removedObjects: [] as Array<{ bucket: string; path: string | null | undefined }>,
}));

vi.mock('./object-map-storage.service.js', () => ({
  SKUD_OBJECT_MAPS_BUCKET: 'skud-object-maps',
  objectMapStorageService: {
    buildObjectMapPath: vi.fn((objectId: string, fileName: string) => `travel-objects/${objectId}/${fileName}`),
    createSignedUploadUrl: vi.fn(async (_bucket: string, storagePath: string) => ({
      signedUrl: mockedState.uploadUrl,
      path: storagePath,
      token: 'upload-token',
    })),
    createSignedDownloadUrl: vi.fn(async () => mockedState.downloadUrl),
    ensureObjectExists: vi.fn(async (bucket: string, path: string) => {
      mockedState.ensuredObjects.push({ bucket, path });
    }),
    removeObject: vi.fn(async (bucket: string, path: string | null | undefined) => {
      mockedState.removedObjects.push({ bucket, path });
    }),
  },
}));

vi.mock('./skud-shared.service.js', () => ({
  getInternalAccessPoints: vi.fn(async () => new Set()),
}));

vi.mock('./settings.service.js', () => ({
  settingsService: {
    getSkudTravelConfig: vi.fn(async () => ({ limitMinutes: 60 })),
    setSkudTravelConfig: vi.fn(),
  },
}));

import {
  confirmTravelObjectMapUpload,
  getAccessPointMapView,
  listTravelObjects,
  saveTravelObjectMapPoints,
} from './skud-travel.service.js';

describe('skud-travel.service map features', () => {
  beforeEach(() => {
    pgQuery.mockReset();
    pgQueryOne.mockReset();
    pgExecute.mockReset();
    pgTx.mockReset();
    mockedState.ensuredObjects.length = 0;
    mockedState.removedObjects.length = 0;

    pgQuery.mockResolvedValue([]);
    pgExecute.mockResolvedValue(0);
  });

  it('returns map flags and mapped point counts for travel objects', async () => {
    // listTravelObjects → Promise.all([
    //   fetchTravelObjectsRaw (query skud_objects),
    //   fetchTravelMappingsRaw (query skud_object_access_points),
    //   fetchTravelObjectMapPointsRaw (query skud_object_map_points)
    // ])
    pgQuery.mockImplementation(async (sql: string) => {
      const lower = sql.toLowerCase();
      if (lower.includes('from skud_objects')) {
        return [
          {
            id: 'obj-1',
            name: 'Объект 1',
            is_active: true,
            map_storage_path: 'travel-objects/obj-1/map.png',
            map_file_name: 'map.png',
            map_mime_type: 'image/png',
            map_file_size: 1024,
            map_uploaded_at: '2026-04-10T10:00:00Z',
            created_at: '2026-04-01T00:00:00Z',
            updated_at: '2026-04-10T10:00:00Z',
          },
          {
            id: 'obj-2',
            name: 'Объект 2',
            is_active: true,
            map_storage_path: null,
            map_file_name: null,
            map_mime_type: null,
            map_file_size: null,
            map_uploaded_at: null,
            created_at: '2026-04-01T00:00:00Z',
            updated_at: '2026-04-01T00:00:00Z',
          },
        ];
      }
      if (lower.includes('from skud_object_access_points')) {
        return [
          { object_id: 'obj-1', access_point_name: ' КПП B ' },
          { object_id: 'obj-1', access_point_name: 'КПП A' },
          { object_id: 'obj-2', access_point_name: 'КПП C' },
        ];
      }
      if (lower.includes('from skud_object_map_points')) {
        return [
          { object_id: 'obj-1', access_point_name: 'КПП A', x_ratio: 0.1, y_ratio: 0.2, created_at: '2026-04-10T10:00:00Z', updated_at: '2026-04-10T10:00:00Z' },
          { object_id: 'obj-1', access_point_name: 'КПП B', x_ratio: 0.3, y_ratio: 0.4, created_at: '2026-04-10T10:00:00Z', updated_at: '2026-04-10T10:00:00Z' },
        ];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    await expect(listTravelObjects()).resolves.toEqual([
      expect.objectContaining({
        id: 'obj-1',
        has_map: true,
        mapped_points_count: 2,
        access_points: ['КПП A', 'КПП B'],
      }),
      expect.objectContaining({
        id: 'obj-2',
        has_map: false,
        mapped_points_count: 0,
        access_points: ['КПП C'],
      }),
    ]);
  });

  it('replaces object map metadata, clears markers, and removes the previous file', async () => {
    let currentObject: Record<string, unknown> = {
      id: 'obj-1',
      name: 'Объект 1',
      is_active: true,
      map_storage_path: 'travel-objects/obj-1/old-map.png',
      map_file_name: 'old-map.png',
      map_mime_type: 'image/png',
      map_file_size: 1000,
      map_uploaded_at: '2026-04-01T00:00:00Z',
      created_at: '2026-04-01T00:00:00Z',
      updated_at: '2026-04-01T00:00:00Z',
    };

    // confirmTravelObjectMapUpload:
    //   1) fetchTravelObjectByIdRaw → queryOne SELECT ... FROM skud_objects WHERE id = $1
    //   2) objectMapStorageService.ensureObjectExists(...)
    //   3) execute(UPDATE skud_objects SET map_storage_path = $1 ...)
    //   4) execute(DELETE FROM skud_object_map_points WHERE object_id = $1)
    //   5) (если previousStoragePath !== normalized) → objectMapStorageService.removeObject(...)
    //   6) getTravelObjectMap → fetchTravelObjectByIdRaw + fetchTravelObjectMapPointsRaw(objectId)
    pgQueryOne.mockImplementation(async (sql: string) => {
      if (sql.toLowerCase().includes('from skud_objects')) {
        return currentObject;
      }
      return null;
    });

    pgExecute.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.toLowerCase().includes('update skud_objects')) {
        currentObject = {
          ...currentObject,
          map_storage_path: params?.[0],
          map_file_name: params?.[1],
          map_mime_type: params?.[2],
          map_file_size: params?.[3],
          map_uploaded_at: params?.[4],
          updated_at: params?.[5],
        };
      }
      return 1;
    });

    pgQuery.mockResolvedValue([]); // fetchTravelObjectMapPointsRaw → []

    const result = await confirmTravelObjectMapUpload({
      objectId: 'obj-1',
      storagePath: 'travel-objects/obj-1/new-map.png',
      fileName: 'new-map.png',
      contentType: 'image/png',
      fileSize: 2048,
    });

    expect(mockedState.ensuredObjects).toEqual([
      { bucket: 'skud-object-maps', path: 'travel-objects/obj-1/new-map.png' },
    ]);
    expect(mockedState.removedObjects).toEqual([
      { bucket: 'skud-object-maps', path: 'travel-objects/obj-1/old-map.png' },
    ]);
    expect(result).toEqual(expect.objectContaining({
      object_id: 'obj-1',
      storage_path: 'travel-objects/obj-1/new-map.png',
      file_name: 'new-map.png',
      file_size: 2048,
      points: [],
      image_url: mockedState.downloadUrl,
    }));
  });

  it('saves valid map markers, normalizes coordinates, and clears conflicting point bindings', async () => {
    const currentObject = {
      id: 'obj-1',
      name: 'Объект 1',
      is_active: true,
      map_storage_path: 'travel-objects/obj-1/map.png',
      map_file_name: 'map.png',
      map_mime_type: 'image/png',
      map_file_size: 2048,
      map_uploaded_at: '2026-04-10T10:00:00Z',
      created_at: '2026-04-01T00:00:00Z',
      updated_at: '2026-04-10T10:00:00Z',
    };

    pgQueryOne.mockResolvedValue(currentObject);
    pgQuery.mockImplementation(async (sql: string) => {
      const lower = sql.toLowerCase();
      if (lower.includes('from skud_object_access_points')) {
        return [
          { object_id: 'obj-1', access_point_name: 'КПП A' },
          { object_id: 'obj-2', access_point_name: 'КПП Z' },
        ];
      }
      if (lower.includes('from skud_object_map_points')) {
        // После INSERT — точка с нормализованными координатами.
        return [{
          object_id: 'obj-1',
          access_point_name: 'КПП A',
          x_ratio: 1,
          y_ratio: 0,
          created_at: '2026-04-10T10:05:00Z',
          updated_at: '2026-04-10T10:05:00Z',
        }];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const executeCalls: Array<{ sql: string; params: unknown[] }> = [];
    pgExecute.mockImplementation(async (sql: string, params?: unknown[]) => {
      executeCalls.push({ sql, params: params || [] });
      return 1;
    });

    const result = await saveTravelObjectMapPoints({
      objectId: 'obj-1',
      points: [
        { access_point_name: ' КПП A ', x_ratio: 1.25, y_ratio: -0.2 },
      ],
    });

    expect(result.points).toEqual([
      {
        access_point_name: 'КПП A',
        x_ratio: 1,
        y_ratio: 0,
      },
    ]);
    // Удаление чужих привязок: DELETE WHERE access_point_name = ANY(...) AND object_id <> $2
    expect(executeCalls.some(call =>
      call.sql.toLowerCase().includes('delete from skud_object_map_points')
      && call.sql.includes('access_point_name = ANY')
      && call.sql.includes('object_id <>'),
    )).toBe(true);
  });

  it('rejects map markers for access points that are not assigned to the object', async () => {
    pgQueryOne.mockResolvedValue({
      id: 'obj-1',
      name: 'Объект 1',
      is_active: true,
      map_storage_path: 'travel-objects/obj-1/map.png',
      map_file_name: 'map.png',
      map_mime_type: 'image/png',
      map_file_size: 2048,
      map_uploaded_at: '2026-04-10T10:00:00Z',
      created_at: '2026-04-01T00:00:00Z',
      updated_at: '2026-04-10T10:00:00Z',
    });

    pgQuery.mockImplementation(async (sql: string) => {
      const lower = sql.toLowerCase();
      if (lower.includes('from skud_object_access_points')) {
        return [{ object_id: 'obj-1', access_point_name: 'КПП A' }];
      }
      if (lower.includes('from skud_object_map_points')) {
        return [];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    await expect(saveTravelObjectMapPoints({
      objectId: 'obj-1',
      points: [
        { access_point_name: 'КПП B', x_ratio: 0.2, y_ratio: 0.4 },
      ],
    })).rejects.toThrow('Точка доступа "КПП B" не привязана к выбранному объекту');
  });

  it('returns a signed map view for a mapped access point', async () => {
    // getAccessPointMapView:
    //   1) queryOne SELECT ... FROM skud_object_map_points WHERE access_point_name = $1 LIMIT 1
    //   2) fetchTravelObjectByIdRaw → queryOne SELECT ... FROM skud_objects WHERE id = $1
    //   3) objectMapStorageService.createSignedDownloadUrl(...)
    pgQueryOne.mockImplementation(async (sql: string) => {
      const lower = sql.toLowerCase();
      if (lower.includes('from skud_object_map_points')) {
        return {
          object_id: 'obj-1',
          access_point_name: 'КПП A',
          x_ratio: 0.4,
          y_ratio: 0.6,
        };
      }
      if (lower.includes('from skud_objects')) {
        return {
          id: 'obj-1',
          name: 'Склад 1',
          is_active: true,
          map_storage_path: 'travel-objects/obj-1/map.png',
          map_file_name: 'map.png',
          map_mime_type: 'image/png',
          map_file_size: 2048,
          map_uploaded_at: '2026-04-10T10:00:00Z',
          created_at: '2026-04-01T00:00:00Z',
          updated_at: '2026-04-10T10:00:00Z',
        };
      }
      return null;
    });

    await expect(getAccessPointMapView(' КПП A ')).resolves.toEqual({
      object_id: 'obj-1',
      object_name: 'Склад 1',
      access_point_name: 'КПП A',
      image_url: mockedState.downloadUrl,
      x_ratio: 0.4,
      y_ratio: 0.6,
    });
  });
});
