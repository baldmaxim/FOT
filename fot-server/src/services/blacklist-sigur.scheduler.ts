/**
 * Исполнение блокировок по чёрному списку (миграция 273).
 *
 * Почему durable, а не синхронно в запросе: источник правды — запись в PG.
 * Гейты (пропуск, приём, регистрация, вход) начинают действовать сразу после
 * коммита, и недоступность Sigur не должна откатывать сам запрет — иначе
 * человек остался бы вне списка и смог зарегистрироваться заново.
 *
 * Цикл делает две вещи:
 *  1. блокирует профили по целям (pending, плюс подхват running с истёкшим lease —
 *     иначе упавший после claim процесс оставил бы цель навсегда в running);
 *  2. реконсилер: сверяет уже выполненные цели с фактическим состоянием в Sigur
 *     и возвращает в очередь те, что кто-то разблокировал в обход гейтов.
 *
 * Тик 25с + kick с дебаунсом сразу после добавления в ЧС (как у
 * contractor-pass-sync), чтобы в норме блокировка уходила за ~секунду.
 */
import { hostname } from 'node:os';
import * as Sentry from '@sentry/node';
import { query, execute } from '../config/postgres.js';
import { isContractorSigurDryRun } from '../config/contractor.js';
import { sigurService } from './sigur.service.js';
import { updateSigurEmployee } from './sigur-live-employees-crud.service.js';
import { getSigurEmployeeProfile } from './sigur-live-admin.service.js';

const TICK_INTERVAL_MS = 25_000;
const STARTUP_DELAY_MS = 25_000;
const KICK_DEBOUNCE_MS = 500;
const LEASE_TTL_SECONDS = 120;
const MAX_ATTEMPTS = 5;
const CLAIM_BATCH = 10;
/** Как часто перепроверять уже заблокированные профили. */
const VERIFY_STALE_MINUTES = 30;
const VERIFY_BATCH = 5;

const LEASE_OWNER = `${hostname()}:${process.pid}`;

let tickTimer: ReturnType<typeof setInterval> | null = null;
let startupTimeout: ReturnType<typeof setTimeout> | null = null;
let kickTimeout: ReturnType<typeof setTimeout> | null = null;
let processing = false;
let pendingKick = false;

interface IClaimedTarget {
  id: string;
  sigur_employee_id: number;
  attempts: number;
}

/**
 * Клеймит цели активных записей. Берёт pending и running с истёкшим lease
 * (восстановление после падения процесса). SKIP LOCKED — параллельные воркеры
 * не дублируют работу.
 */
async function claimTargets(): Promise<IClaimedTarget[]> {
  const rows = await query<IClaimedTarget>(
    `WITH claimed AS (
       SELECT t.id
         FROM public.person_blacklist_targets t
         JOIN public.person_blacklist b ON b.id = t.blacklist_id
        WHERE b.removed_at IS NULL
          AND (t.state = 'pending'
               OR (t.state = 'running' AND t.lease_expires_at < now()))
        ORDER BY t.updated_at
          FOR UPDATE OF t SKIP LOCKED
        LIMIT $1
     )
     UPDATE public.person_blacklist_targets t
        SET state = 'running',
            lease_owner = $2,
            lease_expires_at = now() + ($3 || ' seconds')::interval,
            updated_at = now()
      WHERE t.id IN (SELECT id FROM claimed)
     RETURNING t.id, t.sigur_employee_id, t.attempts`,
    [CLAIM_BATCH, LEASE_OWNER, String(LEASE_TTL_SECONDS)],
  );
  return rows;
}

/** Пишет результат только своим lease: цель могли перезахватить после истечения. */
async function finishTarget(
  targetId: string,
  state: 'done' | 'failed' | 'skipped',
  errorText: string | null,
): Promise<void> {
  await execute(
    `UPDATE public.person_blacklist_targets
        SET state = $3,
            last_error = $4,
            done_at = CASE WHEN $3 = 'done' THEN now() ELSE done_at END,
            verified_at = CASE WHEN $3 = 'done' THEN now() ELSE verified_at END,
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = now()
      WHERE id = $1::uuid AND lease_owner = $2`,
    [targetId, LEASE_OWNER, state, errorText],
  );
}

async function retryTarget(targetId: string, attempts: number, errorText: string): Promise<void> {
  const exhausted = attempts + 1 >= MAX_ATTEMPTS;
  await execute(
    `UPDATE public.person_blacklist_targets
        SET state = $3,
            attempts = attempts + 1,
            last_error = $4,
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = now()
      WHERE id = $1::uuid AND lease_owner = $2`,
    [targetId, LEASE_OWNER, exhausted ? 'failed' : 'pending', errorText],
  );
}

