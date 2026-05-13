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
import { settingsService } from './settings.service.js';

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

// `bucketAlias` остаётся guard'ом на стороне вызывающего кода (валидируем что
// нас не зовут с произвольным именем), но реальный bucket для STS-операций
// берём из settingsService.getR2Config() — единого источника storage-конфига
// (тот же, что для документов/чеков/пэйслипов). Это устраняет дубликат
// конфигурации `OBJECT_STORAGE_*` и автоматически подхватывает Cloud.ru/R2,
// который пользователь подключил в UI «Настройки → S3-хранилище».
// Legacy-fallback на OBJECT_STORAGE_* env оставлен на случай раннего старта
// до прогрева кэша настроек.
async function getResolvedClient(bucketAlias: string): Promise<IResolvedClient> {
  if (!ALLOWED_BUCKET_ALIASES.has(bucketAlias)) {
    throw new Error(`object-map-storage: неизвестный bucketAlias "${bucketAlias}"`);
  }

  const cfg = await settingsService.getR2Config();
  const endpoint = cfg.endpoint || env.OBJECT_STORAGE_ENDPOINT || '';
  const accessKeyId = cfg.accessKeyId || env.OBJECT_STORAGE_ACCESS_KEY_ID || '';
  const secretAccessKey = cfg.secretAccessKey || env.OBJECT_STORAGE_SECRET_ACCESS_KEY || '';
  const region = cfg.region || env.OBJECT_STORAGE_REGION || 'ru-central1';
  const forcePathStyle = cfg.forcePathStyle
    || (env.OBJECT_STORAGE_FORCE_PATH_STYLE || 'false').toLowerCase() === 'true';
  const bucket = cfg.bucketName || bucketAlias;

  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error(
      'Object storage не настроен. Заполните в UI «Настройки → S3-хранилище» ' +
        '(или OBJECT_STORAGE_ENDPOINT/ACCESS_KEY_ID/SECRET_ACCESS_KEY в .env).',
    );
  }

  const hash = `${endpoint}|${region}|${accessKeyId}|${secretAccessKey}|${forcePathStyle}|${bucket}`;
  if (!cachedClient || hash !== cachedHash) {
    cachedClient = new S3Client({
      endpoint,
      region,
      forcePathStyle,
      credentials: { accessKeyId, secretAccessKey },
    });
    cachedHash = hash;
  }
  return { client: cachedClient, bucket };
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
    const { client, bucket } = await getResolvedClient(bucketAlias);
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
    const { client, bucket } = await getResolvedClient(bucketAlias);
    const Key = normalizeStoragePath(storagePath);
    const command = new GetObjectCommand({ Bucket: bucket, Key });
    return getSignedUrl(client, command, { expiresIn });
  },

  async ensureObjectExists(bucketAlias: string, storagePath: string): Promise<void> {
    const { client, bucket } = await getResolvedClient(bucketAlias);
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
    const { client, bucket } = await getResolvedClient(bucketAlias);
    try {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: normalized }));
    } catch (err) {
      if (isNotFoundError(err)) return;
      throw err;
    }
  },
};
