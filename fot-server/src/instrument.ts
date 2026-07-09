// ВАЖНО: этот файл должен импортироваться ПЕРВЫМ в src/index.ts —
// до любых import express/http/socket.io. Sentry для Node использует
// OpenTelemetry-инструментирование, патчит модули при загрузке.
import * as Sentry from '@sentry/node';

const dsn = process.env.SENTRY_DSN;

// Поля, которые нельзя отдавать наружу даже при `sendDefaultPii: false`,
// потому что Sentry собирает их явно через интеграции / setExtra / setContext.
const SENSITIVE_KEY_RE = /^(password|password_confirmation|new_password|current_password|totp_code|totp_secret|recovery_code|recovery_codes|token|access_token|refresh_token|api_key|secret|private_key|encryption_key|jwt_secret|cookie|authorization)$/i;
const SENSITIVE_HEADER_RE = /^(authorization|cookie|set-cookie|x-csrf-token|x-api-key|x-auth-token)$/i;

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

function scrubHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return headers;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADER_RE.test(k) ? '[Filtered]' : (Array.isArray(v) ? v.join(',') : String(v));
  }
  return out;
}

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    release: process.env.SENTRY_RELEASE,
    integrations: [],
    // Динамический семплинг спанов: держим базовые 0.03, а шумные/фоновые
    // транзакции дропаем в 0 — они переполняли квоту спанов (6.7M/5M).
    tracesSampler: (samplingContext) => {
      const name = samplingContext.name || '';
      const op = samplingContext.attributes?.['sentry.op'];
      // Health-чек и CORS-префлайты — нулевая ценность для трейсинга.
      if (/\bhealth\b/.test(name)) return 0;
      if (/^OPTIONS\b/.test(name)) return 0;
      // Высокочастотный фоновый поллинг фронта — не трейсим.
      if (/leave-requests\/pending-count|\/notifications|\/chat\b/.test(name)) return 0;
      // Фоновые cron-джобы (presence-polling, планировщики) — оставляем 1%.
      if (op === 'function') return 0.01;
      return samplingContext.inheritOrSampleWith(0.03);
    },
    sendDefaultPii: false,
    beforeSend(event) {
      // Defense-in-depth: CORS-отказ чужого Origin — это ожидаемое
      // поведение, не баг сервера. Основной фикс — callback(null, false)
      // в app.ts (не бросаем Error); этот фильтр страхует от любых
      // других путей, чтобы FOT-SERVER-3 не воскрес.
      const exc = event.exception?.values;
      if (Array.isArray(exc) && exc.some(e => typeof e?.value === 'string' && e.value.startsWith('CORS origin is not allowed'))) {
        return null;
      }
      if (event.request) {
        if (event.request.headers) {
          event.request.headers = scrubHeaders(event.request.headers);
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
  });
}

export { Sentry };
