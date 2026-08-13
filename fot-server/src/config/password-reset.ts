// Срок жизни ссылки сброса пароля. Ссылку передают пользователю вручную
// (Telegram, звонок, лично), поэтому часа не хватало.
export const PASSWORD_RESET_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
export const PASSWORD_RESET_TOKEN_TTL_LABEL = '24 часа';
