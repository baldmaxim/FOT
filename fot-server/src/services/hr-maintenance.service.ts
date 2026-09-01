/**
 * Фоновая уборка кадрового модуля: просроченные черновики мастера → expired
 * (сканы soft-delete), soft-deleted сканы старше 7 дней → удаление из R2.
 */
import { isHrCryptoConfigured } from './hr-crypto.service.js';

const INTERVAL_MS = 30 * 60_000;
let timer: NodeJS.Timeout | null = null;
let running = false;

const run = async (): Promise<void> => {
  if (running) return;
  running = true;
  try {
    const { expireDrafts } = await import('./hr-draft.service.js');
    const { purgeDeletedHrDocuments } = await import('./hr-documents.service.js');
    const expired = await expireDrafts();
    const purged = await purgeDeletedHrDocuments(7);
    if (expired > 0 || purged > 0) console.log(`[hr-maintenance] черновиков просрочено: ${expired}, файлов удалено из R2: ${purged}`);
  } catch (err) {
    console.error('[hr-maintenance] error', err instanceof Error ? err.message : err);
  } finally {
    running = false;
  }
};

export const startHrMaintenance = (): void => {
  if (timer || !isHrCryptoConfigured()) return;
  timer = setInterval(() => { void run(); }, INTERVAL_MS);
  timer.unref();
  setTimeout(() => { void run(); }, 60_000).unref();
};

export const stopHrMaintenance = (): void => {
  if (timer) clearInterval(timer);
  timer = null;
};
