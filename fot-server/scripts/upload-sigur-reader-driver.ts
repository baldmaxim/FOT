/**
 * Заливает локальный инсталлятор Sigur Reader EH в R2 под фиксированный ключ,
 * с которого его потом отдаёт роут GET /api/downloads/sigur-reader-driver.
 *
 * Использование:
 *   cd fot-server
 *   npx tsx scripts/upload-sigur-reader-driver.ts "../Sigur Reader EH Setup 1.0.0.exe"
 *
 * R2-креды читаются из .env: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME,
 * и либо R2_ENDPOINT (полный URL), либо R2_ACCOUNT_ID (тогда endpoint строится).
 *
 * Скрипт намеренно НЕ импортирует src/config/env или src/services/* — иначе
 * подтягивается zod-валидация, требующая DATABASE_URL/JWT_SECRET/ENCRYPTION_KEY,
 * которые для одноразовой заливки в R2 не нужны.
 */
import { readFileSync, statSync } from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

dotenv.config();

const R2_KEY = 'public/downloads/sigur-reader-eh-setup-1.0.0.exe';

async function main(): Promise<void> {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Использование: npx tsx scripts/upload-sigur-reader-driver.ts <путь-к-файлу.exe>');
    process.exit(1);
  }

  const accountId = (process.env.R2_ACCOUNT_ID || '').trim();
  const accessKeyId = (process.env.R2_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || '';
  const bucketName = process.env.R2_BUCKET_NAME || 'fot-documents';
  const endpointRaw = (process.env.R2_ENDPOINT || '').trim().replace(/\/+$/, '');
  const region = (process.env.R2_REGION || 'auto').trim();
  const forcePathStyle = (process.env.R2_FORCE_PATH_STYLE || '') === 'true';

  if (!accessKeyId || !secretAccessKey) {
    console.error('R2 не настроен: задайте R2_ACCESS_KEY_ID и R2_SECRET_ACCESS_KEY в .env');
    process.exit(1);
  }
  if (!endpointRaw && !accountId) {
    console.error('R2 не настроен: задайте R2_ENDPOINT или R2_ACCOUNT_ID в .env');
    process.exit(1);
  }

  const endpoint = endpointRaw
    ? (/^https?:\/\//i.test(endpointRaw) ? endpointRaw : `https://${endpointRaw}`)
    : `https://${accountId}.r2.cloudflarestorage.com`;

  const absPath = path.resolve(filePath);
  const stat = statSync(absPath);
  console.log(`Файл:     ${absPath}`);
  console.log(`Размер:   ${(stat.size / 1024 / 1024).toFixed(2)} МБ`);
  console.log(`Endpoint: ${endpoint}`);
  console.log(`Бакет:    ${bucketName}`);
  console.log(`Ключ:     ${R2_KEY}`);

  const client = new S3Client({
    region,
    endpoint,
    forcePathStyle,
    credentials: { accessKeyId, secretAccessKey },
  });

  const buffer = readFileSync(absPath);
  console.log('Заливаю...');
  await client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: R2_KEY,
    Body: buffer,
    ContentType: 'application/octet-stream',
  }));
  console.log('Готово.');
}

main().catch(err => {
  console.error('Ошибка:', err);
  process.exit(1);
});
