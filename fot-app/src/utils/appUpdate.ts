// Тихое обновление фронта. Когда вышла новая сборка (см. useVersionCheck), страницу
// перезагружаем сами при переходе в другой раздел, а баннер показываем, только если
// человек долго не уходил со страницы.

export const BANNER_DELAY_MS = 2 * 60 * 60_000;

const RELOADED_FOR_KEY = 'fot:update-reload';

// Вход (в т.ч. 2FA) держит состояние в памяти AuthContext — перезагрузка посреди него
// выкинет на логин. «/» — транзитный редирект по должности.
const NO_RELOAD_PATHS: ReadonlySet<string> = new Set([
  '/',
  '/login',
  '/register',
  '/verify-2fa',
  '/pending-approval',
  '/forgot-password',
  '/reset-password',
]);

const normalizePath = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, '') : path);

interface IReloadOnNavigationInput {
  updateAvailable: boolean;
  prevPath: string;
  nextPath: string;
  latestBuildId: string | null;
  // Сборка, ради которой эта вкладка уже перезагружалась (readReloadedFor).
  reloadedFor: string | null;
  isMutating: boolean;
}

export const shouldReloadOnNavigation = ({
  updateAvailable,
  prevPath,
  nextPath,
  latestBuildId,
  reloadedFor,
  isMutating,
}: IReloadOnNavigationInput): boolean => {
  if (!updateAvailable || !latestBuildId) return false;
  const prev = normalizePath(prevPath);
  const next = normalizePath(nextPath);
  if (prev === next) return false;
  if (NO_RELOAD_PATHS.has(prev) || NO_RELOAD_PATHS.has(next)) return false;
  // Сохранение ещё летит — перезагрузка его оборвёт; обновимся на следующем переходе.
  if (isMutating) return false;
  // Уже перезагружались ради этой сборки, а бандл не обновился — не зацикливаемся.
  return reloadedFor !== latestBuildId;
};

export const isBannerDue = (detectedAt: number | null, now: number): boolean =>
  detectedAt !== null && now - detectedAt >= BANNER_DELAY_MS;

export const readReloadedFor = (): string | null => {
  try {
    return window.sessionStorage.getItem(RELOADED_FOR_KEY);
  } catch {
    return null;
  }
};

// false — отметку записать не удалось (sessionStorage недоступен): без неё нет защиты
// от петли, поэтому вызывающий код перезагружать страницу не должен.
export const markReloadedFor = (buildId: string): boolean => {
  try {
    window.sessionStorage.setItem(RELOADED_FOR_KEY, buildId);
    return true;
  } catch {
    return false;
  }
};
