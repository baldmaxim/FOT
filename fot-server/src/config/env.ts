import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ override: true });

// Преобразует пустые строки и undefined в undefined (для optional полей)
const optionalString = z.preprocess(v => (v === '' || v === undefined) ? undefined : v, z.string().optional());
const optionalUrl = z.preprocess(v => (v === '' || v === undefined) ? undefined : v, z.string().url().optional());

const envSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  ENCRYPTION_KEY: z.string().length(64, 'ENCRYPTION_KEY must be 64 hex characters (32 bytes)'),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('7d'),
  TOTP_ISSUER: z.string().default('FOT-App'),
  PORT: z.string().default('3000'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  // Sigur REST API — внутренний доступ (для разработки)
  SIGUR_INTERNAL_URL: optionalUrl,
  SIGUR_INTERNAL_USERNAME: optionalString,
  SIGUR_INTERNAL_PASSWORD: optionalString,

  // Sigur REST API — внешний доступ (добавится позже)
  SIGUR_EXTERNAL_URL: optionalUrl,
  SIGUR_EXTERNAL_USERNAME: optionalString,
  SIGUR_EXTERNAL_PASSWORD: optionalString,

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
