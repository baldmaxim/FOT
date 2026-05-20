import * as Sentry from '@sentry/react';

const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;

const SENSITIVE_KEY_RE = /^(password|password_confirmation|new_password|current_password|totp_code|totp_secret|recovery_code|recovery_codes|token|access_token|refresh_token|api_key|secret|cookie|authorization)$/i;
const SENSITIVE_HEADER_RE = /^(authorization|cookie|x-csrf-token|x-api-key|x-auth-token)$/i;

function scrubValue(value: unknown, depth = 0): unknown {
  if (depth > 6 || value == null) return value;
  if (Array.isArray(value)) return value.map(v => scrubValue(v, depth + 1));
  if (typeof value !== 'object') return value;
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SENSITIVE_KEY_RE.test(k) ? '[Filtered]' : scrubValue(v, depth + 1);
  }
  return out;
}

function scrubHeaders(headers: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!headers) return headers;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADER_RE.test(k) ? '[Filtered]' : v;
  }
  return out;
}

if (dsn && import.meta.env.PROD) {
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE as string | undefined,
    integrations: [
      Sentry.browserTracingIntegration(),
      // Session Replay: запись DOM/событий последних ~60с при ошибке.
      // По умолчанию маскируем весь текст и инпуты — в проекте ФИО, паспорта,
      // СНИЛС, 2FA-коды, сообщения чата (зашифрованы в БД, но в DOM открытые).
      // Чтобы раскрыть нечувствительный элемент — навесить класс `.sentry-unmask`.
      Sentry.replayIntegration({
        maskAllText: true,
        maskAllInputs: true,
        blockAllMedia: true,
        networkDetailAllowUrls: [],
      }),
    ],
    tracesSampleRate: 0.1,
    // Не пишем «фоновые» сессии без ошибок (квота). Поднять до 0.05, если нужны
    // UX-сессии для анализа потока пользователя.
    replaysSessionSampleRate: 0,
    // 100% сессий, в которых произошла ошибка — пишем последние ~60с до неё.
    replaysOnErrorSampleRate: 1.0,
    sendDefaultPii: false,
    beforeSend(event) {
      if (event.request) {
        if (event.request.headers) {
          event.request.headers = scrubHeaders(event.request.headers as Record<string, unknown>) as typeof event.request.headers;
        }
        if (event.request.cookies) {
          event.request.cookies = '[Filtered]' as unknown as typeof event.request.cookies;
        }
        if (event.request.data && typeof event.request.data === 'object') {
          event.request.data = scrubValue(event.request.data);
        }
      }
      if (event.extra) event.extra = scrubValue(event.extra) as typeof event.extra;
      if (event.contexts) event.contexts = scrubValue(event.contexts) as typeof event.contexts;
      return event;
    },
    beforeBreadcrumb(breadcrumb) {
      if (breadcrumb.data) breadcrumb.data = scrubValue(breadcrumb.data) as typeof breadcrumb.data;
      return breadcrumb;
    },
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
      // Шум из webview-инжектов (Telegram WebApp и т.п.) — не наш код.
      /Error invoking postEvent/i,
    ],
  });
}

export { Sentry };
