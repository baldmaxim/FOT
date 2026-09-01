/**
 * Шифрование кадрового модуля («Реквизиты»). Порт схемы PassDesk
 * (encryptionService.js + fileEncryptionService.js):
 *   - поля: AES-256-GCM с версией ключа, формат "v1:<iv b64>:<tag b64>:<ct b64>";
 *   - поисковые хэши: HMAC-SHA-256 с отдельным pepper по нормализованному значению;
 *   - файлы: AES-256-GCM, iv/tag в метаданных documents, AAD = "doc:<id>".
 *
 * Существующий encryption.service (SHA-256 без pepper, один ключ без версии) для
 * HR-данных не используется.
 *
 * Ключи по умолчанию НЕ требуют отдельных переменных: ключ версии `v0` и pepper
 * выводятся HKDF-SHA256 из платформенного ENCRYPTION_KEY (тот же, что шифрует TOTP,
 * чат и поля распознанных чеков) — модуль работает сразу после деплоя, а pepper
 * остаётся секретным (голый SHA-256 от 10-значного номера паспорта перебирается).
 *
 * Отдельный ключ HR — опция: задать HR_FIELD_ENCRYPTION_KEYS="v1:<64 hex>[,v2:…]" и
 * HR_FIELD_ENCRYPTION_ACTIVE_KEY_VERSION=v1. Производный `v0` при этом остаётся в
 * карте ключей, поэтому записи, зашифрованные до перехода, продолжают читаться.
 * HR_FIELD_HASH_PEPPER тоже переопределяется, но его смена инвалидирует поисковые
 * хэши (*_hash) — потребуется разовый пересчёт.
 */
import crypto from 'crypto';
import { env } from '../config/env.js';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const MIN_PEPPER_LENGTH = 32;
/** Версия ключа, выведенного из ENCRYPTION_KEY (используется, пока не задан явный HR-ключ). */
const DERIVED_KEY_VERSION = 'v0';
const HKDF_SALT = 'fot-hr';

export type HrHashField = 'snils' | 'inn' | 'passport' | 'kig' | 'patent' | 'name';

interface IKeyConfig {
  keys: Map<string, Buffer>;
  activeVersion: string;
  pepper: string;
}

let cached: IKeyConfig | null | undefined;

const parseKeys = (raw: string): Map<string, Buffer> => {
  const map = new Map<string, Buffer>();
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(':');
    if (idx <= 0) throw new Error('HR_FIELD_ENCRYPTION_KEYS: ожидается формат "v1:<hex>,v2:<hex>"');
    const version = trimmed.slice(0, idx).trim();
    const hex = trimmed.slice(idx + 1).trim();
    const key = Buffer.from(hex, 'hex');
    if (key.length !== 32) throw new Error(`HR_FIELD_ENCRYPTION_KEYS: ключ ${version} должен быть 32 байта (64 hex)`);
    if (!/^[A-Za-z0-9_-]{1,16}$/.test(version)) throw new Error(`HR_FIELD_ENCRYPTION_KEYS: некорректная версия "${version}"`);
    map.set(version, key);
  }
  if (map.size === 0) throw new Error('HR_FIELD_ENCRYPTION_KEYS пуст');
  return map;
};

/** Производный секрет из платформенного ENCRYPTION_KEY (HKDF-SHA256, разные info → независимые ключи). */
const derive = (info: string, bytes = 32): Buffer =>
  Buffer.from(crypto.hkdfSync('sha256', Buffer.from(env.ENCRYPTION_KEY, 'hex'), HKDF_SALT, info, bytes));

const loadConfig = (): IKeyConfig | null => {
  if (cached !== undefined) return cached;
  const rawKeys = env.HR_FIELD_ENCRYPTION_KEYS;
  const activeVersion = env.HR_FIELD_ENCRYPTION_ACTIVE_KEY_VERSION;
  const pepper = env.HR_FIELD_HASH_PEPPER;

  // v0 в карте всегда: и как дефолт, и чтобы после перехода на явный ключ читались старые записи.
  const keys = new Map<string, Buffer>([[DERIVED_KEY_VERSION, derive('hr-field-encryption-v1')]]);
  if (rawKeys) {
    for (const [version, key] of parseKeys(rawKeys)) keys.set(version, key);
  }

  const resolvedVersion = activeVersion || (rawKeys ? '' : DERIVED_KEY_VERSION);
  if (!resolvedVersion) throw new Error('Задан HR_FIELD_ENCRYPTION_KEYS, но не задан HR_FIELD_ENCRYPTION_ACTIVE_KEY_VERSION');
  if (!keys.has(resolvedVersion)) {
    throw new Error(`HR_FIELD_ENCRYPTION_ACTIVE_KEY_VERSION=${resolvedVersion} отсутствует в HR_FIELD_ENCRYPTION_KEYS`);
  }

  if (pepper && pepper.length < MIN_PEPPER_LENGTH) {
    throw new Error(`HR_FIELD_HASH_PEPPER должен быть не короче ${MIN_PEPPER_LENGTH} символов`);
  }
  cached = {
    keys,
    activeVersion: resolvedVersion,
    pepper: pepper || derive('hr-search-pepper-v1').toString('hex'),
  };
  return cached;
};

const requireConfig = (): IKeyConfig => {
  const cfg = loadConfig();
  if (!cfg) throw new Error('HR-шифрование не настроено (HR_FIELD_ENCRYPTION_KEYS / ACTIVE_KEY_VERSION / HASH_PEPPER)');
  return cfg;
};

/** Сбросить кэш конфигурации (тесты, ротация ключей). */
export const resetHrCryptoCache = (): void => {
  cached = undefined;
};

