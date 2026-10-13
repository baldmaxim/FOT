import { type FC, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useVersionCheck } from '../../hooks/useVersionCheck';
import { isBannerDue, markReloadedFor, readReloadedFor, shouldReloadOnNavigation } from '../../utils/appUpdate';
import styles from './AppUpdateBanner.module.css';

const BANNER_TICK_MS = 60_000;

// Обновление открытой вкладки/PWA после деплоя (см. useVersionCheck). Свежий код
// подтягиваем тихо — перезагрузкой при переходе в другой раздел: это устраняет создание
// заявлений старым payload'ом и не сбрасывает открытые формы. Баннер «доступна новая
// версия» — запасной вариант для тех, кто долго не уходит со страницы.
export const AppUpdateBanner: FC = () => {
  const { updateAvailable, latestBuildId, detectedAt } = useVersionCheck();
  const { pathname } = useLocation();
  const queryClient = useQueryClient();
  const prevPathRef = useRef(pathname);
  const [bannerDue, setBannerDue] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const prevPath = prevPathRef.current;
    prevPathRef.current = pathname;
    if (!latestBuildId) return;
    const reload = shouldReloadOnNavigation({
      updateAvailable,
      prevPath,
      nextPath: pathname,
      latestBuildId,
      reloadedFor: readReloadedFor(),
      isMutating: queryClient.isMutating() > 0,
    });
    if (reload && markReloadedFor(latestBuildId)) window.location.reload();
  }, [pathname, updateAvailable, latestBuildId, queryClient]);

  // Интервал, а не один setTimeout на весь срок: спящий ноутбук/телефон таймер замораживает.
  useEffect(() => {
    if (detectedAt === null) return;
    const tick = (): void => {
      if (isBannerDue(detectedAt, Date.now())) setBannerDue(true);
    };
    const timer = window.setInterval(tick, BANNER_TICK_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [detectedAt]);

  if (!updateAvailable || !bannerDue || dismissed) return null;

  return (
    <div className={styles.banner} role="status">
      <span className={styles.text}>Доступна новая версия приложения</span>
      <div className={styles.actions}>
        <button type="button" className={styles.reload} onClick={() => window.location.reload()}>
          Обновить
        </button>
        <button type="button" className={styles.later} onClick={() => setDismissed(true)}>
          Позже
        </button>
      </div>
    </div>
  );
};
