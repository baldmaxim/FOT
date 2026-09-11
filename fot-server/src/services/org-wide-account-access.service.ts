// Работа с учётными записями пользователей по всей организации без скоупа отделов:
// очередь регистраций, подтверждение email, сброс пароля, ФИО, удаление, привязка
// подрядчика к организации.
//
// Раньше это умели только системный админ и роль с all_departments_scope. Но флаг
// all_departments_scope расширяет запись и в табеле/документах (ЛК-ключи + скоуп 'all'),
// поэтому для учёток — отдельный технический ключ /admin/users/accounts.
//
// Ключ НЕ снимает checkRoleAssignable / checkTargetUserManageable: учётки админских
// ролей и выдача ролей вне allowlist остаются за системным админом. Чужие права
// (/admin/users/access) ключ тоже не даёт.

import { PAGE_PATHS } from '../config/access-control.js';
import { resolveEffectivePageAccess } from './access-control.service.js';
import { resolveCompanyScope } from './data-scope.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * Системный админ — да. Админ компании — нет (is_admin обходит матрицу, поэтому
 * page-проверка его бы пропустила). Остальные — по ключу /admin/users/accounts.
 */
export async function hasOrgWideAccountAccess(
  req: AuthenticatedRequest,
  action: 'view' | 'edit',
): Promise<boolean> {
  if (req.user.is_admin) {
    const scope = await resolveCompanyScope(req);
    return scope.roots === 'all';
  }
  return resolveEffectivePageAccess(req, PAGE_PATHS.ADMIN_USERS_ACCOUNTS, action);
}
