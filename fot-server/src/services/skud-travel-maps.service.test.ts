import { beforeEach, describe, expect, it, vi } from 'vitest';

type QueryRecord = {
  table: string;
  operations: Array<{ method: string; args: unknown[] }>;
};

type QueryResponse = {
  data?: unknown;
  error?: { code?: string; message?: string } | null;
};

const mockedState = vi.hoisted(() => ({
  queryLog: [] as QueryRecord[],
  resolver: (() => ({ data: [], error: null })) as (query: QueryRecord) => QueryResponse | Promise<QueryResponse>,
  uploadUrl: 'https://storage.example/upload',
  downloadUrl: 'https://storage.example/download',
  ensuredObjects: [] as Array<{ bucket: string; path: string }>,
  removedObjects: [] as Array<{ bucket: string; path: string | null | undefined }>,
}));

function createBuilder(table: string) {
  const query: QueryRecord = { table, operations: [] };
  mockedState.queryLog.push(query);

  const builder = {
    select: (...args: unknown[]) => {
      query.operations.push({ method: 'select', args });
      return builder;
    },
    eq: (...args: unknown[]) => {
      query.operations.push({ method: 'eq', args });
      return builder;
    },
    in: (...args: unknown[]) => {
      query.operations.push({ method: 'in', args });
      return builder;
    },
    neq: (...args: unknown[]) => {
      query.operations.push({ method: 'neq', args });
      return builder;
    },
    order: (...args: unknown[]) => {
      query.operations.push({ method: 'order', args });
      return builder;
    },
    delete: (...args: unknown[]) => {
      query.operations.push({ method: 'delete', args });
      return builder;
    },
    insert: (...args: unknown[]) => {
      query.operations.push({ method: 'insert', args });
      return builder;
    },
    update: (...args: unknown[]) => {
      query.operations.push({ method: 'update', args });
      return builder;
    },
    single: (...args: unknown[]) => {
      query.operations.push({ method: 'single', args });
      return builder;
    },
    maybeSingle: (...args: unknown[]) => {
      query.operations.push({ method: 'maybeSingle', args });
      return builder;
    },
    then: (onFulfilled: (value: QueryResponse) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(mockedState.resolver(query)).then(onFulfilled, onRejected),
  };

  return builder;
}

vi.mock('../config/database.js', () => ({
  supabase: {
    from: vi.fn((table: string) => createBuilder(table)),
  },
}));

vi.mock('./supabase-storage.service.js', () => ({
  SKUD_OBJECT_MAPS_BUCKET: 'skud-object-maps',
  supabaseStorageService: {
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

const ok = (data: unknown): QueryResponse => ({ data, error: null });

const hasOperation = (query: QueryRecord, method: string): boolean => (
  query.operations.some(operation => operation.method === method)
);

const getOperationArgs = <T = unknown>(query: QueryRecord, method: string): T[] => {
  const operation = query.operations.find(candidate => candidate.method === method);
  return (operation?.args || []) as T[];
};

describe('skud-travel.service map features', () => {
  beforeEach(() => {
    mockedState.queryLog.length = 0;
    mockedState.ensuredObjects.length = 0;
    mockedState.removedObjects.length = 0;
    mockedState.resolver = () => ok([]);
  });

  it('returns map flags and mapped point counts for travel objects', async () => {
    mockedState.resolver = (query) => {
      if (query.table === 'skud_objects') {
        return ok([
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
        ]);
      }

      if (query.table === 'skud_object_access_points') {
        return ok([
          { object_id: 'obj-1', access_point_name: ' КПП B ' },
          { object_id: 'obj-1', access_point_name: 'КПП A' },
          { object_id: 'obj-2', access_point_name: 'КПП C' },
        ]);
      }

      if (query.table === 'skud_object_map_points') {
        return ok([
          {
            object_id: 'obj-1',
            access_point_name: 'КПП A',
            x_ratio: 0.1,
            y_ratio: 0.2,
            created_at: '2026-04-10T10:00:00Z',
            updated_at: '2026-04-10T10:00:00Z',
          },
          {
            object_id: 'obj-1',
            access_point_name: 'КПП B',
            x_ratio: 0.3,
            y_ratio: 0.4,
            created_at: '2026-04-10T10:00:00Z',
            updated_at: '2026-04-10T10:00:00Z',
          },
        ]);
      }

      throw new Error(`Unexpected query for table ${query.table}`);
    };

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
    let currentObject = {
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
    let currentPoints = [
      {
        object_id: 'obj-1',
        access_point_name: 'КПП A',
        x_ratio: 0.25,
        y_ratio: 0.75,
        created_at: '2026-04-01T00:00:00Z',
        updated_at: '2026-04-01T00:00:00Z',
      },
    ];

    mockedState.resolver = (query) => {
      if (query.table === 'skud_objects') {
        if (hasOperation(query, 'update')) {
          const [payload] = getOperationArgs<Record<string, unknown>>(query, 'update');
          currentObject = {
            ...currentObject,
            ...payload,
          };
          return ok([]);
        }

        return ok(currentObject);
      }

      if (query.table === 'skud_object_map_points') {
        if (hasOperation(query, 'delete')) {
          currentPoints = [];
          return ok([]);
        }

        return ok(currentPoints);
      }

      throw new Error(`Unexpected query for table ${query.table}`);
    };

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
    let storedPoints: Array<{
      object_id: string;
      access_point_name: string;
      x_ratio: number;
      y_ratio: number;
      created_at: string;
      updated_at: string;
    }> = [];

    mockedState.resolver = (query) => {
      if (query.table === 'skud_objects') {
        return ok(currentObject);
      }

      if (query.table === 'skud_object_access_points') {
        return ok([
          { object_id: 'obj-1', access_point_name: 'КПП A' },
          { object_id: 'obj-2', access_point_name: 'КПП Z' },
        ]);
      }

      if (query.table === 'skud_object_map_points') {
        if (hasOperation(query, 'delete')) {
          if (getOperationArgs<unknown[]>(query, 'eq').some(args => args[0] === 'object_id' && args[1] === 'obj-1')) {
            storedPoints = [];
          }
          return ok([]);
        }

        if (hasOperation(query, 'insert')) {
          const [payload] = getOperationArgs<Array<{ object_id: string; access_point_name: string; x_ratio: number; y_ratio: number }>>(query, 'insert');
          storedPoints = payload.map(point => ({
            ...point,
            created_at: '2026-04-10T10:05:00Z',
            updated_at: '2026-04-10T10:05:00Z',
          }));
          return ok(payload);
        }

        return ok(storedPoints);
      }

      throw new Error(`Unexpected query for table ${query.table}`);
    };

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
    expect(
      mockedState.queryLog.some(query => (
        query.table === 'skud_object_map_points'
        && hasOperation(query, 'delete')
        && hasOperation(query, 'in')
        && hasOperation(query, 'neq')
      )),
    ).toBe(true);
  });

  it('rejects map markers for access points that are not assigned to the object', async () => {
    mockedState.resolver = (query) => {
      if (query.table === 'skud_objects') {
        return ok({
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
      }

      if (query.table === 'skud_object_access_points') {
        return ok([
          { object_id: 'obj-1', access_point_name: 'КПП A' },
        ]);
      }

      if (query.table === 'skud_object_map_points') {
        return ok([]);
      }

      throw new Error(`Unexpected query for table ${query.table}`);
    };

    await expect(saveTravelObjectMapPoints({
      objectId: 'obj-1',
      points: [
        { access_point_name: 'КПП B', x_ratio: 0.2, y_ratio: 0.4 },
      ],
    })).rejects.toThrow('Точка доступа "КПП B" не привязана к выбранному объекту');
  });

  it('returns a signed map view for a mapped access point', async () => {
    mockedState.resolver = (query) => {
      if (query.table === 'skud_object_map_points') {
        return ok({
          object_id: 'obj-1',
          access_point_name: 'КПП A',
          x_ratio: 0.4,
          y_ratio: 0.6,
        });
      }

      if (query.table === 'skud_objects') {
        return ok({
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
        });
      }

      throw new Error(`Unexpected query for table ${query.table}`);
    };

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
