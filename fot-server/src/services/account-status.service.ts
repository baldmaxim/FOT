import { queryOne } from '../config/postgres.js';

/**
 * Единая проверка «пускать ли владельца профиля на портал».
 *
 * Правило одно на все точки входа (login, authenticate, /auth/refresh,
 * Socket.IO handshake): профиль без привязки к карточке сотрудника пускаем
 * всегда (подрядчики и сервисные учётки), профиль со связанным сотрудником —
 * только пока тот не уволен.
 *
 * Проверка динамическая, без хранимого флага блокировки: увольнение ничего не
 * стирает и не выставляет, а восстановление (employment_status → 'active')
 * открывает доступ само, вместе со всеми данными аккаунта.
 *
 * Критерий строго `employment_status = 'fired'`:
 *  - `is_archived` доступ не закрывает — архив это техническое состояние карточки;
 *  - запланированное на будущее увольнение (заполнен только `dismissal_date`)
 *    не блокирует, пока статус фактически не сменился.
 */
export const DISMISSED_ACCOUNT_ERROR = 'Учётная запись отключена: сотрудник уволен';
export const DISMISSED_ACCOUNT_CODE = 'EMPLOYEE_DISMISSED';

/** true — владелец профиля уволен и на портал не допускается. */
export function isDismissedEmploymentStatus(status: string | null | undefined): boolean {
  return status === 'fired';
}

/**
 * Читает статус сотрудника, связанного с профилем. `null` — профиль без
 * `employee_id` либо профиль не найден: в обоих случаях блокировать нечего,
 * отсутствие профиля отрабатывают сами точки входа.
 */
export async function getProfileEmploymentStatus(profileId: string): Promise<string | null> {
  const row = await queryOne<{ employment_status: string | null }>(
    `SELECT e.employment_status
       FROM user_profiles up
       LEFT JOIN employees e ON e.id = up.employee_id
      WHERE up.id = $1::uuid`,
    [profileId],
  );
  return row?.employment_status ?? null;
}

/** Полная проверка одним вызовом: true — вход разрешён. */
export async function isProfileAllowedToSignIn(profileId: string): Promise<boolean> {
  return !isDismissedEmploymentStatus(await getProfileEmploymentStatus(profileId));
}
