/**
 * Одноразовый скрипт: настройка CORS на S3-бакете (Cloud.ru / R2).
 * Берёт креды и эндпоинт из system_settings (БД) с фоллбэком на .env.
 * Запуск: npx tsx scripts/setup-s3-cors.ts
 */
import { PutBucketCorsCommand } from '@aws-sdk/client-s3';
import { settingsService } from '../src/services/settings.service.js';
import { createS3Client } from '../src/services/r2.service.js';

const ALLOWED_ORIGINS = [
  'https://fot.su10.ru',
  'https://fotsu10.fvds.ru',
  'http://localhost:5173',
  'http://localhost:5174',
];

const main = async (): Promise<void> => {
  const cfg = await settingsService.getR2Config();
  if (!cfg.enabled) {
    console.error('[setup-s3-cors] S3 не настроен — задайте креды через UI настроек или .env');
    process.exit(1);
  }

  const client = createS3Client(cfg);
  await client.send(new PutBucketCorsCommand({
    Bucket: cfg.bucketName,
    CORSConfiguration: {
      CORSRules: [{
        AllowedOrigins: ALLOWED_ORIGINS,
        AllowedMethods: ['PUT', 'GET', 'HEAD'],
        AllowedHeaders: ['*'],
        ExposeHeaders: ['ETag'],
        MaxAgeSeconds: 3600,
      }],
    },
  }));
  console.log(`[setup-s3-cors] CORS настроен для бакета ${cfg.bucketName}`);
  console.log(`  origins: ${ALLOWED_ORIGINS.join(', ')}`);
};

main().catch(err => {
  console.error('[setup-s3-cors] Ошибка:', err);
  process.exit(1);
});
