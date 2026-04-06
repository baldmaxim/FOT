import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { r2Client as staticClient, R2_BUCKET_NAME as staticBucket, r2Enabled as staticEnabled } from '../config/r2.js';
import { settingsService } from './settings.service.js';
import { randomUUID } from 'crypto';
import path from 'path';

const URL_EXPIRY = 3600; // 1 час

// Динамический клиент из БД (кэшируется)
let dynamicClient: S3Client | null = null;
let dynamicBucket: string = '';
let dynamicConfigHash: string = '';

const getR2 = async (): Promise<{ client: S3Client | null; bucket: string; enabled: boolean }> => {
  // Сначала пробуем статический конфиг (.env)
  if (staticEnabled && staticClient) {
    return { client: staticClient, bucket: staticBucket, enabled: true };
  }

  // Иначе пробуем из БД
  const cfg = await settingsService.getR2Config();
  if (!cfg.enabled) {
    return { client: null, bucket: '', enabled: false };
  }

  // Пересоздаём клиент только если конфиг изменился
  const hash = `${cfg.accountId}:${cfg.accessKeyId}:${cfg.secretAccessKey}`;
  if (hash !== dynamicConfigHash) {
    dynamicClient = new S3Client({
      region: 'auto',
      endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
    });
    dynamicBucket = cfg.bucketName;
    dynamicConfigHash = hash;
  }

  return { client: dynamicClient, bucket: dynamicBucket, enabled: true };
};

export const r2Service = {
  isEnabled: () => staticEnabled,

  /** Async проверка (включая БД) */
  isEnabledAsync: async (): Promise<boolean> => {
    const { enabled } = await getR2();
    return enabled;
  },

  generateKey: (employeeId: number | string, fileName: string): string => {
    const ext = path.extname(fileName) || '.bin';
    return `documents/${employeeId}/${randomUUID()}${ext}`;
  },

  generateUploadUrl: async (key: string, contentType: string): Promise<string> => {
    const { client, bucket } = await getR2();
    if (!client) throw new Error('R2 не настроен');
    const command = new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType });
    return getSignedUrl(client, command, { expiresIn: URL_EXPIRY });
  },

  generateDownloadUrl: async (key: string): Promise<string> => {
    const { client, bucket } = await getR2();
    if (!client) throw new Error('R2 не настроен');
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    return getSignedUrl(client, command, { expiresIn: URL_EXPIRY });
  },

  deleteObject: async (key: string): Promise<void> => {
    const { client, bucket } = await getR2();
    if (!client) throw new Error('R2 не настроен');
    const command = new DeleteObjectCommand({ Bucket: bucket, Key: key });
    await client.send(command);
  },
};
