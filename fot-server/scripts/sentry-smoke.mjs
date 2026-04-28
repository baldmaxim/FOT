// Одноразовый smoke-тест Sentry бэкенда. Удали после проверки.
// Запуск: node scripts/sentry-smoke.mjs
import 'dotenv/config';
import * as Sentry from '@sentry/node';

const dsn = process.env.SENTRY_DSN;
if (!dsn) {
  console.error('[sentry-smoke] SENTRY_DSN не задан в .env');
  process.exit(1);
}

Sentry.init({
  dsn,
  environment: process.env.NODE_ENV ?? 'development',
  release: process.env.SENTRY_RELEASE,
});

const id = Sentry.captureMessage('FOT Sentry smoke test (backend)', 'info');
console.log('[sentry-smoke] event id:', id);

await Sentry.flush(5000);
console.log('[sentry-smoke] flushed, ok');
