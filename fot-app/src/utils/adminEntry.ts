import { navGroups, type INavItem } from '../components/layout/navConfig';

export interface INavVisibilityContext {
  canViewPage: (pagePath: string) => boolean;
  employeeVariant: string | null;
  /** Админ компании (is_admin со списком company_scope.roots) — не видит системные пункты. */
  isCompanyAdmin: boolean;
  /** Назначен ответственным за согласование выходных (decision 10). */
  isWeekendResponsible: boolean;
}

/** Единый фильтр пунктов бокового меню — используется и сайдбаром, и поиском входа в админку. */
export const isNavItemVisible = (item: INavItem, ctx: INavVisibilityContext): boolean => {
  if (item.systemAdminOnly && ctx.isCompanyAdmin) return false;
  if (item.personalCabinet === 'contractor') return ctx.employeeVariant === 'contractor';
  if (item.id === 'approvals' && ctx.isWeekendResponsible) return true;
  const pages = item.requiredPage ?? item.path;
  const pageList = Array.isArray(pages) ? pages : [pages];
  return pageList.some(page => ctx.canViewPage(page));
};

/**
 * Первая доступная страница админки для пользователя, либо null — если у роли
 * админских страниц нет вовсе. Заменяет прежнюю проверку canViewPage('/dashboard'):
 * теперь вход в админку не зависит от «Обзора» (роль «Менеджер МТС» попадает
 * сразу на /mts-business).
 */
export const getAdminEntryPath = (ctx: INavVisibilityContext): string | null => {
  for (const group of navGroups) {
    if (group.area !== 'admin') continue;
    for (const item of group.items) {
      if (!isNavItemVisible(item, ctx)) continue;
      // Пункт «Обзор» ведёт на «/» (лендинг-редирект) — из ЛК нужен реальный путь.
      return item.path === '/' ? '/dashboard' : item.path;
    }
  }
  return null;
};
