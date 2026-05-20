import dotenv from 'dotenv';
import { z } from 'zod';

// В тестах НЕ перетираем заглушки из __tests__/setup.ts реальным .env
// (иначе DATABASE_SSL_CA_PATH из .env ломает buildSsl с ENOENT).
dotenv.config({ override: process.env.NODE_ENV !== 'test' });

const DEFAULT_CORS_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

// Преобразует пустые строки и undefined в undefined (для optional полей)
const optionalString = z.preprocess(v => (v === '' || v === undefined) ? undefined : v, z.string().optional());
const optionalUrl = z.preprocess(v => (v === '' || v === undefined) ? undefined : v, z.string().url().optional());

const envSchema = z.object({
  ENCRYPTION_KEY: z.string().length(64, 'ENCRYPTION_KEY must be 64 hex characters (32 bytes)'),
  JWT_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32).optional(),
  JWT_EXPIRES_IN: z.string().default('7d'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),
  TOTP_ISSUER: z.string().default('FOT-App'),
  PORT: z.string().default('3001'),
  // На проде nginx проксирует на loopback, поэтому Node должен слушать только
  // 127.0.0.1 — чтобы публичный :PORT не висел голым на интернете в обход nginx
  // и rate-limit'ов. В dev оставляем '0.0.0.0' через .env, если нужно открыть
  // dev-сервер другим устройствам (телефон в той же Wi-Fi).
  HOST: z.string().default('127.0.0.1'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  CORS_ORIGIN: z.string().default(DEFAULT_CORS_ORIGINS.join(',')),

  // Базовый URL фронтенда (например https://fot.su10.ru). Используется в
  // ссылках исходящих писем (например /reset-password). Если не задан —
  // forgotPassword падает обратно на захардкоженный production-домен.
  APP_URL: optionalUrl,

  // Sigur REST API — внутренний доступ (для разработки)
  SIGUR_INTERNAL_URL: optionalUrl,
  SIGUR_INTERNAL_USERNAME: optionalString,
  SIGUR_INTERNAL_PASSWORD: optionalString,

  // Sigur REST API — внешний доступ (добавится позже)
  SIGUR_EXTERNAL_URL: optionalUrl,
  SIGUR_EXTERNAL_USERNAME: optionalString,
  SIGUR_EXTERNAL_PASSWORD: optionalString,
  SIGUR_PRESENCE_POLL_INTERVAL_MS: z.string().regex(/^\d+$/).default('5000'),
  SIGUR_EVENTS_DAILY_TARGET_HOUR_MSK: z.string().regex(/^\d+$/).default('3'),
  SIGUR_EVENTS_DAILY_WINDOW_DAYS: z.string().regex(/^\d+$/).default('2'),
  SIGUR_STRUCTURE_SYNC_INTERVAL_MS: z.string().regex(/^\d+$/).default('1800000'),
  SIGUR_BULK_TIMEOUT_MS: z.string().regex(/^\d+$/).default('60000'),
  SIGUR_EVENT_CHUNK_MS: z.string().regex(/^\d+$/).default('1800000'),
  SIGUR_EVENT_PAGE_SIZE: z.string().regex(/^\d+$/).default('1000'),
  SIGUR_EVENT_CHUNK_PARALLELISM: z.string().regex(/^\d+$/).default('3'),

  // МТС «Мобильные сотрудники» (M-Poisk) — отдельный модуль геолокации.
  // Значения добавляет пользователь вручную в .env или в системные настройки.
  MTS_API_BASE_URL: optionalUrl,
  MTS_API_TOKEN: optionalString,
  // Часовой такт для фонового поллера МТС lastLocations (бесплатный API,
  // активной trigger-схемой не пользуемся — она платная и идёт через UI вручную).
  MTS_SYNC_INTERVAL_MS: z.string().regex(/^\d+$/).default('3600000'),

  // Web Push (VAPID)
  VAPID_PUBLIC_KEY: optionalString,
  VAPID_PRIVATE_KEY: optionalString,
  VAPID_SUBJECT: optionalString,

  // Sentry (sentry.io). Все опциональны: без DSN SDK молчит,
  // без AUTH_TOKEN/ORG sourcemaps не загружаются.
  SENTRY_DSN: optionalUrl,
  SENTRY_RELEASE: optionalString,
  SENTRY_AUTH_TOKEN: optionalString,
  SENTRY_ORG: optionalString,
  SENTRY_PROJECT: optionalString,

  // PostgreSQL (прямое подключение через pg-Pool)
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.string().regex(/^\d+$/).default('10'),
  DATABASE_STATEMENT_TIMEOUT_MS: z.string().regex(/^\d+$/).default('30000'),
  DATABASE_SSL: z.string().default('true'),
  DATABASE_SSL_CA_PATH: optionalString,

  // Object Storage (S3-compatible — Cloudflare R2 / Yandex Object Storage)
  OBJECT_STORAGE_ENDPOINT: optionalString,
  OBJECT_STORAGE_ACCESS_KEY_ID: optionalString,
  OBJECT_STORAGE_SECRET_ACCESS_KEY: optionalString,
  OBJECT_STORAGE_REGION: z.string().default('auto'),
  OBJECT_STORAGE_FORCE_PATH_STYLE: z.string().default('false'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:');
  console.error(parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;

if (!env.JWT_REFRESH_SECRET) {
  env.JWT_REFRESH_SECRET = env.JWT_SECRET;
}

function getCorsAllowedOrigins(): string[] {
  const baseOrigins = env.CORS_ORIGIN
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);

  const expandedOrigins = new Set(baseOrigins);

  if (env.NODE_ENV === 'development') {
    for (const origin of baseOrigins) {
      try {
        const url = new URL(origin);
        if (url.hostname === 'localhost') {
          expandedOrigins.add(`${url.protocol}//127.0.0.1${url.port ? `:${url.port}` : ''}`);
        } else if (url.hostname === '127.0.0.1') {
          expandedOrigins.add(`${url.protocol}//localhost${url.port ? `:${url.port}` : ''}`);
        }
      } catch {
        // Ignore malformed origins in expansion step; zod already validates presence as string.
      }
    }
  }

  return [...expandedOrigins];
}

export const corsAllowedOrigins = getCorsAllowedOrigins();
