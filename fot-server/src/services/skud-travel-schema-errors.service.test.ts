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

vi.mock('./skud-shared.service.js', () => ({
  getInternalAccessPoints: vi.fn(async () => new Set()),
}));

vi.mock('./settings.service.js', () => ({
  settingsService: {
    getSkudTravelConfig: vi.fn(async () => ({ limitMinutes: 60 })),
    setSkudTravelConfig: vi.fn(),
  },
}));

vi.mock('./object-map-storage.service.js', () => ({
  SKUD_OBJECT_MAPS_BUCKET: 'skud-object-maps',
  objectMapStorageService: {
    buildObjectMapPath: vi.fn(),
    createSignedUploadUrl: vi.fn(),
    createSignedDownloadUrl: vi.fn(),
    ensureObjectExists: vi.fn(),
    removeObject: vi.fn(),
  },
}));

import { listTravelObjects } from './skud-travel.service.js';

describe('skud-travel.service schema diagnostics', () => {
  beforeEach(() => {
    pgQuery.mockReset();
    pgQueryOne.mockReset();
    pgExecute.mockReset();
    pgTx.mockReset();
  });

  it('points to migration 026 when map columns are missing', async () => {
    // listTravelObjects вызывает fetchTravelObjectsRaw / fetchTravelMappingsRaw / fetchTravelObjectMapPointsRaw
    // параллельно через Promise.all. Триггер диагностики — ошибка с упоминанием map_storage_path
    // (fragment из TRAVEL_OBJECT_MAP_SCHEMA_HINT), которая попадает в formatTravelFeatureError.
    pgQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('skud_objects')) {
        const err = Object.assign(new Error('column skud_objects.map_storage_path does not exist'), {
          code: '42703',
        });
        throw err;
      }
      if (sql.includes('skud_object_access_points') || sql.includes('skud_object_map_points')) {
        return [];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    await expect(listTravelObjects()).rejects.toThrow(
      'Карты объектов СКУД не видны через API. Примените миграцию 026_skud_object_maps.sql в текущую базу.',
    );
  });
});
