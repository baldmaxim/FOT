/**
 * СКУД-командировки: маршруты между объектами и единый лимит передвижения.
 *
 * Извлечено из skud-travel.service.ts (Волна 3 декомпозиции). Здесь только CRUD
 * на skud_object_routes + конфиг лимита (settingsService.skudTravelConfig).
 * Engine расчёта/синхронизации сегментов, объекты и их карты, listing/approval
 * сегментов — остаются в основном skud-travel.service.
 */
import { query, queryOne, execute } from '../config/postgres.js';
import { settingsService } from './settings.service.js';
import {
  fetchTravelObjectsRaw,
  formatTravelFeatureError,
  invalidateTravelSegmentsCache,
  type ITravelRoute,
  type ITravelRouteRow,
} from './skud-travel.service.js';

const ROUTE_CREDIT_MULTIPLIER = 1;

const fetchTravelRoutesRaw = async (): Promise<ITravelRouteRow[]> => {
  try {
    const data = await query<ITravelRouteRow>(
      `SELECT id, from_object_id, to_object_id, travel_minutes, credit_multiplier, is_active, created_at, updated_at
       FROM skud_object_routes
       WHERE is_active = true
       ORDER BY from_object_id, to_object_id`,
    );
    return data;
  } catch (error) {
    throw formatTravelFeatureError(error);
  }
};

const toTravelRoute = (route: ITravelRouteRow, objectNameById: Map<string, string>): ITravelRoute => ({
  ...route,
  from_object_name: objectNameById.get(route.from_object_id) || null,
  to_object_name: objectNameById.get(route.to_object_id) || null,
  credit_multiplier: ROUTE_CREDIT_MULTIPLIER,
  max_credit_minutes: route.travel_minutes,
});

export const listTravelRoutes = async (): Promise<ITravelRoute[]> => {
  const [objects, routes] = await Promise.all([
    fetchTravelObjectsRaw(),
    fetchTravelRoutesRaw(),
  ]);

  const objectNameById = new Map<string, string>();
  for (const object of objects) {
    objectNameById.set(object.id, object.name);
  }

  return routes.map(route => toTravelRoute(route, objectNameById));
};

export const getTravelConfig = async (): Promise<{ limit_minutes: number | null }> => {
  const config = await settingsService.getSkudTravelConfig();
  return {
    limit_minutes: config.limitMinutes,
  };
};

export const saveTravelConfig = async ({
  limitMinutes,
  userId,
}: {
  limitMinutes: number;
  userId: string;
}): Promise<{ limit_minutes: number | null }> => {
  const config = await settingsService.setSkudTravelConfig({ limitMinutes }, userId);
  invalidateTravelSegmentsCache();
  return {
    limit_minutes: config.limitMinutes,
  };
};

export const createTravelRoute = async ({
  fromObjectId,
  toObjectId,
  travelMinutes,
}: {
  fromObjectId: string;
  toObjectId: string;
  travelMinutes: number;
}): Promise<ITravelRoute> => {
  let route: ITravelRouteRow;
  try {
    const inserted = await queryOne<ITravelRouteRow>(
      `INSERT INTO skud_object_routes (from_object_id, to_object_id, travel_minutes, credit_multiplier, is_active)
       VALUES ($1, $2, $3, $4, true)
       RETURNING id, from_object_id, to_object_id, travel_minutes, credit_multiplier, is_active, created_at, updated_at`,
      [fromObjectId, toObjectId, travelMinutes, ROUTE_CREDIT_MULTIPLIER],
    );
    if (!inserted) throw new Error('Не удалось создать маршрут');
    route = inserted;
  } catch (error) {
    throw formatTravelFeatureError(error);
  }

  const [objects] = await Promise.all([fetchTravelObjectsRaw()]);
  const objectNameById = new Map<string, string>(objects.map(object => [object.id, object.name]));
  invalidateTravelSegmentsCache();

  return toTravelRoute(route, objectNameById);
};

export const updateTravelRoute = async ({
  routeId,
  fromObjectId,
  toObjectId,
  travelMinutes,
}: {
  routeId: string;
  fromObjectId: string;
  toObjectId: string;
  travelMinutes: number;
}): Promise<ITravelRoute> => {
  const updatedAt = new Date().toISOString();
  try {
    await execute(
      `UPDATE skud_object_routes
       SET from_object_id = $1, to_object_id = $2, travel_minutes = $3, updated_at = $4
       WHERE id = $5`,
      [fromObjectId, toObjectId, travelMinutes, updatedAt, routeId],
    );
  } catch (error) {
    throw formatTravelFeatureError(error);
  }

  const routes = await listTravelRoutes();
  const updated = routes.find(route => route.id === routeId);
  if (!updated) throw new Error('Маршрут не найден после сохранения');
  invalidateTravelSegmentsCache();
  return updated;
};

export const deleteTravelRoute = async (routeId: string): Promise<void> => {
  try {
    await execute('DELETE FROM skud_object_routes WHERE id = $1', [routeId]);
  } catch (error) {
    throw formatTravelFeatureError(error);
  }
  invalidateTravelSegmentsCache();
};
