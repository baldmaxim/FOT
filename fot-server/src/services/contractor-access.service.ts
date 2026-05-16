/**
 * ЭТАП 2: резолвинг объекта (skud_objects) в числовые id точек доступа Sigur.
 * Цепочка: skud_object_access_points.access_point_name → имя точки доступа
 * в Sigur → numeric accessPointId (getAccessPointOptionsCached).
 */
import { query } from '../config/postgres.js';
import { sigurService } from './sigur.service.js';
import type { ConnectionType } from './sigur-base.service.js';

const norm = (s: string): string => s.trim().toLocaleLowerCase('ru');

export interface IResolvedObjectAccessPoints {
  accessPointIds: number[];
  unmatchedNames: string[];
}

/**
 * По skud_object_id возвращает id точек доступа Sigur. unmatchedNames —
 * имена из объекта, которым не нашлось точки доступа в Sigur (диагностика).
 */
export const resolveObjectAccessPointIds = async (
  skudObjectId: string,
  connection?: ConnectionType,
): Promise<IResolvedObjectAccessPoints> => {
  const rows = await query<{ access_point_name: string }>(
    'SELECT access_point_name FROM skud_object_access_points WHERE object_id = $1::uuid',
    [skudObjectId],
  );
  if (rows.length === 0) {
    return { accessPointIds: [], unmatchedNames: [] };
  }

  const options = await sigurService.getAccessPointOptionsCached(connection);
  const byName = new Map<string, number>();
  for (const opt of options) {
    if (opt.name) byName.set(norm(opt.name), opt.id);
  }

  const accessPointIds: number[] = [];
  const unmatchedNames: string[] = [];
  for (const row of rows) {
    const id = byName.get(norm(row.access_point_name));
    if (id != null) accessPointIds.push(id);
    else unmatchedNames.push(row.access_point_name);
  }
  return { accessPointIds: [...new Set(accessPointIds)], unmatchedNames };
};
