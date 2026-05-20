import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { tryAcquire, release, getOwner } = vi.hoisted(() => ({
  tryAcquire: vi.fn(),
  release: vi.fn(),
  getOwner: vi.fn(() => 'mts_location_polling:test-pid'),
}));

const { getResolvedMtsConfig } = vi.hoisted(() => ({ getResolvedMtsConfig: vi.fn() }));
const { getLastLocations, persistLocationSnapshots } = vi.hoisted(() => ({
  getLastLocations: vi.fn(),
  persistLocationSnapshots: vi.fn(),
}));

vi.mock('./sigur-runtime-state.service.js', () => ({
  tryAcquireSigurRuntimeLease: tryAcquire,
  releaseSigurRuntimeLease: release,
  getSigurRuntimeOwner: getOwner,
}));

vi.mock('./settings.service.js', () => ({
  settingsService: { getResolvedMtsConfig },
}));

vi.mock('./mts-data.service.js', () => ({
  mtsDataService: { getLastLocations, persistLocationSnapshots },
}));

// Импорт ПОСЛЕ моков, чтобы загрузился с подставленными зависимостями.
const importModule = async () => import('./mts-location-poller.service.js');

describe('mts-location-poller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    tryAcquire.mockReset();
    release.mockReset();
    getResolvedMtsConfig.mockReset();
    getLastLocations.mockReset();
    persistLocationSnapshots.mockReset();
  });

  afterEach(async () => {
    const mod = await importModule();
    mod.stopMtsLocationPoller();
    vi.useRealTimers();
  });

  it('не делает запросов в МТС если интеграция не настроена (нет токена)', async () => {
    getResolvedMtsConfig.mockResolvedValue(null);
    const mod = await importModule();

    mod.startMtsLocationPoller();
    await vi.advanceTimersByTimeAsync(30_000); // стартовый delay

    expect(tryAcquire).not.toHaveBeenCalled();
    expect(getLastLocations).not.toHaveBeenCalled();
  });

  it('держит lease на тик: acquire → fetch → persist → release', async () => {
    getResolvedMtsConfig.mockResolvedValue({
      baseUrl: 'https://api.mpoisk.ru/v6/api',
      token: 't',
      source: 'system_settings' as const,
    });
    tryAcquire.mockResolvedValue({ acquired: true, row: null });
    getLastLocations.mockResolvedValue([
      { subscriberID: 1, locationDate: '2026-05-20T10:00:00+03:00' },
    ]);
    persistLocationSnapshots.mockResolvedValue(1);
    release.mockResolvedValue(true);

    const mod = await importModule();
    mod.startMtsLocationPoller();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(tryAcquire).toHaveBeenCalledTimes(1);
    expect(tryAcquire.mock.calls[0][0]).toMatchObject({
      key: 'mts_location_polling',
      ttlSeconds: 180,
    });
    expect(getLastLocations).toHaveBeenCalledTimes(1);
    expect(persistLocationSnapshots).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('не дёргает МТС если lease взял другой инстанс', async () => {
    getResolvedMtsConfig.mockResolvedValue({
      baseUrl: 'https://api.mpoisk.ru/v6/api',
      token: 't',
      source: 'system_settings' as const,
    });
    tryAcquire.mockResolvedValue({ acquired: false, row: null });

    const mod = await importModule();
    mod.startMtsLocationPoller();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(tryAcquire).toHaveBeenCalledTimes(1);
    expect(getLastLocations).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });
});
