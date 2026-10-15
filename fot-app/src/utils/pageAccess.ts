import type { UserProfile } from '../types/auth';

/**
 * Ключи раздела «Зарплата» — те же, что PAYROLL_SECTION_PAGES на сервере (payroll-access.service).
 * Их решает только список payroll_section_access (миграция 310): сервер кладёт ключи в page_access
 * учёткам из списка и убирает у остальных — в том числе у администраторов.
 */
export const PAYROLL_SECTION_PAGES: readonly string[] = [
  '/salary/payments',
  '/salary/payments/calculate',
  '/salary/payments/approve',
  '/salary/terms',
  '/salary/sick-leaves',
  '/salary/vacations',
  '/salary/deductions',
];

const PAYROLL_SECTION_PAGE_SET = new Set(PAYROLL_SECTION_PAGES);

export const isPayrollSectionPage = (pagePath: string): boolean => PAYROLL_SECTION_PAGE_SET.has(pagePath);

type ProfileAccess = Pick<UserProfile, 'is_admin' | 'page_access'>;

/**
 * Право смотреть страницу. Администратору — любая, кроме раздела «Зарплата»: его ключи смотрим
 * в page_access у всех. Edit без view считаем доступом (сервер это нормализует, здесь — страховка).
 */
export const profileCanViewPage = (profile: ProfileAccess | null | undefined, pagePath: string): boolean => {
  if (!profile) return false;
  if (profile.is_admin && !isPayrollSectionPage(pagePath)) return true;
  const perm = profile.page_access?.[pagePath];
  return perm?.can_view === true || perm?.can_edit === true;
};

/** Право править страницу — с тем же исключением раздела «Зарплата» для администратора. */
export const profileCanEditPage = (profile: ProfileAccess | null | undefined, pagePath: string): boolean => {
  if (!profile) return false;
  if (profile.is_admin && !isPayrollSectionPage(pagePath)) return true;
  return profile.page_access?.[pagePath]?.can_edit === true;
};
