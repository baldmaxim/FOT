/**
 * Точечное обновление зеркала отделов (org_departments) после CRUD отдела в Sigur.
 *
 * Зачем: CRUD отделов в админке пишет ТОЛЬКО в Sigur, а все списки отделов ФОТ
 * читают зеркало org_departments, которое наполняет syncDepartmentsLogic —
 * планировщик раз в 2 часа. Плюс `/api/structure` кэшируется per-user на 15 мин
 * (SWR до 60 мин). Итог до этого сервиса: созданный отдел появлялся в списках
 * через десятки минут («создала отдел, но не могу повесить на человека»).
 *
 * Гарантии:
 * - синк идёт в режиме mirror_only — lock держится секунды, а не минуты;
 * - lock-конфликт не теряет запрос: dirty-флаг + короткий backoff до успеха
 *   (идущий чужой синк мог прочитать снимок Sigur ДО нашей мутации, поэтому
 *   «он всё сделает за нас» — неверное допущение);
 * - новый запрос отменяет отложенный retry и пробует сразу;
 * - release lock только при успешном acquire.
 */
import * as Sentry from '@sentry/node';
import { execute } from '../config/postgres.js';
import { sigurService } from './sigur.service.js';
import type { ConnectionType } from './sigur-base.service.js';
import { syncDepartmentsLogic } from './sigur-sync-structure.service.js';
import { invalidateOrgStructureCaches } from './employee-mapper.service.js';
import { invalidateAccessibleScopeCache } from './data-scope.service.js';
import { invalidateCache } from '../middleware/cacheResponse.js';
import { notifySigurStructureChanged, type SigurStructureSource } from './skud-realtime.service.js';
import {
  acquireStructureSyncSchedulerLock,
  releaseStructureSyncSchedulerLock,
} from './presence-polling.service.js';
import { isSigurRuntimeAllowed, logSigurRuntimeGuardSkip } from './sigur-runtime-guard.service.js';

/** 5с → 10с → 20с → 30с, дальше каждые 30с. Lock чужого синка живёт недолго. */
const RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 30_000];

let inFlight = false;
let dirty = false;
let pendingConnection: ConnectionType | undefined;
let pendingSource: SigurStructureSource = 'admin_crud';
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let attempt = 0;

/**
 * Сбрасывает всё, что кэширует дерево отделов, и уведомляет клиентов.
 * structure:positions НЕ трогаем: должности отдельным синком, преждевременный
 * сброс закэшировал бы старый ответ заново на 15 мин.
 */
export function invalidateStructureTreeAndNotify(source: SigurStructureSource): void {
  invalidateOrgStructureCaches();
  invalidateCache('structure:tree');
  invalidateAccessibleScopeCache();
  notifySigurStructureChanged({ source, scope: 'departments' });
}

/** Гасит в зеркале строки удалённых в Sigur отделов, не дожидаясь reconciliation. */
export async function deactivateMirroredDepartments(sigurDepartmentIds: number[]): Promise<number> {
  const ids = [...new Set(sigurDepartmentIds.filter(id => Number.isFinite(id) && id > 0))];
  if (ids.length === 0) return 0;

  try {
    const deactivated = await execute(
      'UPDATE org_departments SET is_active = false WHERE sigur_department_id = ANY($1::int[])',
      [ids],
    );
    console.log(`[structure-refresh] deactivated ${deactivated} mirrored departments (sigur ids: ${ids.join(', ')})`);
    invalidateStructureTreeAndNotify('sigur_delete');
    return deactivated;
  } catch (error) {
    console.error('[structure-refresh] deactivate failed:', (error as Error).message);
    Sentry.captureException(error, {
      tags: { service: 'structure-refresh' },
      extra: { sigurDepartmentIds: ids },
    });
    return 0;
  }
}

function scheduleRetry(): void {
  if (retryTimer) return;
  const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
  attempt++;
  console.log(`[structure-refresh] retry in ${Math.round(delay / 1000)}s (attempt ${attempt})`);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void runOnce();
  }, delay);
  retryTimer.unref?.();
}

async function runOnce(): Promise<void> {
  if (inFlight) {
    dirty = true;
    return;
  }

  inFlight = true;
  dirty = false;
  const connection = pendingConnection;
  const source = pendingSource;
  let acquired = false;
  let failed = false;

  try {
    // Снимок отделов Sigur мог быть снят до нашей мутации — иначе синк перезапишет
    // зеркало старыми данными и «успешно» ничего не изменит.
    sigurService.invalidateDepartmentCache();

    await acquireStructureSyncSchedulerLock();
    acquired = true;

    const result = await syncDepartmentsLogic(connection, {}, { mode: 'mirror_only' });
    console.log(
      `[structure-refresh] mirror refreshed source=${source}: ${result.imported} imported, ${result.updated} updated, ${result.filtered} filtered`,
    );
    attempt = 0;
    invalidateStructureTreeAndNotify(source);
  } catch (error) {
    failed = true;
    dirty = true;
    const message = (error as Error).message;
    // ManualSyncInProgressError — ожидаемая конкуренция, не шумим в Sentry.
    if ((error as { code?: string }).code === 'SYNC_IN_PROGRESS') {
      console.log(`[structure-refresh] sync in progress, will retry: ${message}`);
    } else {
      console.error('[structure-refresh] refresh failed:', message);
      Sentry.captureException(error, { tags: { service: 'structure-refresh' }, extra: { source } });
    }
  } finally {
    if (acquired) {
      await releaseStructureSyncSchedulerLock().catch(releaseError => {
        console.error('[structure-refresh] lock release error:', (releaseError as Error).message);
      });
    }
    inFlight = false;
  }

  if (failed) {
    // Ошибка (чаще всего чужой синк держит lock) — только через backoff, иначе
    // получился бы busy-loop по Sigur API.
    scheduleRetry();
    return;
  }

  if (dirty) {
    // Правки, пришедшие во время успешного прогона — догоняем сразу.
    await runOnce();
  }
}

/**
 * Запросить обновление зеркала отделов. Fire-and-forget: ничего не бросает,
 * вызывающий CRUD не ждёт синка (клиент узнает по Socket.IO structure_updated).
 */
export function requestDepartmentsMirrorRefresh(
  source: SigurStructureSource,
  connection?: ConnectionType,
): void {
  if (!isSigurRuntimeAllowed()) {
    logSigurRuntimeGuardSkip('structure-refresh');
    return;
  }

  pendingConnection = connection;
  pendingSource = source;

  if (inFlight) {
    dirty = true;
    return;
  }

  // Свежая правка важнее выжидания backoff: отменяем отложенный retry.
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }

  void runOnce();
}

/** Только для тестов: сброс модульного состояния между кейсами. */
export function __resetStructureRefreshStateForTests(): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  inFlight = false;
  dirty = false;
  attempt = 0;
  pendingConnection = undefined;
  pendingSource = 'admin_crud';
}
