import { TOTP, Secret } from 'otpauth';
import QRCode from 'qrcode';
import crypto from 'crypto';
import { env } from '../config/env.js';
import { encryptionService } from './encryption.service.js';

const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_LENGTH = 8;

export const totpService = {
  /**
   * Генерирует новый TOTP секрет для пользователя
   */
  generateSecret(userEmail: string): { secret: string; encryptedSecret: string } {
    const secret = new Secret({ size: 20 });
    const secretBase32 = secret.base32;

    // Шифруем секрет для хранения в БД
    const encryptedSecret = encryptionService.encrypt(secretBase32);

    return {
      secret: secretBase32,
      encryptedSecret,
    };
  },

  /**
   * Генерирует QR-код для настройки 2FA в приложении
   */
  async generateQRCode(email: string, secret: string): Promise<string> {
    const totp = new TOTP({
      issuer: env.TOTP_ISSUER,
      label: email,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: Secret.fromBase32(secret),
    });

    const otpauthUrl = totp.toString();
    return QRCode.toDataURL(otpauthUrl);
  },

  /**
   * Проверяет TOTP код
   */
  verifyToken(encryptedSecret: string, token: string): boolean {
    try {
      const secret = encryptionService.decrypt(encryptedSecret);

      const totp = new TOTP({
        issuer: env.TOTP_ISSUER,
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: Secret.fromBase32(secret),
      });

      // Проверяем с окном в 1 период (для учёта рассинхронизации времени)
      const delta = totp.validate({ token, window: 1 });
      return delta !== null;
    } catch (error) {
      console.error('TOTP verification failed:', error);
      return false;
    }
  },

  /**
   * Генерирует коды восстановления
   */
  generateRecoveryCodes(): { codes: string[]; encryptedCodes: string[] } {
    const codes: string[] = [];
    const encryptedCodes: string[] = [];

    for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
      const code = crypto
        .randomBytes(Math.ceil(RECOVERY_CODE_LENGTH / 2))
        .toString('hex')
        .slice(0, RECOVERY_CODE_LENGTH)
        .toUpperCase();

      codes.push(code);
      encryptedCodes.push(encryptionService.encrypt(code));
    }

    return { codes, encryptedCodes };
  },

  /**
   * Проверяет код восстановления
   * Возвращает индекс использованного кода или -1 если код недействителен
   */
  verifyRecoveryCode(encryptedCodes: string[], inputCode: string): number {
    const normalizedInput = inputCode.toUpperCase().replace(/[^A-Z0-9]/g, '');

    for (let i = 0; i < encryptedCodes.length; i++) {
      try {
        const decryptedCode = encryptionService.decrypt(encryptedCodes[i]);
        if (decryptedCode === normalizedInput) {
          return i;
        }
      } catch {
        // Пропускаем невалидные записи
        continue;
      }
    }

    return -1;
  },

  /**
   * Форматирует код для отображения пользователю (XXXX-XXXX)
   */
  formatRecoveryCode(code: string): string {
    return `${code.slice(0, 4)}-${code.slice(4)}`;
  },
};
