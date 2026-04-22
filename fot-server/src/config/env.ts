import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ override: true });

const DEFAULT_CORS_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

// Преобразует пустые строки и undefined в undefined (для optional полей)
const optionalString = z.preprocess(v => (v === '' || v === undefined) ? undefined : v, z.string().optional());
const optionalUrl = z.preprocess(v => (v === '' || v === undefined) ? undefined : v, z.string().url().optional());

const envSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  ENCRYPTION_KEY: z.string().length(64, 'ENCRYPTION_KEY must be 64 hex characters (32 bytes)'),
  JWT_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32).optional(),
  JWT_EXPIRES_IN: z.string().default('7d'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),
  TOTP_ISSUER: z.string().default('FOT-App'),
  PORT: z.string().default('3001'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  CORS_ORIGIN: z.string().default(DEFAULT_CORS_ORIGINS.join(',')),

  // Sigur REST API — внутренний доступ (для разработки)
  SIGUR_INTERNAL_URL: optionalUrl,
  SIGUR_INTERNAL_USERNAME: optionalString,
  SIGUR_INTERNAL_PASSWORD: optionalString,

  // Sigur REST API — внешний доступ (добавится позже)
  SIGUR_EXTERNAL_URL: optionalUrl,
  SIGUR_EXTERNAL_USERNAME: optionalString,
  SIGUR_EXTERNAL_PASSWORD: optionalString,
  SIGUR_PRESENCE_POLL_INTERVAL_MS: z.string().regex(/^\d+$/).default('15000'),

  // Web Push (VAPID)
  VAPID_PUBLIC_KEY: optionalString,
  VAPID_PRIVATE_KEY: optionalString,
  VAPID_SUBJECT: optionalString,
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
