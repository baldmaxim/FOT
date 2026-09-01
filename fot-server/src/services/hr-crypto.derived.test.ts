/**
 * Режим по умолчанию: HR_FIELD_* не заданы — ключ v0 и pepper выводятся из
 * платформенного ENCRYPTION_KEY. Модуль обязан работать сразу после деплоя,
 * без правки .env на проде.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  delete process.env.HR_FIELD_ENCRYPTION_KEYS;
  delete process.env.HR_FIELD_ENCRYPTION_ACTIVE_KEY_VERSION;
  delete process.env.HR_FIELD_HASH_PEPPER;
  process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
});

type Crypto = typeof import('./hr-crypto.service.js');
let c: Crypto;

beforeAll(async () => {
  c = await import('./hr-crypto.service.js');
  c.resetHrCryptoCache();
});

describe('hr-crypto: производные ключи из ENCRYPTION_KEY', () => {
  it('модуль считается настроенным без HR_FIELD_* переменных', () => {
    expect(c.isHrCryptoConfigured()).toBe(true);
    expect(c.getActiveHrKeyVersion()).toBe('v0');
  });

  it('поля шифруются под v0 и расшифровываются', () => {
    const { enc, keyVersion } = c.encryptField('4510 123456');
    expect(keyVersion).toBe('v0');
    expect(enc).toMatch(/^v0:/);
    expect(c.decryptField(enc)).toBe('4510 123456');
  });

  it('файлы шифруются и расшифровываются (AAD = id документа)', () => {
    const plain = Buffer.from('scan bytes');
    const { buffer, meta } = c.encryptFileBuffer(plain, 7);
    expect(meta.keyVersion).toBe('v0');
    expect(c.decryptFileBuffer(buffer, 7, meta).equals(plain)).toBe(true);
    expect(() => c.decryptFileBuffer(buffer, 8, meta)).toThrow();
  });

  it('pepper секретный и стабильный: хэш не равен голому SHA-256 от значения', async () => {
    const crypto = await import('node:crypto');
    const h1 = c.hashForSearch('snils', '123-456-789 01');
    const h2 = c.hashForSearch('snils', '12345678901');
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
    expect(h1).not.toBe(crypto.createHash('sha256').update('12345678901').digest('hex'));
    expect(h1).not.toBe(crypto.createHash('sha256').update('snils|12345678901').digest('hex'));
  });

  it('разные поля с одним значением дают разные хэши', () => {
    expect(c.hashForSearch('inn', '123456789012')).not.toBe(c.hashForSearch('passport', '123456789012'));
  });
});
