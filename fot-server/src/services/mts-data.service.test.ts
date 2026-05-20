import { describe, it, expect, vi, beforeEach } from 'vitest';

const { pgExecute } = vi.hoisted(() => ({ pgExecute: vi.fn() }));

vi.mock('../config/postgres.js', () => ({
  execute: pgExecute,
}));

import { mtsDataService } from './mts-data.service.js';
import { encryptionService } from './encryption.service.js';

describe('mts-data.service persistLocationSnapshots', () => {
  beforeEach(() => {
    pgExecute.mockReset();
    pgExecute.mockResolvedValue(1);
  });

  it('шифрует контент МТС перед записью в БД (в открытом виде не лежит)', async () => {
    const saved = await mtsDataService.persistLocationSnapshots([
      {
        subscriberID: 42,
        locationDate: '2026-05-19T10:00:00+03:00',
        latitude: 55.751244,
        longitude: 37.618423,
        accuracy: 12,
        address: 'Москва, Красная площадь',
        state: 'located',
        source: 'lbs',
      },
    ]);

    expect(saved).toBe(1);
    expect(pgExecute).toHaveBeenCalledTimes(1);

    const params = pgExecute.mock.calls[0][1] as unknown[];
    // params: [subscriber_id, lat_enc, lon_enc, accuracy_enc, address_enc, state_enc, source_enc, recorded_at]
    const [subId, latEnc, lonEnc, accEnc, addrEnc, , , recordedAt] = params;

    expect(subId).toBe(42);
    expect(recordedAt).toBe('2026-05-19T10:00:00+03:00');

    // Никаких значений в открытом виде
    expect(String(latEnc)).not.toContain('55.751244');
    expect(String(addrEnc)).not.toContain('Красная площадь');

    // Ciphertext формата iv:authTag:encrypted и расшифровывается обратно
    expect(String(latEnc).split(':')).toHaveLength(3);
    expect(encryptionService.decryptField(addrEnc as string)).toBe('Москва, Красная площадь');
    expect(encryptionService.decryptField(latEnc as string)).toBe('55.751244');
    expect(encryptionService.decryptField(accEnc as string)).toBe('12');
    expect(encryptionService.decryptField(lonEnc as string)).toBe('37.618423');
  });

  it('пропускает записи без subscriberID/locationDate', async () => {
    const saved = await mtsDataService.persistLocationSnapshots([
      { subscriberID: 0, locationDate: null, latitude: 1, longitude: 2, accuracy: null, address: null, state: null, source: null },
    ]);
    expect(saved).toBe(0);
    expect(pgExecute).not.toHaveBeenCalled();
  });
});
