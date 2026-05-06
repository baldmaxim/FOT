/**
 * Общий кэш + загрузчик метаданных точек доступа Sigur (skud_objects + skud_object_access_points + skud_object_map_points).
 * Раньше дублировался в sigur.controller и sigur-live-admin.service — теперь живёт здесь, чтобы оба потребителя
 * делили один LRU-кэш и in-flight Promise.
 */

import { supabase } from '../config/database.js';
import { createCache } from '../utils/cache.js';

export interface IAccessPointObjectMeta {
  objectId: string | null;
  objectName: string | null;
  hasMapPreview: boolean;
}

const ACCESS_POINT_META_CACHE_TTL_MS = 5 * 60 * 1000;

const accessPointObjectMetaCache = createCache<{ map: Map<string, IAccessPointObjectMeta> }>({
  max: 1,
  ttlMs: ACCESS_POINT_META_CACHE_TTL_MS,
});

let accessPointObjectMetaInFlight: Promise<Map<string, IAccessPointObjectMeta>> | null = null;

export function normalizeAccessPointKey(value: string | null | undefined): string {
  return value?.trim().toLocaleLowerCase('ru') || '';
}

export async function loadAccessPointObjectMetaMap(): Promise<Map<string, IAccessPointObjectMeta>> {
  const cached = accessPointObjectMetaCache.get('default');
  if (cached) {
    return cached.map;
  }

  if (accessPointObjectMetaInFlight) {
    return accessPointObjectMetaInFlight;
  }

  accessPointObjectMetaInFlight = (async () => {
    const [objectsResult, accessPointsResult, mapPointsResult] = await Promise.all([
      supabase.from('skud_objects').select('id, name, map_storage_path'),
      supabase.from('skud_object_access_points').select('object_id, access_point_name'),
      supabase.from('skud_object_map_points').select('object_id, access_point_name'),
    ]);

    if (objectsResult.error) throw objectsResult.error;
    if (accessPointsResult.error) throw accessPointsResult.error;
    if (mapPointsResult.error) throw mapPointsResult.error;

    const objectMetaById = new Map<string, { name: string | null; hasMap: boolean }>();
    for (const row of objectsResult.data || []) {
      objectMetaById.set(String(row.id), {
        name: typeof row.name === 'string' && row.name.trim() ? row.name.trim() : null,
        hasMap: !!row.map_storage_path,
      });
    }

    const mapPointObjectByName = new Map<string, string>();
    for (const row of mapPointsResult.data || []) {
      const key = normalizeAccessPointKey(row.access_point_name);
      if (!key) continue;
      mapPointObjectByName.set(key, String(row.object_id));
    }

    const metaMap = new Map<string, IAccessPointObjectMeta>();
    for (const row of accessPointsResult.data || []) {
      const key = normalizeAccessPointKey(row.access_point_name);
      if (!key) continue;

      const objectId = row.object_id ? String(row.object_id) : (mapPointObjectByName.get(key) || null);
      const objectMeta = objectId ? objectMetaById.get(objectId) : null;
      metaMap.set(key, {
        objectId,
        objectName: objectMeta?.name || null,
        hasMapPreview: !!objectId && mapPointObjectByName.has(key) && !!objectMeta?.hasMap,
      });
    }

    for (const [key, objectId] of mapPointObjectByName.entries()) {
      if (metaMap.has(key)) continue;
      const objectMeta = objectMetaById.get(objectId);
      metaMap.set(key, {
        objectId,
        objectName: objectMeta?.name || null,
        hasMapPreview: !!objectMeta?.hasMap,
      });
    }

    accessPointObjectMetaCache.set('default', { map: metaMap });
    return metaMap;
  })()
    .catch((error) => {
      console.warn('Sigur access point object metadata warning:', error);
      return new Map<string, IAccessPointObjectMeta>();
    })
    .finally(() => {
      accessPointObjectMetaInFlight = null;
    });

  return accessPointObjectMetaInFlight;
}
