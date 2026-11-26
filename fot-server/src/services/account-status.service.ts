import { queryOne } from '../config/postgres.js';
import { loadAutoInactiveDepartmentIds, staffInactiveSql } from './employee-inactive.service.js';

/**
 * Единая проверка «пускать ли владельца профиля на портал».
 *
 * Правило одно на все точки входа (login, authenticate, /auth/refresh,
 * Socket.IO handshake): профиль без привязки к карточке сотрудника пускаем
 * всегда (подрядчики и сервисные учётки), профиль со связанным сотрудником —
 * только пока тот не уволен и не неактивен (миграция 381).
 *
 * Проверка динамическая, без хранимого флага блокировки: увольнение и неактивность
 * ничего не стирают, а восстановление / «Вернуть в активные» / перевод из «Декрета»
 * открывают доступ сами, вместе со всеми данными аккаунта.
 *
 * Увольнение — строго `employment_status = 'fired'`:
 *  - `is_archived` доступ не закрывает — архив это техническое состояние карточки;
 *  - запланированное на будущее увольнение (заполнен только `dismissal_date`)
 *    не блокирует, пока статус фактически не сменился.
 *
 * Неактивность — employee-inactive.service (ручная метка или «Декрет»/«Архив»). Служебная учётка
 * с `user_profiles.login_when_staff_inactive` от неактивности не блокируется (учётка «Учёт проживания»,
 * её карточка в «Архиве»); увольнение закрывает вход и ей.
 */
export const DISMISSED_ACCOUNT_ERROR = 'Учётная запись отключена: сотрудник уволен';
export const DISMISSED_ACCOUNT_CODE = 'EMPLOYEE_DISMISSED';

export const INACTIVE_ACCOUNT_ERROR = 'Учётная запись отключена: сотрудник переведён в неактивные';
export const INACTIVE_ACCOUNT_CODE = 'EMPLOYEE_INACTIVE';

/** true — владелец профиля уволен и на портал не допускается. */
export function isDismissedEmploymentStatus(status: string | null | undefined): boolean {
  return status === 'fired';
}

export interface IEmploymentAccessState {
  /** Статус связанного сотрудника; null — профиль без карточки. */
  employmentStatus: string | null;
  /** Карточка неактивна (ручная метка или «Декрет»/«Архив»); у профиля без карточки — false. */
  staffInactive: boolean;
  /** Служебная учётка: неактивность вход не закрывает. */
  loginWhenStaffInactive: boolean;
}

export interface IEmploymentBlock {
  code: typeof DISMISSED_ACCOUNT_CODE | typeof INACTIVE_ACCOUNT_CODE;
  error: string;
}

/** Закрыт ли вход из-за карточки сотрудника; null — пускать. Увольнение важнее неактивности. */
export function resolveEmploymentBlock(state: IEmploymentAccessState): IEmploymentBlock | null {
  if (isDismissedEmploymentStatus(state.employmentStatus)) {
    return { code: DISMISSED_ACCOUNT_CODE, error: DISMISSED_ACCOUNT_ERROR };
  }
  if (state.staffInactive && !state.loginWhenStaffInactive) {
    return { code: INACTIVE_ACCOUNT_CODE, error: INACTIVE_ACCOUNT_ERROR };
  }
  return null;
}

/**
 * Колонки состояния для запроса с `user_profiles up LEFT JOIN employees e`. Параметр списка отделов «Декрет»/«Архив»
 * дописывается в params. Используется и в authenticate — там это тот же единственный запрос к БД.
 */
export function employmentAccessColumnsSql(params: unknown[], autoInactiveIds: readonly string[]): string {
  return `e.employment_status,
          ${staffInactiveSql('e', params, autoInactiveIds)} AS staff_inactive,
          up.login_when_staff_inactive`;
}

export interface IEmploymentAccessRow {
  employment_status: string | null;
  staff_inactive: boolean | null;
  login_when_staff_inactive: boolean | null;
}

export function toEmploymentAccessState(row: IEmploymentAccessRow | null | undefined): IEmploymentAccessState {
  return {
    employmentStatus: row?.employment_status ?? null,
    staffInactive: row?.staff_inactive === true,
    loginWhenStaffInactive: row?.login_when_staff_inactive === true,
  };
}

// ─── Отключённая учётная запись (чёрный список, миграция 273) ───────────────

export const DISABLED_ACCOUNT_ERROR = 'Учётная запись отключена администратором';
export const DISABLED_ACCOUNT_CODE = 'ACCOUNT_DISABLED';

export interface IProfileAccessState extends IEmploymentAccessState {
  isDisabled: boolean;
  /** Текущая версия токенов профиля (сверка в рукопожатии Socket.IO). */
  tokenVersion: number;
}

/**
 * Читает статус доступа профиля одним запросом: увольнение, неактивность, флаг отключения и версию токенов.
 * null — профиль не найден.
 *
 * is_disabled в authenticate НЕ проверяется намеренно — это hot path на каждый
 * запрос. Активную сессию рвёт token_version (его authenticate уже сверяет),
 * повторный вход закрывает verifyPassword, а выпуск новой сессии — проверка
 * здесь, в /auth/refresh.
 */
export async function getProfileAccessState(profileId: string): Promise<IProfileAccessState | null> {
  const params: unknown[] = [profileId];
  const columns = employmentAccessColumnsSql(params, await loadAutoInactiveDepartmentIds());
  const row = await queryOne<IEmploymentAccessRow & { is_disabled: boolean | null; token_version: number | null }>(
    `SELECT ${columns},
            au.is_disabled,
            up.token_version
       FROM user_profiles up
       LEFT JOIN employees e ON e.id = up.employee_id
       LEFT JOIN app_auth.users au ON au.id = up.id
      WHERE up.id = $1::uuid`,
    params,
  );
  if (!row) return null;
  return {
    ...toEmploymentAccessState(row),
    isDisabled: row.is_disabled === true,
    tokenVersion: Number.isFinite(Number(row.token_version)) ? Number(row.token_version) : 0,
  };
}

/** Закрыт ли вход профилю из-за карточки сотрудника; профиль не найден — null (его отрабатывают сами точки входа). */
export async function getProfileEmploymentBlock(profileId: string): Promise<IEmploymentBlock | null> {
  const state = await getProfileAccessState(profileId);
  return state ? resolveEmploymentBlock(state) : null;
}
