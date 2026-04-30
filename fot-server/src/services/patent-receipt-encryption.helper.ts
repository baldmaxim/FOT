import { encryptionService } from './encryption.service.js';

const ENCRYPTED_FIELDS = [
  'payer_full_name',
  'payer_inn',
  'payer_passport',
  'payer_account',
  'payer_bank_name',
  'payer_bank_bic',
  'recipient_name',
  'recipient_inn',
  'recipient_kpp',
  'recipient_bank_name',
  'recipient_bank_bic',
  'recipient_account',
  'recipient_corr_account',
  'document_number',
  'payment_purpose',
  'patent_number',
  'uin',
] as const;

export type EncryptedField = (typeof ENCRYPTED_FIELDS)[number];

const ENC_RE = /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i;

const isEncrypted = (value: unknown): value is string =>
  typeof value === 'string' && ENC_RE.test(value);

const decryptOrPassthrough = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value as never;
  if (!isEncrypted(value)) return value;
  try {
    return encryptionService.decrypt(value);
  } catch {
    return value;
  }
};

const encryptIfPlain = (value: unknown): string | null | undefined => {
  if (value === null || value === undefined) return value as null | undefined;
  if (typeof value !== 'string') return value as never;
  if (!value) return value;
  if (isEncrypted(value)) return value;
  return encryptionService.encrypt(value);
};

export const encryptReceiptFields = <T extends Record<string, unknown>>(row: T): T => {
  const result: Record<string, unknown> = { ...row };
  for (const field of ENCRYPTED_FIELDS) {
    if (field in result) {
      result[field] = encryptIfPlain(result[field]);
    }
  }
  return result as T;
};

export const decryptReceiptRow = <T extends Record<string, unknown>>(row: T): T => {
  const result: Record<string, unknown> = { ...row };
  for (const field of ENCRYPTED_FIELDS) {
    if (field in result) {
      result[field] = decryptOrPassthrough(result[field]);
    }
  }
  return result as T;
};

export const encryptRawResponse = (json: unknown): string | null => {
  if (json === null || json === undefined) return null;
  if (typeof json === 'string' && isEncrypted(json)) return json;
  return encryptionService.encrypt(JSON.stringify(json));
};

export const decryptRawResponse = (cipher: unknown): unknown => {
  if (cipher === null || cipher === undefined) return null;
  if (typeof cipher !== 'string') return cipher;
  if (!isEncrypted(cipher)) {
    try { return JSON.parse(cipher); } catch { return cipher; }
  }
  try {
    return JSON.parse(encryptionService.decrypt(cipher));
  } catch {
    return null;
  }
};

export { ENCRYPTED_FIELDS };
