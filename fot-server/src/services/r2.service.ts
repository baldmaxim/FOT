import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { settingsService } from './settings.service.js';
import { randomUUID } from 'crypto';
import path from 'path';

const URL_EXPIRY = 3600;

let cachedClient: S3Client | null = null;
let cachedBucket: string = '';
let cachedHash: string = '';

export const sanitizeS3Value = (raw: string): string => raw.trim();

export const sanitizeS3Endpoint = (raw: string): string => {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
};

export type S3ClientConfig = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  region: string;
  forcePathStyle: boolean;
};

export const buildS3Endpoint = (cfg: Pick<S3ClientConfig, 'accountId' | 'endpoint'>): string => {
  if (cfg.endpoint) return cfg.endpoint;
  return `https://${cfg.accountId}.r2.cloudflarestorage.com`;
};

export const createS3Client = (cfg: S3ClientConfig): S3Client => new S3Client({
  region: cfg.region || 'auto',
  endpoint: buildS3Endpoint(cfg),
  forcePathStyle: cfg.forcePathStyle,
  credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
});

const getR2 = async (): Promise<{ client: S3Client | null; bucket: string; enabled: boolean }> => {
  const cfg = await settingsService.getR2Config();
  if (!cfg.enabled) {
    return { client: null, bucket: '', enabled: false };
  }

  const hash = `${cfg.accountId}:${cfg.accessKeyId}:${cfg.secretAccessKey}:${cfg.bucketName}:${cfg.endpoint}:${cfg.region}:${cfg.forcePathStyle}`;
  if (hash !== cachedHash) {
    cachedClient = createS3Client({
      accountId: cfg.accountId,
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      endpoint: cfg.endpoint,
      region: cfg.region,
      forcePathStyle: cfg.forcePathStyle,
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
