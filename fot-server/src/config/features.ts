/**
 * Feature flags — читаются из process.env, .env не меняем.
 *
 * LOGIN_2FA_ENABLED — включает 2FA-проверку при логине.
 *   При true: если у пользователя two_factor_enabled, после ввода пароля
 *   возвращается промежуточный токен (two_factor_verified=false),
 *   требующий подтверждения через /api/auth/verify-2fa.
 *   При false (default): 2FA при логине не требуется.
 *
 * CRITICAL_2FA_ENABLED — включает 2FA для критических мутаций
 *   (импорт, удаление, синхронизация). Контролирует middleware requireCritical2FA.
 */
export const LOGIN_2FA_ENABLED = process.env.LOGIN_2FA_ENABLED === 'true';
export const CRITICAL_2FA_ENABLED = process.env.CRITICAL_2FA_ENABLED === 'true';

/** true когда NODE_ENV явно установлен в 'production' */
export const IS_PRODUCTION = process.env.NODE_ENV === 'production';
