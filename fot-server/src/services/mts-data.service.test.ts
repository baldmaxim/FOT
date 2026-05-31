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

describe('mts-data.service persistGpsPoints', () => {
  beforeEach(() => {
    pgExecute.mockReset();
    pgExecute.mockResolvedValue(1);
  });

  it('шифрует координаты, is_valid пишет как есть, дедуп ON CONFLICT', async () => {
    const saved = await mtsDataService.persistGpsPoints([
      { locationID: 555, subscriberID: 42, locationDate: '2026-05-19T10:00:00+03:00', latitude: 55.751244, longitude: 37.618423, angle: 90, velocity: 33, isValid: true },
    ]);
    expect(saved).toBe(1);
    expect(pgExecute).toHaveBeenCalledTimes(1);
    const sql = pgExecute.mock.calls[0][0] as string;
    expect(sql).toContain('INSERT INTO mts_gps_points');
    expect(sql).toContain('ON CONFLICT (subscriber_id, location_id) DO NOTHING');
    // params: [sub, location_id, recorded_at, lat_enc, lon_enc, velocity_enc, angle_enc, is_valid]
    const [sub, locId, recAt, latEnc, lonEnc, velEnc, , isValid] = pgExecute.mock.calls[0][1] as unknown[];
    expect(sub).toBe(42);
    expect(locId).toBe(555);
    expect(recAt).toBe('2026-05-19T10:00:00+03:00');
    expect(isValid).toBe(true);
    expect(String(latEnc)).not.toContain('55.751244');
    expect(encryptionService.decryptField(latEnc as string)).toBe('55.751244');
    expect(encryptionService.decryptField(lonEnc as string)).toBe('37.618423');
    expect(encryptionService.decryptField(velEnc as string)).toBe('33');
  });

  it('пропускает точки без id/даты/координат', async () => {
    const saved = await mtsDataService.persistGpsPoints([
      { locationID: 0, subscriberID: 42, locationDate: '2026-05-19T10:00:00Z', latitude: 1, longitude: 2, angle: null, velocity: null, isValid: null },
      { locationID: 1, subscriberID: 42, locationDate: null, latitude: 1, longitude: 2, angle: null, velocity: null, isValid: null },
      { locationID: 2, subscriberID: 42, locationDate: '2026-05-19T10:00:00Z', latitude: null, longitude: 2, angle: null, velocity: null, isValid: null },
    ]);
    expect(saved).toBe(0);
    expect(pgExecute).not.toHaveBeenCalled();
  });
});

describe('mts-data.service persistTrackSegments', () => {
  beforeEach(() => {
    pgExecute.mockReset();
    pgExecute.mockResolvedValue(1);
  });

  it('шифрует координаты и адреса, distance/duration как есть, дедуп ON CONFLICT', async () => {
    const saved = await mtsDataService.persistTrackSegments([
      {
        trackID: 7, subscriberID: 42,
        startDate: '2026-05-19T08:00:00+03:00', finishDate: '2026-05-19T09:00:00+03:00',
        startAddress: 'Москва, Тверская', finishAddress: 'Москва, Арбат',
        startLat: 55.76, startLon: 37.60, finishLat: 55.75, finishLon: 37.59,
        distance: 4200, duration: 3600,
      },
    ]);
    expect(saved).toBe(1);
    const sql = pgExecute.mock.calls[0][0] as string;
    expect(sql).toContain('INSERT INTO mts_track_segments');
    expect(sql).toContain('ON CONFLICT (subscriber_id, track_id) DO NOTHING');
    // params: [sub, track_id, start_at, finish_at, sLat, sLon, fLat, fLon, sAddr, fAddr, dist, dur]
    const params = pgExecute.mock.calls[0][1] as unknown[];
    expect(params[0]).toBe(42);
    expect(params[1]).toBe(7);
    expect(String(params[8])).not.toContain('Тверская');
    expect(encryptionService.decryptField(params[8] as string)).toBe('Москва, Тверская');
    expect(encryptionService.decryptField(params[4] as string)).toBe('55.76');
    expect(params[10]).toBe(4200);
    expect(params[11]).toBe(3600);
  });

  it('пропускает сегменты без subscriberID/trackID', async () => {
    const saved = await mtsDataService.persistTrackSegments([
      { trackID: 0, subscriberID: 42, startDate: null, finishDate: null, startAddress: null, finishAddress: null, startLat: null, startLon: null, finishLat: null, finishLon: null, distance: null, duration: null },
    ]);
    expect(saved).toBe(0);
    expect(pgExecute).not.toHaveBeenCalled();
  });
});
