import { useEffect, useState } from 'react';

// Сверяет buildId работающего бандла (__BUILD_ID__) с dist/version.json на сервере.
// При расхождении возвращает updateAvailable=true — значит открытая вкладка/PWA
// работает на устаревшем коде (после деплоя) и шлёт старые payload'ы.
// Проверка: на mount, при возврате фокуса/видимости вкладки и раз в ~10 минут.

const POLL_INTERVAL_MS = 10 * 60_000;

export const useVersionCheck = (): { updateAvailable: boolean } => {
  const [updateAvailable, setUpdateAvailable] = useState(false);

  useEffect(() => {
    // В dev version.json не эмитится — проверка не нужна.
    if (import.meta.env.DEV) return;

    let cancelled = false;
    let timer = 0;

    const check = async (): Promise<void> => {
      if (cancelled || updateAvailable) return;
      try {
        const res = await fetch(`/version.json?ts=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) return;
        const data: { buildId?: string } = await res.json();
        if (!cancelled && data.buildId && data.buildId !== __BUILD_ID__) {
          setUpdateAvailable(true);
          window.clearInterval(timer);
        }
      } catch {
        // offline / 404 / невалидный JSON — молча игнорируем.
      }
    };

    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void check();
    };

    void check();
    timer = window.setInterval(() => void check(), POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [updateAvailable]);

  return { updateAvailable };
};
