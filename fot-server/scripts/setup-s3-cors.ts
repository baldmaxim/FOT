/**
 * Настройка CORS на S3-бакете (Cloud.ru / Cloudflare R2 / другой S3-совместимый).
 *
 * Запуск:
 *   npx tsx scripts/setup-s3-cors.ts
 *
 * Источники AllowedOrigins (объединяются, дубли убираются):
 *   1. env `OBJECT_STORAGE_CORS_ORIGINS` — CSV, например:
 *        OBJECT_STORAGE_CORS_ORIGINS="https://fot.example.ru,https://staging.example.ru"
 *   2. встроенный fallback (исторические домены + локальные dev-порты).
 *
 * AllowedHeaders:
 *   - если в конфиге задан KMS-ключ — кладём явный список с `x-amz-server-side-encryption*`,
 *     потому что некоторые S3-совместимые провайдеры (Cloud.ru и др.) непредсказуемо
 *     обрабатывают wildcard `*` для preflight non-simple headers;
 *   - иначе — `*`.
 */
import { PutBucketCorsCommand } from '@aws-sdk/client-s3';
import { settingsService } from '../src/services/settings.service.js';
import { createS3Client } from '../src/services/r2.service.js';

const FALLBACK_ORIGINS = [
  'https://fot.su10.ru',
  'https://fotsu10.fvds.ru',
  'http://localhost:5173',
  'http://localhost:5174',
];

const KMS_HEADERS = [
  'Content-Type',
  'Content-MD5',
  'Authorization',
  'x-amz-date',
  'x-amz-content-sha256',
  'x-amz-server-side-encryption',
  'x-amz-server-side-encryption-aws-kms-key-id',
  'x-amz-server-side-encryption-context',
];

const parseOriginsEnv = (raw: string | undefined): string[] => {
  if (!raw) return [];
  return raw
    .split(',')
    .map(s => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
};

const buildAllowedOrigins = (): string[] => {
  const fromEnv = parseOriginsEnv(process.env.OBJECT_STORAGE_CORS_ORIGINS);
  const merged = [...fromEnv, ...FALLBACK_ORIGINS];
  return Array.from(new Set(merged));
};

const main = async (): Promise<void> => {
  const cfg = await settingsService.getR2Config();
  if (!cfg.enabled) {
    console.error('[setup-s3-cors] S3 не настроен — задайте креды через UI настроек или .env');
    process.exit(1);
  }

  const allowedOrigins = buildAllowedOrigins();
  const allowedHeaders = cfg.kmsKeyId ? KMS_HEADERS : ['*'];

  console.log('[setup-s3-cors] Применяю CORS:');
  console.log(`  bucket:    ${cfg.bucketName}`);
  console.log(`  endpoint:  ${cfg.endpoint || `<account>.r2.cloudflarestorage.com (${cfg.accountId})`}`);
  console.log(`  kms:       ${cfg.kmsKeyId ? 'on (явный список headers)' : 'off (AllowedHeaders=*)'}`);
  console.log(`  origins:   ${allowedOrigins.join(', ')}`);

  const client = createS3Client(cfg);
  await client.send(new PutBucketCorsCommand({
    Bucket: cfg.bucketName,
    CORSConfiguration: {
      CORSRules: [{
        AllowedOrigins: allowedOrigins,
        AllowedMethods: ['PUT', 'GET', 'HEAD', 'POST', 'DELETE'],
        AllowedHeaders: allowedHeaders,
        ExposeHeaders: ['ETag'],
        MaxAgeSeconds: 3600,
      }],
    },
  }));
  console.log(`[setup-s3-cors] CORS успешно применён.`);
};

main().catch(err => {
  console.error('[setup-s3-cors] Ошибка:', err);
  process.exit(1);
});
