import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { settingsService } from './settings.service.js';
import { randomUUID } from 'crypto';
import path from 'path';

const URL_EXPIRY = 3600;

let cachedClient: S3Client | null = null;
let cachedBucket: string = '';
let cachedHash: string = '';

const getR2 = async (): Promise<{ client: S3Client | null; bucket: string; enabled: boolean }> => {
  const cfg = await settingsService.getR2Config();
  if (!cfg.enabled) {
    return { client: null, bucket: '', enabled: false };
  }

  const hash = `${cfg.accountId}:${cfg.accessKeyId}:${cfg.secretAccessKey}:${cfg.bucketName}`;
  if (hash !== cachedHash) {
    cachedClient = new S3Client({
      region: 'auto',
      endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
    });
    cachedBucket = cfg.bucketName;
    cachedHash = hash;
  }

  return { client: cachedClient, bucket: cachedBucket, enabled: true };
};

export const r2Service = {
  invalidateCachedConfig: (): void => {
    cachedClient = null;
    cachedBucket = '';
    cachedHash = '';
  },

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
