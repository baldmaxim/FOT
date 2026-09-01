import { beforeAll, describe, expect, it } from 'vitest';

const KEY_V1 = 'a'.repeat(64);
const KEY_V2 = 'b'.repeat(64);

process.env.HR_FIELD_ENCRYPTION_KEYS = `v1:${KEY_V1},v2:${KEY_V2}`;
process.env.HR_FIELD_ENCRYPTION_ACTIVE_KEY_VERSION = 'v2';
process.env.HR_FIELD_HASH_PEPPER = 'pepper-pepper-pepper-pepper-pepper-32';

type Crypto = typeof import('./hr-crypto.service.js');
let c: Crypto;

beforeAll(async () => {
  c = await import('./hr-crypto.service.js');
  c.resetHrCryptoCache();
});

describe('hr-crypto: поля', () => {
  it('roundtrip с активной версией ключа', () => {
    const { enc, keyVersion } = c.encryptField('4510 123456');
    expect(keyVersion).toBe('v2');
    expect(enc).toMatch(/^v2:/);
    expect(c.decryptField(enc)).toBe('4510 123456');
  });

  it('пустое значение → null', () => {
    expect(c.encryptField(null)).toEqual({ enc: null, keyVersion: null });
    expect(c.encryptField('')).toEqual({ enc: null, keyVersion: null });
    expect(c.decryptField(null)).toBeNull();
  });

  it('расшифровка старой версии ключа работает (ротация)', () => {
    process.env.HR_FIELD_ENCRYPTION_ACTIVE_KEY_VERSION = 'v1';
    c.resetHrCryptoCache();
    // env читается один раз при импорте модуля env.ts — проверяем только формат/версию через decrypt.
    const { enc } = c.encryptField('секрет');
    process.env.HR_FIELD_ENCRYPTION_ACTIVE_KEY_VERSION = 'v2';
    c.resetHrCryptoCache();
    expect(c.decryptField(enc)).toBe('секрет');
  });

  it('производный v0 остаётся в карте при явных ключах — записи до перехода читаются', async () => {
    // Конверт, каким его записал бы модуль до появления HR_FIELD_ENCRYPTION_KEYS:
    // ключ v0 = HKDF(ENCRYPTION_KEY). Активная версия сейчас v2 — расшифровка обязана работать.
    const crypto = await import('node:crypto');
    const derived = Buffer.from(
      crypto.hkdfSync('sha256', Buffer.from(process.env.ENCRYPTION_KEY!, 'hex'), 'fot-hr', 'hr-field-encryption-v1', 32),
    );
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', derived, iv);
    const ct = Buffer.concat([cipher.update('старое значение', 'utf8'), cipher.final()]);
    const legacy = `v0:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ct.toString('base64')}`;

    process.env.HR_FIELD_ENCRYPTION_ACTIVE_KEY_VERSION = 'v2';
    c.resetHrCryptoCache();
    expect(c.encryptField('новое').keyVersion).toBe('v2');
    expect(c.decryptField(legacy)).toBe('старое значение');
  });

  it('повреждённый шифротекст → ошибка / safe → null', () => {
    const { enc } = c.encryptField('x');
    const broken = `${enc!.slice(0, -4)}AAAA`;
    expect(() => c.decryptField(broken)).toThrow();
    expect(c.decryptFieldSafe(broken)).toBeNull();
  });

  it('json roundtrip', () => {
    const { enc } = c.encryptJson({ a: 1, b: 'ц' });
    expect(c.decryptJson(enc)).toEqual({ a: 1, b: 'ц' });
  });
});

describe('hr-crypto: хэши', () => {
  it('HMAC стабилен и зависит от нормализации', () => {
    const h1 = c.hashForSearch('snils', '123-456-789 01');
    const h2 = c.hashForSearch('snils', '12345678901');
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
    expect(c.hashForSearch('snils', '')).toBeNull();
  });

  it('паспорт: кириллические двойники и регистр', () => {
    expect(c.hashForSearch('passport', 'ав 1234567')).toBe(c.hashForSearch('passport', 'AB1234567'));
  });

  it('разные поля с одним значением дают разные хэши', () => {
    expect(c.hashForSearch('inn', '123456789012')).not.toBe(c.hashForSearch('snils', '123456789012'));
  });

  it('normalizeDocNumber / normalizeDigits / имя', () => {
    expect(c.normalizeDocNumber(' ав-12 34 ')).toBe('AB1234');
    expect(c.normalizeDigits('123-456', 5)).toBe('12345');
    expect(c.normalizeNameForHash('  Ёлкин   Пётр ')).toBe('елкин петр');
  });
});

describe('hr-crypto: маска и файлы', () => {
  it('maskValue оставляет хвост', () => {
    expect(c.maskValue('4510123456')).toBe('••••••3456');
    expect(c.maskValue('12')).toBe('••');
    expect(c.maskValue(null)).toBeNull();
  });

  it('файл: roundtrip с AAD = id документа, чужой id не расшифровывается', () => {
    const plain = Buffer.from('%PDF-1.4 test bytes');
    const { buffer, meta } = c.encryptFileBuffer(plain, 42);
    expect(buffer.equals(plain)).toBe(false);
    expect(c.decryptFileBuffer(buffer, 42, meta).equals(plain)).toBe(true);
    expect(() => c.decryptFileBuffer(buffer, 43, meta)).toThrow();
  });

  it('sha256Hex', () => {
    expect(c.sha256Hex(Buffer.from('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
