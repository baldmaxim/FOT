import crypto from 'crypto';
import { env } from '../config/env.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

// Ключ 32 байта (256 бит) из hex строки
const KEY = Buffer.from(env.ENCRYPTION_KEY, 'hex');

if (KEY.length !== 32) {
  throw new Error('ENCRYPTION_KEY must be 32 bytes (64 hex characters)');
}

export const encryptionService = {
  /**
   * Шифрует текст с использованием AES-256-GCM
   * Возвращает строку в формате: iv:authTag:encrypted (hex)
   */
  encrypt(text: string): string {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    // Формат: iv:authTag:encrypted
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
  },

  /**
   * Расшифровывает данные из формата iv:authTag:encrypted
   */
  decrypt(encryptedData: string): string {
    const parts = encryptedData.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted data format');
    }

    const [ivHex, authTagHex, encrypted] = parts;

    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    if (iv.length !== IV_LENGTH) {
      throw new Error('Invalid IV length');
    }
    if (authTag.length !== AUTH_TAG_LENGTH) {
      throw new Error('Invalid auth tag length');
    }

    const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  },

  /**
   * Безопасно шифрует поле (возвращает null если входное значение null/undefined)
   */
  encryptField(value: string | null | undefined): string | null {
    if (value === null || value === undefined) {
      return null;
    }
    return this.encrypt(value);
  },

  /**
   * Безопасно расшифровывает поле (возвращает null если входное значение null/undefined)
   */
  decryptField(value: string | null | undefined): string | null {
    if (value === null || value === undefined) {
      return null;
    }
    try {
      return this.decrypt(value);
    } catch (error) {
      console.error('Decryption failed:', error);
      return null;
    }
  },

  /**
   * Генерирует случайный ключ шифрования (для начальной настройки)
   */
  generateKey(): string {
    return crypto.randomBytes(32).toString('hex');
  },

  /**
   * Хэширует строку (для поиска без расшифровки)
   */
  hash(text: string): string {
    return crypto.createHash('sha256').update(text.toLowerCase().trim()).digest('hex');
  },
};
