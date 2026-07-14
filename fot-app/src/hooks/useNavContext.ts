import { useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { getAdminEntryPath, type INavVisibilityContext } from '../utils/adminEntry';

/** Контекст фильтрации пунктов меню — общий для сайдбаров и лендинг-редиректа. */
export const useNavContext = (): INavVisibilityContext => {
  const { profile, canViewPage, employeeVariant } = useAuth();
  const isCompanyAdmin = !!profile?.is_admin && Array.isArray(profile?.company_scope?.roots);
  const isWeekendResponsible = profile?.is_weekend_responsible === true;

  return useMemo(
    () => ({ canViewPage, employeeVariant, isCompanyAdmin, isWeekendResponsible }),
    [canViewPage, employeeVariant, isCompanyAdmin, isWeekendResponsible],
  );
};

/**
 * Путь входа в админку («Панель управления» из личного кабинета) или null,
 * если у роли нет ни одной админской страницы.
 */
export const useAdminEntryPath = (): string | null => {
  const navContext = useNavContext();
  const { hasAdminAccess } = useAuth();
  return useMemo(
    () => (hasAdminAccess ? getAdminEntryPath(navContext) : null),
    [hasAdminAccess, navContext],
  );
};
