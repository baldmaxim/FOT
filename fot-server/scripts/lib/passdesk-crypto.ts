/**
 * Расшифровка данных PassDesk при переносе (порт server/src/services/encryptionService.js
 * и fileEncryptionService.js). Ключи PassDesk передаются только в env процесса скрипта:
 *   PASSDESK_FIELD_ENCRYPTION_KEYS  — JSON {"v1":"<base64 32 bytes>", ...}
 *   PASSDESK_FILE_ENCRYPTION_KEYS   — JSON, по умолчанию = FIELD keys
 * Никаких PassDesk-ключей в FOT-конфигурации не остаётся.
 */
import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const LABEL = 'AES-256-GCM';

const parseKeys = (raw: string | undefined, name: string): Map<string, Buffer> => {
  if (!raw) throw new Error(`${name} не задан`);
  const parsed = JSON.parse(raw) as Record<string, string>;
  const map = new Map<string, Buffer>();
  for (const [version, b64] of Object.entries(parsed)) {
    const key = Buffer.from(String(b64), 'base64');
    if (key.length !== 32) throw new Error(`${name}: ключ ${version} должен быть 32 байта`);
    map.set(version, key);
  }
  if (map.size === 0) throw new Error(`${name} пуст`);
  return map;
};

let fieldKeys: Map<string, Buffer> | null = null;
let fileKeys: Map<string, Buffer> | null = null;

const getFieldKeys = (): Map<string, Buffer> => (fieldKeys ??= parseKeys(process.env.PASSDESK_FIELD_ENCRYPTION_KEYS, 'PASSDESK_FIELD_ENCRYPTION_KEYS'));
const getFileKeys = (): Map<string, Buffer> =>
  (fileKeys ??= parseKeys(process.env.PASSDESK_FILE_ENCRYPTION_KEYS || process.env.PASSDESK_FIELD_ENCRYPTION_KEYS, 'PASSDESK_FILE_ENCRYPTION_KEYS'));

export const isPassdeskCryptoConfigured = (): boolean => !!process.env.PASSDESK_FIELD_ENCRYPTION_KEYS;

/** Поле: envelope JSON {alg, iv, tag, ct} (base64) + версия ключа из соседней колонки. */
export const decryptPassdeskField = (payload: string | null | undefined, keyVersion: string | null | undefined): string | null => {
  if (!payload) return null;
  if (!keyVersion) throw new Error('keyVersion обязателен для расшифровки поля PassDesk');
  const key = getFieldKeys().get(keyVersion);
  if (!key) throw new Error(`Нет ключа PassDesk версии ${keyVersion}`);
  const env = JSON.parse(payload) as { alg: string; iv: string; tag: string; ct: string };
  if (env.alg !== LABEL) throw new Error('Неподдерживаемый алгоритм поля PassDesk');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(env.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(env.ct, 'base64')), decipher.final()]).toString('utf8');
};

export interface IPassdeskFileMeta {
  is_encrypted: boolean;
  encryption_algorithm: string | null;
  encryption_iv: string | null;
  encryption_tag: string | null;
  encryption_key_version: string | null;
  document_type: string | null;
}

/** Файл: AES-256-GCM, AAD = "docType:<document_type>", iv/tag base64. Незашифрованный → как есть. */
export const decryptPassdeskFile = (bytes: Buffer, meta: IPassdeskFileMeta): Buffer => {
  if (!meta.is_encrypted) return bytes;
  if (meta.encryption_algorithm !== ALGORITHM) throw new Error('Неподдерживаемый алгоритм файла PassDesk');
  if (!meta.encryption_key_version || !meta.encryption_iv || !meta.encryption_tag) throw new Error('Неполные метаданные шифрования файла PassDesk');
  const key = getFileKeys().get(meta.encryption_key_version);
  if (!key) throw new Error(`Нет файлового ключа PassDesk версии ${meta.encryption_key_version}`);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(meta.encryption_iv, 'base64'));
  decipher.setAAD(Buffer.from(`docType:${meta.document_type || 'unknown'}`, 'utf8'));
  decipher.setAuthTag(Buffer.from(meta.encryption_tag, 'base64'));
  return Buffer.concat([decipher.update(bytes), decipher.final()]);
};
