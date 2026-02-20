import type { AuthenticatedRequest } from '../types/index.js';

/**
 * Извлекает organization_id из запроса с учётом super_admin.
 * Приоритет: req.user.organization_id → query.organization_id → body.organization_id
 * Для не-super_admin возвращает только req.user.organization_id.
 */
export function getOrgId(req: AuthenticatedRequest): string | undefined {
  if (req.user.organization_id) return req.user.organization_id;

  if (req.user.position_type !== 'super_admin') return undefined;

  const fromQuery = req.query.organization_id;
  if (typeof fromQuery === 'string' && fromQuery) return fromQuery;

  const fromBody = req.body?.organization_id;
  if (typeof fromBody === 'string' && fromBody) return fromBody;

  return undefined;
}
