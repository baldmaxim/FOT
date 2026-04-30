import * as Sentry from '@sentry/react';

const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;

if (dsn && import.meta.env.PROD) {
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE as string | undefined,
    integrations: [Sentry.browserTracingIntegration()],
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
    ignoreErrors: [
      'ResizeObserver loop limit exceeded',
      'ResizeObserver loop completed with undelivered notifications.',
      'Non-Error promise rejection captured',
      // Chunk loading после деплоя — UX обрабатывается через utils/staleChunkReload.ts (auto-reload).
      /Failed to fetch dynamically imported module/,
      /Loading chunk \d+ failed/,
      /error loading dynamically imported module/i,
      /Importing a module script failed/,
      /Failed to load module script/,
      /ChunkLoadError/,
      /Unable to preload CSS/,
    ],
  });
}

export { Sentry };
