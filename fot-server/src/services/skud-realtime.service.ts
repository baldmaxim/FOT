import { invalidateCaches } from '../middleware/cacheResponse.js';
import { getIo } from '../socket/io-instance.js';
import { invalidateDashboardCache } from './skud-dashboard.service.js';
import { invalidatePresenceCache } from './skud-presence.service.js';

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
  'skud-dashboard',
  'timesheet',
  'timesheet:today',
  'timesheet:overview',
  'timesheet:overview:today',
  'timesheet:search',
];

export function invalidateSkudRealtimeCaches(): void {
  invalidatePresenceCache();
  invalidateDashboardCache();
  invalidateCaches(...SKUD_REALTIME_CACHE_NAMES);
}

export function notifySkudRealtimeChanged(input: ISkudRealtimeNotification): void {
  invalidateSkudRealtimeCaches();

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
