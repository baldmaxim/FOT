// object-map-storage.service.ts
// S3-совместимый storage для карт объектов СКУД.
//
// Замещает supabase-storage.service.ts. Работает поверх @aws-sdk/client-s3,
// поэтому совместим с Yandex Object Storage, AWS S3, MinIO и Cloudflare R2 —
// endpoint/region/forcePathStyle берутся из env.
//
// `bucketAlias` — публичный alias из кода (на сегодня единственный
// `SKUD_OBJECT_MAPS_BUCKET`). Альяс одновременно служит именем реального
// S3-бакета: операторы создают бакет с этим именем в целевом облаке.
// Никаких таблиц `storage.buckets` в БД больше не нужно — миграция
// 026_skud_object_maps.sql также очищена от этого блока.

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env.js';

export const SKUD_OBJECT_MAPS_BUCKET = 'skud-object-maps';

const ALLOWED_BUCKET_ALIASES: ReadonlySet<string> = new Set([SKUD_OBJECT_MAPS_BUCKET]);
const DEFAULT_SIGNED_URL_TTL_SECONDS = 60 * 60;

const normalizeStoragePath = (value: string): string =>
  value.replace(/^\/+/, '').trim();

interface IResolvedClient {
  client: S3Client;
  bucket: string;
}

let cachedClient: S3Client | null = null;
let cachedHash = '';

function getResolvedClient(bucketAlias: string): IResolvedClient {
  if (!ALLOWED_BUCKET_ALIASES.has(bucketAlias)) {
    throw new Error(`object-map-storage: неизвестный bucketAlias "${bucketAlias}"`);
  }

  const endpoint = env.OBJECT_STORAGE_ENDPOINT;
  const accessKeyId = env.OBJECT_STORAGE_ACCESS_KEY_ID;
  const secretAccessKey = env.OBJECT_STORAGE_SECRET_ACCESS_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error(
      'Object storage не настроен. Заполните OBJECT_STORAGE_ENDPOINT, ' +
        'OBJECT_STORAGE_ACCESS_KEY_ID, OBJECT_STORAGE_SECRET_ACCESS_KEY в .env.',
    );
  }
  const region = env.OBJECT_STORAGE_REGION || 'ru-central1';
  const forcePathStyle = (env.OBJECT_STORAGE_FORCE_PATH_STYLE || 'false').toLowerCase() === 'true';

  const hash = `${endpoint}|${region}|${accessKeyId}|${secretAccessKey}|${forcePathStyle}`;
  if (!cachedClient || hash !== cachedHash) {
    cachedClient = new S3Client({
      endpoint,
      region,
      forcePathStyle,
      credentials: { accessKeyId, secretAccessKey },
    });
    cachedHash = hash;
  }
  return { client: cachedClient, bucket: bucketAlias };
}

const isNotFoundError = (err: unknown): boolean => {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
};

export const objectMapStorageService = {
  buildObjectMapPath(objectId: string, fileName: string): string {
    const extension = path.extname(fileName || '').toLowerCase() || '.bin';
    return `travel-objects/${objectId}/${randomUUID()}${extension}`;
  },

  async createSignedUploadUrl(
    bucketAlias: string,
    storagePath: string,
  ): Promise<{ signedUrl: string; path: string; token: string }> {
    const { client, bucket } = getResolvedClient(bucketAlias);
    const Key = normalizeStoragePath(storagePath);
    const command = new PutObjectCommand({ Bucket: bucket, Key });
    const signedUrl = await getSignedUrl(client, command, { expiresIn: DEFAULT_SIGNED_URL_TTL_SECONDS });
    // token поле сохранено для контракт-совместимости со старым supabase-storage;
    // S3 presigned-URL не требует отдельного токена — клиент шлёт PUT прямо по URL.
    return { signedUrl, path: Key, token: '' };
  },

  async createSignedDownloadUrl(
    bucketAlias: string,
    storagePath: string,
    expiresIn: number = DEFAULT_SIGNED_URL_TTL_SECONDS,
  ): Promise<string> {
    const { client, bucket } = getResolvedClient(bucketAlias);
    const Key = normalizeStoragePath(storagePath);
    const command = new GetObjectCommand({ Bucket: bucket, Key });
    return getSignedUrl(client, command, { expiresIn });
  },

  async ensureObjectExists(bucketAlias: string, storagePath: string): Promise<void> {
    const { client, bucket } = getResolvedClient(bucketAlias);
    const Key = normalizeStoragePath(storagePath);
    try {
      await client.send(new HeadObjectCommand({ Bucket: bucket, Key }));
    } catch (err) {
      if (isNotFoundError(err)) {
        throw new Error('Файл карты не найден в Object Storage');
      }
      throw err;
    }
  },

  async removeObject(bucketAlias: string, storagePath: string | null | undefined): Promise<void> {
    const normalized = normalizeStoragePath(storagePath || '');
    if (!normalized) return;
    const { client, bucket } = getResolvedClient(bucketAlias);
    try {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: normalized }));
    } catch (err) {
      if (isNotFoundError(err)) return;
      throw err;
    }
  },
};
