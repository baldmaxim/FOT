/**
 * Детектор изменений структуры, сделанных НАПРЯМУЮ в Sigur (мимо ФОТ).
 *
 * Правки через раздел Sigur закрывает синхронный mirror-refresh в
 * sigur-live-departments-crud. Всё, что кадровик делает в самом Sigur, ФОТ
 * узнавал только с плановым синком (по умолчанию раз в 30 минут) — отдела
 * «просто нет», сотрудника в него не добавить.
 *
 * Тик дешёвый: один GET /departments, сравнение с зеркалом, при расхождении —
 * mirror-only refresh (секунды) вместо полного синка со срезом сотрудников.
 *
 * Проверка НАПРАВЛЕННАЯ: каждый отдел, который зеркало обязано содержать
 * (resolveMirrorPolicy), должен быть в нём с тем же именем и родителем. Лишние
 * активные строки зеркала — норма (отделы, оставленные ради числящихся людей,
 * удалённые в Sigur, но ещё населённые, структурные предки), полное равенство
 * дало бы вечный refresh. Исчезнувшие в Sigur отделы тик не триггерят: их гасит
 * reconciliation планового синка, у которого есть второй срез сотрудников.
 */
import * as Sentry from '@sentry/node';
import { createHash } from 'node:crypto';
import { query } from '../config/postgres.js';
import { env } from '../config/env.js';
import { IS_PRODUCTION } from '../config/features.js';
import { sigurService } from './sigur.service.js';
import {
  getWhitelistedDepartmentIdsCached,
  normalizeDepartment,
  resolveMirrorPolicy,
  type INormalizedDept,
} from './sigur-sync-shared.js';
import { runDepartmentsMirrorRefreshNow } from './sigur-structure-refresh.service.js';
import { isSigurRuntimeAllowed, logSigurRuntimeGuardSkip } from './sigur-runtime-guard.service.js';
import { runWithCronMonitor, type CronRunStatus } from '../utils/sentry-cron.js';

const MIN_WATCH_INTERVAL_MS = 60_000;
const DEFAULT_WATCH_INTERVAL_MS = 5 * 60_000;
const STARTUP_DELAY_MS = 45_000;
/** Расхождение осталось после refresh: не долбим Sigur каждые 5 минут. */
const BACKOFF_MS = [5 * 60_000, 15 * 60_000, 30 * 60_000];

let watchTimer: ReturnType<typeof setInterval> | null = null;
let startupTimer: ReturnType<typeof setTimeout> | null = null;
/** Single-flight: тик не запускается поверх незавершённого. */
let tickInFlight = false;
/** Хэш снимка Sigur, для которого зеркало уже подтверждено сошедшимся. */
let settledSnapshotHash: string | null = null;
/** Хэш снимка, по которому refresh не помог; backoff считается от него. */
let failingSnapshotHash: string | null = null;
let failedAttempts = 0;
let nextAttemptAt = 0;

function resolveWatchInterval(): number {
  const parsed = Number.parseInt(env.SIGUR_STRUCTURE_WATCH_INTERVAL_MS, 10);
  if (!Number.isFinite(parsed) || parsed < MIN_WATCH_INTERVAL_MS) return DEFAULT_WATCH_INTERVAL_MS;
  return parsed;
}

export interface IMirrorRow {
  sigur_department_id: number;
  name: string | null;
  parent_sigur_id: number | null;
}

export interface IMirrorDrift {
  missing: number[];
  renamed: number[];
  reparented: number[];
}

export function isDriftEmpty(drift: IMirrorDrift): boolean {
  return drift.missing.length === 0 && drift.renamed.length === 0 && drift.reparented.length === 0;
}

/**
 * Что из обязательного набора не доехало до зеркала. Лишние строки зеркала
 * игнорируются намеренно (см. шапку файла).
 */
export function diffMirror(
  expected: INormalizedDept[],
  mirrorRows: IMirrorRow[],
): IMirrorDrift {
  const mirrorById = new Map<number, IMirrorRow>();
  for (const row of mirrorRows) mirrorById.set(row.sigur_department_id, row);

  const drift: IMirrorDrift = { missing: [], renamed: [], reparented: [] };

  for (const dept of expected) {
    const row = mirrorById.get(dept.id);
    if (!row) {
      drift.missing.push(dept.id);
      continue;
    }
    if ((row.name ?? '').trim() !== (dept.name ?? '').trim()) {
      drift.renamed.push(dept.id);
    }
    // Корень Sigur (parentId 0/null) в зеркале висит под синтетическим «Объект»,
    // у которого нет sigur-id, — это не расхождение.
    const expectedParent = dept.parentId && dept.parentId > 0 ? dept.parentId : null;
    if (expectedParent !== null && row.parent_sigur_id !== expectedParent) {
      drift.reparented.push(dept.id);
    }
  }

  return drift;
}

export function hashSnapshot(departments: INormalizedDept[]): string {
  const canonical = [...departments]
    .sort((left, right) => left.id - right.id)
    .map(dept => `${dept.id}:${(dept.name ?? '').trim()}:${dept.parentId ?? 0}`)
    .join('|');
  return createHash('sha1').update(canonical).digest('hex');
}

async function loadMirrorRows(): Promise<IMirrorRow[]> {
  return query<IMirrorRow>(
    `SELECT d.sigur_department_id, d.name, p.sigur_department_id AS parent_sigur_id
       FROM org_departments d
       LEFT JOIN org_departments p ON p.id = d.parent_id
      WHERE d.sigur_department_id IS NOT NULL AND d.is_active = true`,
  );
}

