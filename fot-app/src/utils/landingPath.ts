/**
 * Выбор «домашней» страницы пользователя (лендинг для маршрута «/» и логотипа
 * сайдбара). Каскад повторяет исторический порядок из PositionBasedRedirect,
 * плюс узкие роли без /dashboard (ОТиТБ) — иначе они попадали в петлю
 * /unauthorized (у «/» нет права доступа, это чистый роутинг-редирект).
 *
 * Чистая функция без хуков — принимает canViewPage и employeeVariant извне.
 */
export const getLandingPath = (
  canViewPage: (pagePath: string) => boolean,
  employeeVariant: string | null,
): string => {
  // Тип кабинета «Подрядчик» — всегда лендинг на /contractor.
  if (employeeVariant === 'contractor') return '/contractor';
  if (canViewPage('/dashboard')) return '/dashboard';
  if (canViewPage('/employee')) return '/employee';
  if (canViewPage('/contractor')) return '/contractor';
  // Табельщица: единственная доступная страница — «Табель».
  if (canViewPage('/timesheet')) return '/timesheet';
  // ОТиТБ: технический ключ вкладки → реальный маршрут раздела «Подрядчики».
  if (
    canViewPage('/admin/contractor-approvals')
    || canViewPage('/admin/contractor-approvals/submissions')
    || canViewPage('/admin/contractor-approvals/otitb')
  ) {
    return '/admin/contractor-approvals';
  }
  return '/unauthorized';
};
