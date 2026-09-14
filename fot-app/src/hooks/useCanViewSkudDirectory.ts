import { useAuth } from '../contexts/AuthContext';

/** Полный раздел «СКУД» (все вкладки) или технический ключ просмотра трёх вкладок. */
export const SKUD_DIRECTORY_PAGE = '/skud-settings/directory';

/**
 * Чтение справочников СКУД: точки доступа, объекты, база, карты объектов и мини-карты точек.
 * Бэкенд пускает эти GET по any(['/skud-settings', '/skud-settings/directory'], 'view').
 */
export const useCanViewSkudDirectory = (): boolean => {
  const { canViewPage } = useAuth();
  return canViewPage('/skud-settings') || canViewPage(SKUD_DIRECTORY_PAGE);
};