async function runWatchTick(): Promise<void> {
  if (tickInFlight) return;
  if (!isSigurRuntimeAllowed()) {
    logSigurRuntimeGuardSkip('structure-watch');
    return;
  }

  tickInFlight = true;
  try {
    await runWithCronMonitor(
      'sigur-structure-watch',
      async (): Promise<CronRunStatus> => {
        const connection = await sigurService.getBackgroundConnectionType();
        // Не getDepartmentsCached: у списочного кэша TTL 1 час, детектор бы
        // смотрел в прошлое.
        const raw = await sigurService.getDepartments(connection);
        if (!raw || raw.length === 0) {
          console.warn('[structure-watch] Sigur вернул пустой список отделов — пропускаем тик');
          return 'ok';
        }

        const departments = (raw as Record<string, unknown>[]).map(normalizeDepartment);
        const snapshotHash = hashSnapshot(departments);

        // Снимок изменился — прошлый неуспех больше не актуален.
        if (failingSnapshotHash !== null && failingSnapshotHash !== snapshotHash) {
          failingSnapshotHash = null;
          failedAttempts = 0;
          nextAttemptAt = 0;
        }

        const whitelist = await getWhitelistedDepartmentIdsCached(connection);
        const { mirroredIds } = resolveMirrorPolicy(departments, whitelist);
        const expected = departments.filter(dept => mirroredIds.has(dept.id));

        const drift = diffMirror(expected, await loadMirrorRows());
        if (isDriftEmpty(drift)) {
          settledSnapshotHash = snapshotHash;
          failingSnapshotHash = null;
          failedAttempts = 0;
          return 'ok';
        }

        if (snapshotHash === settledSnapshotHash) {
          // Зеркало разъехалось без изменений в Sigur — редко, но refresh нужен.
          settledSnapshotHash = null;
        }

        if (failingSnapshotHash === snapshotHash && Date.now() < nextAttemptAt) {
          return 'ok';
        }

        console.log(
          `[structure-watch] расхождение: ${drift.missing.length} нет в зеркале,`
          + ` ${drift.renamed.length} переименованы, ${drift.reparented.length} сменили родителя`
          + ' → mirror refresh',
        );
        const refresh = await runDepartmentsMirrorRefreshNow('sigur_watch', connection);

        // Применённым снимок считаем только по факту сошедшегося зеркала.
        const driftAfter = diffMirror(expected, await loadMirrorRows());
        if (isDriftEmpty(driftAfter)) {
          settledSnapshotHash = snapshotHash;
          failingSnapshotHash = null;
          failedAttempts = 0;
          nextAttemptAt = 0;
          return 'ok';
        }

        failingSnapshotHash = snapshotHash;
        const delay = BACKOFF_MS[Math.min(failedAttempts, BACKOFF_MS.length - 1)];
        failedAttempts++;
        nextAttemptAt = Date.now() + delay;

        const stillMissing = [...driftAfter.missing, ...driftAfter.renamed, ...driftAfter.reparented];
        const message =
          `[structure-watch] зеркало не сошлось после refresh (${refresh.ok ? 'refresh ok' : refresh.reason})`
          + `, следующая попытка через ${Math.round(delay / 60_000)} мин;`
          + ` отделы: ${stillMissing.slice(0, 10).join(', ')}`;
        console.warn(message);
        Sentry.captureMessage(message, { level: 'warning', tags: { service: 'structure-watch' } });
        return 'ok';
      },
      {
        schedule: { type: 'interval', value: Math.max(1, Math.round(resolveWatchInterval() / 60_000)), unit: 'minute' },
        checkinMargin: 5,
        maxRuntime: 10,
      },
    );
  } catch (error) {
    console.error('[structure-watch] tick failed:', (error as Error).message);
    Sentry.captureException(error, { tags: { service: 'structure-watch' } });
  } finally {
    tickInFlight = false;
  }
}

export async function startStructureWatch(): Promise<void> {
  if (watchTimer || startupTimer) return;
  if (!(await sigurService.isConfigured())) {
    console.log('[structure-watch] Sigur not configured, skipping');
    return;
  }
  if (!isSigurRuntimeAllowed()) {
    logSigurRuntimeGuardSkip('structure-watch');
    return;
  }

  const intervalMs = resolveWatchInterval();
  console.log(`[structure-watch] started (interval: ${Math.round(intervalMs / 1000)}s)`);

  if (IS_PRODUCTION) {
    startupTimer = setTimeout(() => {
      startupTimer = null;
      void runWatchTick();
    }, STARTUP_DELAY_MS);
    startupTimer.unref?.();
  }

  watchTimer = setInterval(() => {
    void runWatchTick();
  }, intervalMs);
  watchTimer.unref?.();
}

export function stopStructureWatch(): void {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  if (watchTimer) {
    clearInterval(watchTimer);
    watchTimer = null;
    console.log('[structure-watch] stopped');
  }
}

/** Только для тестов. */
export const __watchInternals = {
  runWatchTick,
  reset(): void {
    stopStructureWatch();
    tickInFlight = false;
    settledSnapshotHash = null;
    failingSnapshotHash = null;
    failedAttempts = 0;
    nextAttemptAt = 0;
  },
};
