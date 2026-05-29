import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import type { PutObjectCommandInput } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { settingsService } from './settings.service.js';
import { randomUUID } from 'crypto';
import path from 'path';

const URL_EXPIRY = 3600;

let cachedClient: S3Client | null = null;
let cachedBucket: string = '';
let cachedKmsKeyId: string = '';
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
  kmsKeyId?: string;
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

const getR2 = async (): Promise<{ client: S3Client | null; bucket: string; kmsKeyId: string; enabled: boolean }> => {
  const cfg = await settingsService.getR2Config();
  if (!cfg.enabled) {
    return { client: null, bucket: '', kmsKeyId: '', enabled: false };
  }

  const hash = `${cfg.accountId}:${cfg.accessKeyId}:${cfg.secretAccessKey}:${cfg.bucketName}:${cfg.endpoint}:${cfg.region}:${cfg.forcePathStyle}:${cfg.kmsKeyId}`;
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
    cachedKmsKeyId = cfg.kmsKeyId;
    cachedHash = hash;
  }

  return { client: cachedClient, bucket: cachedBucket, kmsKeyId: cachedKmsKeyId, enabled: true };
};

export const r2Service = {
  invalidateCachedConfig: (): void => {
    cachedClient = null;
    cachedBucket = '';
    cachedKmsKeyId = '';
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

  generateUploadUrl: async (key: string, contentType: string): Promise<{ url: string; headers: Record<string, string> }> => {
    const { client, bucket, kmsKeyId } = await getR2();
    if (!client) throw new Error('R2 не настроен');

    const putInput: PutObjectCommandInput = { Bucket: bucket, Key: key, ContentType: contentType };
    const headers: Record<string, string> = {};
    const unhoistableHeaders = new Set<string>();

    if (kmsKeyId) {
      putInput.ServerSideEncryption = 'aws:kms';
      putInput.SSEKMSKeyId = kmsKeyId;
      headers['x-amz-server-side-encryption'] = 'aws:kms';
      headers['x-amz-server-side-encryption-aws-kms-key-id'] = kmsKeyId;
      unhoistableHeaders.add('x-amz-server-side-encryption');
      unhoistableHeaders.add('x-amz-server-side-encryption-aws-kms-key-id');
    }

    const command = new PutObjectCommand(putInput);
    const url = await getSignedUrl(client, command, { expiresIn: URL_EXPIRY, unhoistableHeaders });
    return { url, headers };
  },

  uploadObject: async (key: string, body: Buffer, contentType: string): Promise<void> => {
    const { client, bucket, kmsKeyId } = await getR2();
    if (!client) throw new Error('R2 не настроен');
    const input: PutObjectCommandInput = { Bucket: bucket, Key: key, Body: body, ContentType: contentType };
    if (kmsKeyId) {
      input.ServerSideEncryption = 'aws:kms';
      input.SSEKMSKeyId = kmsKeyId;
    }
    await client.send(new PutObjectCommand(input));
  },

  generateDownloadUrl: async (
    key: string,
    fileName?: string,
    disposition: 'inline' | 'attachment' = 'attachment',
  ): Promise<string> => {
    const { client, bucket } = await getR2();
    if (!client) throw new Error('R2 не настроен');
    // R2/S3 принимают в headers только ASCII. Браузер при сохранении уважает
    // именно ResponseContentDisposition (атрибут <a download> для
    // кросс-доменных URL игнорируется). Формируем по RFC 5987:
    //   filename="ASCII-fallback"; filename*=UTF-8''<percent-encoded UTF-8>
    // disposition=inline нужен для предпросмотра (img/iframe), attachment — для скачивания.
    let responseContentDisposition: string | undefined;
    if (fileName) {
      const asciiFallback = fileName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
      const utf8Encoded = encodeURIComponent(fileName).replace(/['()]/g, escape);
      responseContentDisposition = `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${utf8Encoded}`;
    } else if (disposition === 'inline') {
      responseContentDisposition = 'inline';
    }
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ResponseContentDisposition: responseContentDisposition,
    });
    return getSignedUrl(client, command, { expiresIn: URL_EXPIRY });
  },

  deleteObject: async (key: string): Promise<void> => {
    const { client, bucket } = await getR2();
    if (!client) throw new Error('R2 не настроен');
    const command = new DeleteObjectCommand({ Bucket: bucket, Key: key });
    await client.send(command);
  },
};
