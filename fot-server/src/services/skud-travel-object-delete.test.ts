import { beforeEach, describe, expect, it, vi } from 'vitest';

// Удаление объекта СКУД: объект, указанный местом нарушения в удержаниях (миграция 383, FK RESTRICT), не удаляется —
// понятный 409 «архивируйте» вместо ошибки FK; без ссылок удаление идёт как раньше.

const pg = vi.hoisted(() => ({ query: vi.fn(), queryOne: vi.fn(), execute: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../config/postgres.js', () => pg);

const storage = vi.hoisted(() => ({ removeObject: vi.fn() }));
vi.mock('./object-map-storage.service.js', () => ({
  SKUD_OBJECT_MAPS_BUCKET: 'maps',
  objectMapStorageService: storage,
}));

import { deleteTravelObject } from './skud-travel.service.js';

const OBJECT_ID = '0b8e6c1e-4f53-4f0b-9a3c-2a1f7b9d8e10';

/** queryOne по подстроке SQL: объект, KPI-блокеры, ссылки удержаний. */
const routeQueryOne = (deductionRefs: number) => async (sql: string) => {
  if (sql.includes('FROM skud_objects')) return { id: OBJECT_ID, name: 'ЖК Сад 69', map_storage_path: null };
  if (sql.includes('object_contracts')) return { contracts: 0, ks2: 0, ks6: 0, assignments: 0, plans: 0 };
  if (sql.includes('FROM staff_deductions')) return { count: String(deductionRefs) };
  throw new Error(`unexpected queryOne: ${sql}`);
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('deleteTravelObject и удержания', () => {
  it('объект указан в удержании — 409 object_in_deductions, DELETE не выполняется', async () => {
    pg.queryOne.mockImplementation(routeQueryOne(2));

    await expect(deleteTravelObject(OBJECT_ID)).rejects.toMatchObject({
      __save: {
        http: 409,
        code: 'object_in_deductions',
        message: 'Объект указан местом нарушения в удержаниях — удаление запрещено, архивируйте его',
      },
    });
    expect(pg.execute).not.toHaveBeenCalled();
  });

  it('ссылок нет — объект удаляется', async () => {
    pg.queryOne.mockImplementation(routeQueryOne(0));
    pg.execute.mockResolvedValue(1);

    await deleteTravelObject(OBJECT_ID);

    expect(pg.execute).toHaveBeenCalledWith('DELETE FROM skud_objects WHERE id = $1', [OBJECT_ID]);
  });
});
