// Кто вправе открывать и закрывать сданный табель.
//
// Отдельный модуль без зависимостей, потому что предикат нужен в двух местах: в
// access-control.service (гейт роута /open и /close) и в ответе на отказ записи в
// закрытый период (utils/timesheet-lock-response). Держать его в access-control.service
// не вышло: этот сервис мокают два десятка тестов, и любой новый импортёр начинал
// падать на «No export is defined on the mock». Дублировать правило нельзя — оно
// определяет, кому вообще доступен штатный путь правки закрытого табеля.

/**
 * Админ и кадровая служба — плюс роли, которым выдан ключ /timesheet/lock-toggle
 * (миграция 270). Ключ асинхронный, а модуль обязан остаться синхронным, поэтому
 * его результат кладётся в req.user.__can_toggle_timesheet_lock middleware'ом
 * resolveTimesheetLockToggle и просто читается здесь.
 *
 * Роль hr намеренно не гейтится страницей /timesheet-hr — на проде этой страницы у неё
 * нет, а выдача открыла бы заодно утверждение, отклонение и возврат. Хардкод role_code
 * остаётся fallback'ом: до применения миграции hr не должна терять право.
 *
 * Чистая функция без Express: её же дёргает middleware и тесты прав.
 */
export function canToggleTimesheetLock(
  user: {
    is_admin?: boolean | null;
    role_code?: string | null;
    __can_toggle_timesheet_lock?: boolean;
  } | null | undefined,
): boolean {
  if (!user) return false;
  if (typeof user.__can_toggle_timesheet_lock === 'boolean') return user.__can_toggle_timesheet_lock;
  return user.is_admin === true || user.role_code === 'hr';
}
