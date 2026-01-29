import { encryptionService } from '../services/encryption.service.js';

/**
 * Безопасная расшифровка - возвращает null при ошибке
 */
export function safeDecrypt(value: string | null): string | null {
  if (!value) return null;
  try {
    return encryptionService.decrypt(value);
  } catch {
    return null;
  }
}