async function blockOneTarget(target: IClaimedTarget): Promise<void> {
  if (isContractorSigurDryRun()) {
    await finishTarget(target.id, 'skipped', 'dry-run');
    return;
  }
  if (!(await sigurService.isConfigured())) {
    await retryTarget(target.id, target.attempts, 'Sigur не настроен');
    return;
  }

  const connection = await sigurService.getBackgroundConnectionType();
  try {
    // Идемпотентно: syncSigurEmployeeBlockedState сверяет текущее состояние и
    // не дёргает Sigur, если профиль уже заблокирован.
    await updateSigurEmployee(Number(target.sigur_employee_id), { blocked: true }, connection);
    await finishTarget(target.id, 'done', null);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await retryTarget(target.id, target.attempts, message.slice(0, 500));
    if (target.attempts + 1 >= MAX_ATTEMPTS) {
      Sentry.captureException(error, {
        tags: { service: 'blacklist-sigur' },
        extra: { targetId: target.id, sigurEmployeeId: target.sigur_employee_id },
      });
    }
  }
}

/**
 * Реконсилер: если профиль активной записи кто-то разблокировал (например, в
 * обход гейтов или операцией, которую мы не перехватили), возвращаем цель в
 * очередь. Это страховка, не заменяющая гейты.
 */
async function reconcileVerified(): Promise<void> {
  if (isContractorSigurDryRun() || !(await sigurService.isConfigured())) return;

  const rows = await query<{ id: string; sigur_employee_id: number }>(
    `SELECT t.id, t.sigur_employee_id
       FROM public.person_blacklist_targets t
       JOIN public.person_blacklist b ON b.id = t.blacklist_id
      WHERE b.removed_at IS NULL
        AND t.state = 'done'
        AND (t.verified_at IS NULL OR t.verified_at < now() - ($1 || ' minutes')::interval)
      ORDER BY t.verified_at NULLS FIRST
      LIMIT $2`,
    [String(VERIFY_STALE_MINUTES), VERIFY_BATCH],
  );
  if (rows.length === 0) return;

  const connection = await sigurService.getBackgroundConnectionType();
  for (const row of rows) {
    try {
      const profile = await getSigurEmployeeProfile(Number(row.sigur_employee_id), {}, connection);
      const stillBlocked = profile.profile.blocked === true;
      if (stillBlocked) {
        await execute(
          'UPDATE public.person_blacklist_targets SET verified_at = now(), updated_at = now() WHERE id = $1::uuid',
          [row.id],
        );
      } else {
        console.warn(
          `[blacklist-sigur] профиль ${row.sigur_employee_id} разблокирован в обход — возвращаю в очередь`,
        );
        await execute(
          `UPDATE public.person_blacklist_targets
              SET state = 'pending', attempts = 0, last_error = 'разблокирован в обход, повторная блокировка',
                  verified_at = now(), updated_at = now()
            WHERE id = $1::uuid`,
          [row.id],
        );
      }
    } catch (error) {
      // Профиль мог быть удалён в Sigur — не считаем это провалом блокировки.
      console.error(
        `[blacklist-sigur] verify failed for sigur=${row.sigur_employee_id}:`,
        error instanceof Error ? error.message : error,
      );
      await execute(
        'UPDATE public.person_blacklist_targets SET verified_at = now(), updated_at = now() WHERE id = $1::uuid',
        [row.id],
      );
    }
  }
}

/**
 * Один проход: исполнить накопленные цели и сверить уже выполненные.
 * Экспортирован, чтобы прогонять цикл детерминированно — из тестов и вручную,
 * не дожидаясь тика шедулера.
 */
export async function runBlacklistSigurCycleOnce(): Promise<void> {
  await doOneCycle();
}

async function doOneCycle(): Promise<void> {
  const targets = await claimTargets();
  for (const target of targets) {
    await blockOneTarget(target);
  }
  await reconcileVerified();
}

async function runCycle(): Promise<void> {
  if (processing) {
    pendingKick = true;
    return;
  }
  processing = true;
  try {
    do {
      pendingKick = false;
      await doOneCycle();
    } while (pendingKick);
  } catch (error) {
    console.error('[blacklist-sigur] cycle error:', error instanceof Error ? error.message : error);
    Sentry.captureException(error, { tags: { service: 'blacklist-sigur', stage: 'cycle' } });
  } finally {
    processing = false;
  }
}

/** Немедленно (с дебаунсом) исполнить блокировки — вызывать после добавления в ЧС. */
export function kickBlacklistSigur(): void {
  if (kickTimeout) return;
  kickTimeout = setTimeout(() => {
    kickTimeout = null;
    void runCycle();
  }, KICK_DEBOUNCE_MS);
}

export function startBlacklistSigurScheduler(): void {
  if (tickTimer || startupTimeout) return;

  console.log('[blacklist-sigur] started (tick: 25s)');
  startupTimeout = setTimeout(() => {
    startupTimeout = null;
    void runCycle();
  }, STARTUP_DELAY_MS);

  tickTimer = setInterval(() => {
    void runCycle();
  }, TICK_INTERVAL_MS);
}

export function stopBlacklistSigurScheduler(): void {
  if (startupTimeout) {
    clearTimeout(startupTimeout);
    startupTimeout = null;
  }
  if (kickTimeout) {
    clearTimeout(kickTimeout);
    kickTimeout = null;
  }
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
    console.log('[blacklist-sigur] stopped');
  }
}
