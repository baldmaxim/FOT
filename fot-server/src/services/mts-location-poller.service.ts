import * as Sentry from '@sentry/node';
import { env } from '../config/env.js';
import { mtsDataService } from './mts-data.service.js';
import { settingsService } from './settings.service.js';
import {
  tryAcquireSigurRuntimeLease,
  releaseSigurRuntimeLease,
  getSigurRuntimeOwner,
} from './sigur-runtime-state.service.js';
import { MtsApiError } from './mts-base.service.js';

// Фоновый поллер пассивных lastLocations: раз в час (env MTS_SYNC_INTERVAL_MS)
// дёргает один bulk-запрос на ВСЕХ абонентов и сохраняет снимки в БД
// зашифрованными (AES-256-GCM). API бесплатный — за объём не платим.
// Активный subscriberRequests НЕ дёргаем: он платный и идёт только вручную из UI.
//
// Lease через sigur_runtime_state (повторно используем существующую инфраструктуру),
// ключ 'mts_location_polling'. При нескольких инстансах PM2 поллит только один.

const LEASE_KEY = 'mts_location_polling';
const LEASE_TTL_SECONDS = 180;
const STARTUP_DELAY_MS = 30_000;

let timer: NodeJS.Timeout | null = null;
let stopped = false;

async function tick(owner: string): Promise<void> {
  // Не дёргаем МТС если интеграция не настроена (нет токена ни в БД, ни в env).
  const config = await settingsService.getResolvedMtsConfig();
  if (!config) return;

  const acq = await tryAcquireSigurRuntimeLease({
    key: LEASE_KEY,
    owner,
    ttlSeconds: LEASE_TTL_SECONDS,
    meta: { tickedAt: new Date().toISOString() },
  });
  if (!acq.acquired) return;

  try {
    const locations = await mtsDataService.getLastLocations();
    const saved = await mtsDataService.persistLocationSnapshots(locations);
    console.log(`[mts-poller] tick: fetched=${locations.length} saved=${saved}`);
  } catch (error) {
    // Тело апстрима МТС НЕ кладём в сообщение — может содержать ПДн.
    if (error instanceof MtsApiError) {
      console.error(`[mts-poller] upstream error: http=${error.status} code=${error.code ?? '-'}`);
    } else {
      console.error('[mts-poller] tick failed:', error instanceof Error ? error.message : 'unknown');
      Sentry.captureException(error);
    }
  } finally {
    await releaseSigurRuntimeLease({ key: LEASE_KEY, owner }).catch(err =>
      console.error('[mts-poller] release lease failed:', (err as Error).message),
    );
  }
}

export function startMtsLocationPoller(): void {
  if (timer) return;
  stopped = false;
  const intervalMs = Math.max(60_000, Number.parseInt(env.MTS_SYNC_INTERVAL_MS, 10) || 3_600_000);
  const owner = getSigurRuntimeOwner('mts_location_polling');

  console.log(`[mts-poller] starting (interval=${Math.round(intervalMs / 1000)}s, owner=${owner})`);

  const run = (): void => {
    if (stopped) return;
    void tick(owner);
  };

  // Стартовый delay — не бить МТС сразу при старте сервера (даём ОС/БД устаканиться).
  setTimeout(run, STARTUP_DELAY_MS);
  timer = setInterval(run, intervalMs);
}

export function stopMtsLocationPoller(): void {
  stopped = true;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
