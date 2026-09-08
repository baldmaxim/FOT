// Какие роли не-админ (кадровый админ) вправе выдавать другим пользователям и
// чьи учётные записи ему вообще позволено трогать.
//
// Список — allowlist (HR_ASSIGNABLE_ROLE_CODES), а не denylist по «опасным»
// страницам: denylist пропустил бы новую чувствительную роль, которую забыли
// внести. Здесь наоборот — новая роль не назначаема, пока её явно не добавят.
//
// Runtime-страховка сверх списка: даже роль из списка не отдаём, если она вдруг
// стала админской или получила глобальный скоуп данных.

import { HR_ASSIGNABLE_ROLE_CODES } from '../config/access-control.js';
import { getRoleByCode } from './roles-cache.service.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { queryOne } from '../config/postgres.js';

const ASSIGNABLE = new Set<string>(HR_ASSIGNABLE_ROLE_CODES);

/** Роль из allowlist и не приобрела админских свойств. */
export async function isRoleAssignableByNonAdmin(roleCode: string | null | undefined): Promise<boolean> {
  if (!roleCode || !ASSIGNABLE.has(roleCode)) return false;
  const role = await getRoleByCode(roleCode);
  if (!role) return false;
  return !role.is_admin && !role.all_departments_scope;
}

/**
 * Целевая роль допустима для актора. Админ выдаёт что угодно, остальные —
 * только из allowlist. Возвращает текст ошибки или null.
 */
export async function checkRoleAssignable(
  req: AuthenticatedRequest,
  targetRoleCode: string,
): Promise<string | null> {
  if (req.user.is_admin) return null;
  if (await isRoleAssignableByNonAdmin(targetRoleCode)) return null;
  return 'Эта роль недоступна для назначения. Обратитесь к системному администратору.';
}

/**
 * Можно ли не-админу управлять учётной записью цели (удалять, сбрасывать пароль,
 * менять роль, выдавать 2FA).
 *
 * Отдельно от scope-проверки: assertTargetUserInScope пропускает всё, когда
 * accessible === 'all', а глобальный скоуп данных (all_departments_scope) как раз
 * его и даёт. Без этой проверки кадровый админ смог бы сбросить пароль админу.
 */
export async function checkTargetUserManageable(
  req: AuthenticatedRequest,
  targetUserId: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (req.user.is_admin) return { ok: true };

  const row = await queryOne<{ role_code: string | null }>(
    `SELECT sr.code AS role_code
       FROM user_profiles up
       LEFT JOIN system_roles sr ON sr.id = up.system_role_id
      WHERE up.id = $1::uuid`,
    [targetUserId],
  );
  if (!row) return { ok: false, status: 404, error: 'Пользователь не найден' };

  // Профиль без роли (устаревшая строка) — тоже не трогаем: неизвестно, что выдаём.
  if (!(await isRoleAssignableByNonAdmin(row.role_code))) {
    return {
      ok: false,
      status: 403,
      error: 'Управление этой учётной записью доступно только системному администратору',
    };
  }
  return { ok: true };
}