export const isHrCryptoConfigured = (): boolean => loadConfig() !== null;

export const getActiveHrKeyVersion = (): string => requireConfig().activeVersion;

// ─── Нормализация значений для хэшей ────────────────────────────────────────

const LOOKALIKE_CYRILLIC_TO_LATIN: Record<string, string> = {
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', У: 'Y', Х: 'X',
};

/** Номер документа: upper, кириллические двойники → латиница, только A-Z0-9. */
export const normalizeDocNumber = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  const normalized = String(value)
    .normalize('NFKC')
    .trim()
    .toUpperCase()
    .replace(/[АВЕКМНОРСТУХ]/g, ch => LOOKALIKE_CYRILLIC_TO_LATIN[ch] ?? ch)
    .replace(/[^A-Z0-9]/g, '');
  return normalized || null;
};

export const normalizeDigits = (value: string | null | undefined, maxLength = 64): string | null => {
  if (value === null || value === undefined) return null;
  const digits = String(value).replace(/\D/g, '').slice(0, maxLength);
  return digits || null;
};

export const normalizeNameForHash = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const normalized = String(value).normalize('NFKC').trim().replace(/\s+/g, ' ').replace(/ё/gi, 'е').toLowerCase();
  return normalized || null;
};

const normalizeByField = (field: HrHashField, value: string | null | undefined): string | null => {
  switch (field) {
    case 'snils': return normalizeDigits(value, 11);
    case 'inn': return normalizeDigits(value, 12);
    case 'name': return normalizeNameForHash(value);
    default: return normalizeDocNumber(value);
  }
};

/** HMAC-SHA-256(pepper, field|normalized). null — если значение пустое. */
export const hashForSearch = (field: HrHashField, value: string | null | undefined): string | null => {
  const normalized = normalizeByField(field, value);
  if (!normalized) return null;
  const { pepper } = requireConfig();
  return crypto.createHmac('sha256', pepper).update(`${field}|${normalized}`).digest('hex');
};

// ─── Поля ───────────────────────────────────────────────────────────────────

/** Шифрует строку; пустое значение → null. Возвращает { enc, keyVersion }. */
export const encryptField = (value: string | null | undefined): { enc: string | null; keyVersion: string | null } => {
  if (value === null || value === undefined) return { enc: null, keyVersion: null };
  const text = String(value);
  if (!text) return { enc: null, keyVersion: null };
  const cfg = requireConfig();
  const key = cfg.keys.get(cfg.activeVersion)!;
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    enc: `${cfg.activeVersion}:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`,
    keyVersion: cfg.activeVersion,
  };
};

export const decryptField = (enc: string | null | undefined): string | null => {
  if (!enc) return null;
  const parts = enc.split(':');
  if (parts.length !== 4) throw new Error('Некорректный формат зашифрованного поля');
  const [version, ivB64, tagB64, ctB64] = parts;
  const cfg = requireConfig();
  const key = cfg.keys.get(version);
  if (!key) throw new Error(`Неизвестная версия ключа шифрования: ${version}`);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
};

/** Безопасная расшифровка: ошибка → null (и лог без значения). */
export const decryptFieldSafe = (enc: string | null | undefined): string | null => {
  try {
    return decryptField(enc);
  } catch (err) {
    console.error('[hr-crypto] decrypt failed:', err instanceof Error ? err.message : err);
    return null;
  }
};

export const encryptJson = (value: unknown): { enc: string | null; keyVersion: string | null } =>
  encryptField(value === undefined ? null : JSON.stringify(value));

export const decryptJson = <T = unknown>(enc: string | null | undefined): T | null => {
  const text = decryptFieldSafe(enc);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
};

/** Маска для UI без права раскрытия: последние 4 символа. */
export const maskValue = (value: string | null | undefined, visibleTail = 4): string | null => {
  if (!value) return null;
  const s = String(value);
  if (s.length <= visibleTail) return '•'.repeat(s.length);
  return `${'•'.repeat(Math.max(4, s.length - visibleTail))}${s.slice(-visibleTail)}`;
};

// ─── Файлы ──────────────────────────────────────────────────────────────────

export interface IFileEncryptionMeta {
  algorithm: string;
  iv: string;
  tag: string;
  keyVersion: string;
}

const fileAad = (documentId: number | string): Buffer => Buffer.from(`doc:${documentId}`, 'utf8');

export const encryptFileBuffer = (plain: Buffer, documentId: number | string): { buffer: Buffer; meta: IFileEncryptionMeta } => {
  const cfg = requireConfig();
  const key = cfg.keys.get(cfg.activeVersion)!;
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(fileAad(documentId));
  const buffer = Buffer.concat([cipher.update(plain), cipher.final()]);
  return {
    buffer,
    meta: {
      algorithm: ALGORITHM,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      keyVersion: cfg.activeVersion,
    },
  };
};

export const decryptFileBuffer = (encrypted: Buffer, documentId: number | string, meta: IFileEncryptionMeta): Buffer => {
  if (meta.algorithm !== ALGORITHM) throw new Error('Неподдерживаемый алгоритм шифрования файла');
  const cfg = requireConfig();
  const key = cfg.keys.get(meta.keyVersion);
  if (!key) throw new Error(`Неизвестная версия ключа файла: ${meta.keyVersion}`);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(meta.iv, 'base64'));
  decipher.setAAD(fileAad(documentId));
  decipher.setAuthTag(Buffer.from(meta.tag, 'base64'));
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
};

export const sha256Hex = (buffer: Buffer): string => crypto.createHash('sha256').update(buffer).digest('hex');

/** Генерация ключа для .env (64 hex). */
export const generateHrKey = (): string => crypto.randomBytes(32).toString('hex');
