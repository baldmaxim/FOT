/**
 * ЭТАП 2: резолвинг точек доступа в числовые id Sigur.
 * Цепочка: имя точки доступа (из skud_object_access_points либо переданное
 * явно) → numeric accessPointId (getAccessPointOptionsCached).
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
 * Резолвит произвольный список имён точек доступа в numeric id Sigur.
 * unmatchedNames — имена, которым не нашлось точки в Sigur (диагностика).
 */
export const resolveAccessPointNamesToIds = async (
  names: string[],
  connection?: ConnectionType,
): Promise<IResolvedObjectAccessPoints> => {
  const cleaned = [...new Set(names.map(n => n.trim()).filter(Boolean))];
  if (cleaned.length === 0) {
    return { accessPointIds: [], unmatchedNames: [] };
  }

  const options = await sigurService.getAccessPointOptionsCached(connection);
  const byName = new Map<string, number>();
  for (const opt of options) {
    if (opt.name) byName.set(norm(opt.name), opt.id);
  }

  const accessPointIds: number[] = [];
  const unmatchedNames: string[] = [];
  for (const name of cleaned) {
    const id = byName.get(norm(name));
    if (id != null) accessPointIds.push(id);
    else unmatchedNames.push(name);
  }
  return { accessPointIds: [...new Set(accessPointIds)], unmatchedNames };
};

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
  return resolveAccessPointNamesToIds(rows.map(r => r.access_point_name), connection);
};
