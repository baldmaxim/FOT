import { invalidateCaches } from '../middleware/cacheResponse.js';
import { getIo } from '../socket/io-instance.js';
import { invalidateDashboardCache } from './skud-dashboard.service.js';
import { invalidatePresenceCache, rewarmPresenceAll } from './skud-presence.service.js';
import { invalidatePresenceByObjectCache, rewarmPresenceByObjectAll } from './skud-presence-by-object.service.js';

export type SkudRealtimeSource = 'polling' | 'manual_sync' | 'employee_sync' | 'daily_sync' | 'timesheet_refresh';

export interface ISkudRealtimeNotification {
  source: SkudRealtimeSource;
  employeeIds?: number[];
  from?: string | null;
  to?: string | null;
  insertedCount?: number;
  recalculatedCount?: number;
  at?: string;
}

const SKUD_REALTIME_CACHE_NAMES = [
  'skud-presence',
  'skud-presence-by-object',
  'skud-dashboard',
  'timesheet',
  'timesheet:today',
  'timesheet:overview',
  'timesheet:overview:today',
  'timesheet:search',
];

export function invalidateSkudRealtimeCaches(): void {
  invalidatePresenceCache();
  invalidatePresenceByObjectCache();
  invalidateDashboardCache();
  invalidateCaches(...SKUD_REALTIME_CACHE_NAMES);
}

export function notifySkudRealtimeChanged(input: ISkudRealtimeNotification): void {
  // Сервисные SWR-кэши presence НЕ чистим вхолодную (это давало холодный
  // пересчёт у следующего запроса страницы и пауза в «прямом эфире»), а
  // перегреваем «горячий» scope свежими данными в фоне — старое значение
  // остаётся отдаваемым до замены, без паузы. HTTP per-user кэши чистим:
  // контроллер быстр, т.к. сервисный слой уже горячий.
  invalidateDashboardCache();
  invalidateCaches(...SKUD_REALTIME_CACHE_NAMES);
  rewarmPresenceAll();
  rewarmPresenceByObjectAll();

  const employeeIds = [...new Set((input.employeeIds || []).filter(Number.isFinite))];
  try {
    getIo()?.emit('presence_updated', {
      at: input.at || new Date().toISOString(),
      employeeIds,
      from: input.from ?? null,
      to: input.to ?? null,
      source: input.source,
      insertedCount: input.insertedCount ?? 0,
      recalculatedCount: input.recalculatedCount ?? 0,
    });
  } catch (socketError) {
    console.error('[skud-realtime] socket emit error:', (socketError as Error).message);
  }
}

export type SigurStructureSource = 'scheduler' | 'admin_crud' | 'manual_sync';

export interface ISigurStructureNotification {
  source: SigurStructureSource;
  scope?: 'departments' | 'positions' | 'employees' | 'all';
  at?: string;
}

export function notifySigurStructureChanged(input: ISigurStructureNotification): void {
  try {
    getIo()?.emit('structure_updated', {
      at: input.at || new Date().toISOString(),
      source: input.source,
      scope: input.scope ?? 'all',
    });
  } catch (socketError) {
    console.error('[skud-realtime] structure socket emit error:', (socketError as Error).message);
  }
}
