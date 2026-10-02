import type { SystemRole } from '../types/auth';

type IAssignableRoleInput = Pick<SystemRole, 'code' | 'is_active' | 'assignable'>;

/**
 * Роли для селектора «Должность» в карточке пользователя («Все пользователи»).
 *
 * Админ видит все активные роли. Не-админ (кадровый админ) — только роли из allowlist
 * (флаг assignable считает сервер в GET /roles): иначе выбор упирался бы в 403
 * «Эта роль недоступна для назначения». Текущая роль пользователя остаётся в списке
 * всегда — даже неактивная или недоступная для выдачи: селектор показывает, что
 * назначено сейчас.
 */
export const filterAssignableRoleOptions = <T extends IAssignableRoleInput>(
  roles: readonly T[],
  currentRoleCode: string,
  viewerIsAdmin: boolean,
): T[] => roles.filter(role => role.code === currentRoleCode
  || (role.is_active && (viewerIsAdmin || role.assignable === true)));
