/**
 * СКУД-командировки: маршруты между объектами и единый лимит передвижения.
 *
 * Извлечено из skud-travel.service.ts (Волна 3 декомпозиции). Здесь только CRUD
 * на skud_object_routes + конфиг лимита (settingsService.skudTravelConfig).
 * Engine расчёта/синхронизации сегментов, объекты и их карты, listing/approval
 * сегментов — остаются в основном skud-travel.service.
 */
import { supabase } from '../config/database.js';
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
  const { data, error } = await supabase
    .from('skud_object_routes')
    .select('id, from_object_id, to_object_id, travel_minutes, credit_multiplier, is_active, created_at, updated_at')
    .eq('is_active', true)
    .order('from_object_id')
    .order('to_object_id');

  if (error) throw formatTravelFeatureError(error);
  return (data || []) as ITravelRouteRow[];
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
  const { data, error } = await supabase
    .from('skud_object_routes')
    .insert({
      from_object_id: fromObjectId,
      to_object_id: toObjectId,
      travel_minutes: travelMinutes,
      credit_multiplier: ROUTE_CREDIT_MULTIPLIER,
      is_active: true,
    })
    .select('id, from_object_id, to_object_id, travel_minutes, credit_multiplier, is_active, created_at, updated_at')
    .single();

  if (error) throw formatTravelFeatureError(error);

  const route = data as ITravelRouteRow;
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
  const { error } = await supabase
    .from('skud_object_routes')
    .update({
      from_object_id: fromObjectId,
      to_object_id: toObjectId,
      travel_minutes: travelMinutes,
      updated_at: updatedAt,
    })
    .eq('id', routeId);

  if (error) throw formatTravelFeatureError(error);

  const routes = await listTravelRoutes();
  const updated = routes.find(route => route.id === routeId);
  if (!updated) throw new Error('Маршрут не найден после сохранения');
  invalidateTravelSegmentsCache();
  return updated;
};

export const deleteTravelRoute = async (routeId: string): Promise<void> => {
  const { error } = await supabase
    .from('skud_object_routes')
    .delete()
    .eq('id', routeId);

  if (error) throw formatTravelFeatureError(error);
  invalidateTravelSegmentsCache();
};
