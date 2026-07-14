import { getAdminEntryPath, type INavVisibilityContext } from './adminEntry';

/**
 * Выбор «домашней» страницы пользователя (лендинг для маршрута «/» и логотипа
 * сайдбара). Каскад повторяет исторический порядок из PositionBasedRedirect,
 * плюс узкие роли без /dashboard (ОТиТБ, «Менеджер МТС») — иначе они попадали
 * в петлю /unauthorized (у «/» нет права доступа, это чистый роутинг-редирект).
 *
 * Чистая функция без хуков — принимает canViewPage и employeeVariant извне.
 */
export const getLandingPath = (
  canViewPage: (pagePath: string) => boolean,
  employeeVariant: string | null,
  navContext?: INavVisibilityContext,
): string => {
  // Тип кабинета «Подрядчик» — всегда лендинг на /contractor.
  if (employeeVariant === 'contractor') return '/contractor';
  if (canViewPage('/dashboard')) return '/dashboard';
  if (canViewPage('/employee')) return '/employee';
  if (canViewPage('/contractor')) return '/contractor';
  // Роль без личного кабинета: первая доступная страница админки
  // (табельщица → /timesheet, ОТиТБ → /admin/contractor-approvals и т.п.).
  const adminEntry = getAdminEntryPath(navContext ?? {
    canViewPage,
    employeeVariant,
    isCompanyAdmin: false,
    isWeekendResponsible: false,
  });
  return adminEntry ?? '/unauthorized';
};
