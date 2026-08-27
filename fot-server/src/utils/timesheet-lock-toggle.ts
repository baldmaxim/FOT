// Кто вправе открывать и закрывать сданный табель.
//
// Отдельный модуль без зависимостей, потому что предикат нужен в двух местах: в
// access-control.service (гейт роута /open и /close) и в ответе на отказ записи в
// закрытый период (utils/timesheet-lock-response). Держать его в access-control.service
// не вышло: этот сервис мокают два десятка тестов, и любой новый импортёр начинал
// падать на «No export is defined on the mock». Дублировать правило нельзя — оно
// определяет, кому вообще доступен штатный путь правки закрытого табеля.

/**
 * Админ и кадровая служба.
 *
 * Роль hr намеренно не гейтится страницей /timesheet-hr — на проде этой страницы у неё
 * нет, а выдача открыла бы заодно утверждение, отклонение и возврат. Хардкод role_code
 * здесь — тот же приём, что в data-scope.service (read-all для hr).
 *
 * Чистая функция без Express: её же дёргает middleware и тесты прав.
 */
export function canToggleTimesheetLock(
  user: { is_admin?: boolean | null; role_code?: string | null } | null | undefined,
): boolean {
  if (!user) return false;
  return user.is_admin === true || user.role_code === 'hr';
}
