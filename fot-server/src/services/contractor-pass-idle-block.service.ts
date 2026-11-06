/**
 * Автоблокировка пропусков подрядчиков, которые не ходят больше 5 дней.
 * Вызывают ночной планировщик и CLI scripts/contractor-pass-idle-block.ts.
 *
 * Очередь — те же «Не ходят», что в статистике (contractor-pass-idle.service.ts).
 *
 * Принципы:
 *  - причина пишется как при ручной блокировке, поэтому карточка SIGUR и окно разблокировки
 *    показывают её сами;
 *  - журнал и отметки пишутся в транзакции, вызов Sigur — последним шагом: сбой Sigur откатывает БД.
 *    Если Sigur заблокировал, а COMMIT упал, следующий запуск увидит заблокированный профиль без
 *    причины и допишет её без второй блокировки;
 *  - источник блокировки не подменяется: чужая причина остаётся, пропуск получает отдельную отметку;
 *  - каждая автоблокировка хранит run_id, партию снимает contractor-pass-idle-rollback.service.ts;
 *  - не блокируем никого, если за любой из 5 дней почти нет проходов (дыра в событиях, каникулы —
 *    снять нельзя) или за один запуск получилось больше 300 (снимается только force).
 */
import { randomUUID } from 'crypto';
import * as Sentry from '@sentry/node';
import type { PoolClient } from 'pg';
import { query, queryOne, withTransaction } from '../config/postgres.js';
import { moscowTodayIso } from '../utils/date.utils.js';
import { AUDIT_ACTIONS, auditService } from './audit.service.js';
import { isSigurNotFound } from './contractor-pool.service.js';
import {
  fetchIdleBlockCandidates,
  IDLE_PASS_DAYS,
  lockIdleBlockCandidate,
  markContractorPassUnblocked,
  type IIdlePassRow,
} from './contractor-pass-idle.service.js';
import type { ConnectionType } from './sigur-base.service.js';
import { getSigurEmployeeBlockInfo } from './sigur-employee-block.service.js';
import { invalidateSigurDirectoryCaches } from './sigur-live-admin.service.js';
import { resolveField } from './sigur-sync-shared.js';
import { sigurService } from './sigur.service.js';

/** Больше стольких за запуск — стоп до записи; снимает только force. */
export const IDLE_BLOCK_MAX_PER_RUN = 300;
/** Меньше стольких проходов за любой из IDLE_PASS_DAYS дней — стоп, force не снимает. */
export const IDLE_BLOCK_MIN_DAILY_EVENTS = 100;
/** Столько временных ошибок подряд — Sigur или БД недоступны, прогон останавливается. */
export const IDLE_BLOCK_MAX_CONSECUTIVE_FAILURES = 20;
export const IDLE_BLOCK_ENABLED_SETTING = 'contractor_pass_idle_block_enabled';

export const IDLE_BLOCK_AUDIT_SOURCE = 'contractor_pass_idle';
const SIGUR_DIRECT_SOURCE = 'sigur_direct';

export type IdleBlockStatus = 'completed' | 'partial' | 'events_gap' | 'mass_stop';
type IdleBlockOutcome = 'blocked' | 'reason_added' | 'already_manual' | 'changed';

export interface IIdleBlockEventDay {
  day: string;
  events: number;
}

export interface IIdleBlockFailure {
  passNumber: string;
  error: string;
}

export interface IIdleBlockResult {
  runId: string;
  dryRun: boolean;
  status: IdleBlockStatus;
  /** Вся очередь на момент снимка. */
  totalCandidates: number;
  /** Сколько взято в этот запуск: вся очередь или первые limit. */
  selected: number;
  blocked: number;
  reasonAdded: number;
  alreadyManual: number;
  /** Сверка: разблокированы прямо в Sigur, снова активны. В dry-run — сколько было бы. */
  restored: number;
  skipped: string[];
  changed: string[];
  failed: IIdleBlockFailure[];
  stoppedOnFailures: boolean;
  aborted: boolean;
  eventGaps: IIdleBlockEventDay[];
  /** Отобранные пропуска, для отчёта CLI. */
  candidates: IIdlePassRow[];
}

export interface IRunIdleBlockParams {
  dryRun: boolean;
  /** Снимает только предел IDLE_BLOCK_MAX_PER_RUN, проверку событий — никогда. */
  force?: boolean;
  limit?: number | null;
  triggeredBy: 'scheduler' | 'cli';
  shouldAbort?: () => boolean;
}

/** Профиля в Sigur нет: 404/422 на чтении. Постоянная ошибка, повтор ничего не даст. */
class SigurProfileGoneError extends Error {
  constructor(sigurEmployeeId: number) {
    super(`Профиль Sigur ${sigurEmployeeId} удалён`);
    this.name = 'SigurProfileGoneError';
  }
}

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const formatRuDate = (iso: string): string => iso.split('-').reverse().join('.');

/** Текст причины в карточке SIGUR. */
export const buildIdleBlockReason = (row: Pick<IIdlePassRow, 'last_event_date' | 'issued_on'>): string => {
  const details = row.last_event_date
    ? `последний проход ${formatRuDate(row.last_event_date)}`
    : `проходов не было, выдан ${formatRuDate(row.issued_on)}`;
  return `Автоблокировка: не ходит больше ${IDLE_PASS_DAYS} дней (${details})`;
};

/** Включён ли ночной прогон. Мимо кэша settingsService: выключение действует со следующего тика. */
export const isIdleBlockNightlyEnabled = async (): Promise<boolean> => {
  const row = await queryOne<{ value: string | null }>(
    'SELECT value FROM system_settings WHERE key = $1',
    [IDLE_BLOCK_ENABLED_SETTING],
  );
  return row?.value === 'true';
};

export const setIdleBlockNightlyEnabled = async (enabled: boolean): Promise<void> => {
  await withTransaction(async client => {
    const updated = await client.query(
      'UPDATE system_settings SET value = $1, updated_at = now() WHERE key = $2',
      [String(enabled), IDLE_BLOCK_ENABLED_SETTING],
    );
    if (updated.rowCount !== 1) {
      throw new Error(`Нет настройки ${IDLE_BLOCK_ENABLED_SETTING}: миграция 349 не применена`);
    }
    await auditService.logWithClient(client, {
      user_id: null,
      action: AUDIT_ACTIONS.CONTRACTOR_POOL_SETTINGS_CHANGED,
      entity_type: 'system_setting',
      entity_id: IDLE_BLOCK_ENABLED_SETTING,
      details: { value: enabled, source: 'cli' },
    });
  });
};

/** Признак блокировки из ответа Sigur — как normalizeBoolean в sigur-live-admin; null — неизвестно. */
export const parseSigurBlocked = (value: unknown): boolean | null => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'y'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'n'].includes(normalized)) return false;
  }
  return null;
};

/** Живое чтение: getSigurEmployeeProfile берёт blocked из кэша сотрудников. */
const readLiveBlocked = async (sigurEmployeeId: number, connection: ConnectionType): Promise<boolean | null> => {
  const raw = await sigurService.getEmployeeById(sigurEmployeeId, connection);
  return parseSigurBlocked(resolveField(raw, 'isBlocked', 'blocked', 'IsBlocked'));
};

/** Дни из ожидаемых пяти, где проходов мало. Generate_series: день без единой строки даёт 0. */
const findEventGaps = async (today: string): Promise<IIdleBlockEventDay[]> => {
  const days = await query<IIdleBlockEventDay>(
    `SELECT to_char(d.day, 'YYYY-MM-DD') AS day, c.events
       FROM generate_series(($1::date - $2::int)::timestamp, ($1::date - 1)::timestamp, interval '1 day') AS d(day)
      CROSS JOIN LATERAL (
        SELECT count(*)::int AS events
          FROM skud_events se
         WHERE se.event_date = d.day::date
           AND se.direction IN ('entry', 'exit')
      ) c
      ORDER BY d.day`,
    [today, IDLE_PASS_DAYS],
  );
  return days.filter(day => day.events < IDLE_BLOCK_MIN_DAILY_EVENTS);
};

interface IMarkedPassRow {
  pass_id: string;
  holder_id: string;
  sigur_employee_id: number;
}

/** Отмеченные, кто прошёл после отметки, а разблокировки в журнале нет: разблокировали мимо портала. */
const loadWalkedAfterMark = (today: string): Promise<IMarkedPassRow[]> =>
  query<IMarkedPassRow>(
    `SELECT p.id AS pass_id, h.id::text AS holder_id, p.sigur_employee_id::int AS sigur_employee_id
       FROM contractor_passes p
       JOIN contractor_pass_holders h
         ON h.pass_id = p.id AND h.valid_until IS NULL AND h.approved_at IS NOT NULL
      CROSS JOIN LATERAL (SELECT COALESCE(h.idle_blocked_at, h.external_blocked_seen_at) AS marked_at) m
      WHERE p.status = 'applied'
        AND NOT p.is_active
        AND p.sigur_employee_id IS NOT NULL
        AND m.marked_at IS NOT NULL
        AND EXISTS (
          SELECT 1
            FROM employees e
            JOIN skud_events se ON se.employee_id = e.id
           WHERE e.sigur_employee_id = p.sigur_employee_id
             AND se.event_at > m.marked_at
             AND se.event_date BETWEEN (m.marked_at AT TIME ZONE 'Europe/Moscow')::date AND $1::date
             AND se.direction IN ('entry', 'exit')
        )
        AND NOT EXISTS (
          SELECT 1
            FROM audit_logs a
           WHERE a.entity_type = 'sigur_employee'
             AND a.entity_id = p.sigur_employee_id::text
             AND a.created_at > m.marked_at
             AND a.details->>'action' = 'unblock'
        )`,
    [today],
  );

/** Журнал и отметки одной транзакцией: запись «unblock» даёт новый отсчёт 5 дней. */
const restoreDirectUnblock = async (row: IMarkedPassRow, runId: string): Promise<void> => {
  await withTransaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`blacklist:sigur:${row.sigur_employee_id}`]);
    await auditService.logWithClient(client, {
      user_id: null,
      action: AUDIT_ACTIONS.UPDATE_EMPLOYEE,
      entity_type: 'sigur_employee',
      entity_id: String(row.sigur_employee_id),
      details: {
        action: 'unblock',
        source: SIGUR_DIRECT_SOURCE,
        run_id: runId,
        pass_id: row.pass_id,
        holder_id: row.holder_id,
      },
    });
    await markContractorPassUnblocked(client, row.sigur_employee_id);
  });
};

/** Сверка до снимка: восстановленный пропуск не должен попасть в очередь этого же запуска. */
const reconcileDirectUnblocks = async (
  today: string,
  runId: string,
  dryRun: boolean,
  connection: ConnectionType,
  isAborted: () => boolean,
): Promise<number> => {
  const rows = await loadWalkedAfterMark(today);
  let restored = 0;
  for (const row of rows) {
    if (isAborted()) break;
    try {
      if ((await readLiveBlocked(row.sigur_employee_id, connection)) !== false) continue;
      if (!dryRun) await restoreDirectUnblock(row, runId);
      restored += 1;
    } catch (error) {
      if (isSigurNotFound(error)) continue;
      console.error(`[pass-idle-block] сверка профиля ${row.sigur_employee_id}:`, errorMessage(error));
    }
  }
  return restored;
};

const writeIdleBlockAudit = (
  client: PoolClient,
  candidate: IIdlePassRow,
  runId: string,
  triggeredBy: IRunIdleBlockParams['triggeredBy'],
  mode: 'blocked' | 'reason_only',
): Promise<void> =>
  auditService.logWithClient(client, {
    user_id: null,
    action: AUDIT_ACTIONS.UPDATE_EMPLOYEE,
    entity_type: 'sigur_employee',
    entity_id: String(candidate.sigur_employee_id),
    details: {
      action: 'block',
      reason: buildIdleBlockReason(candidate),
      source: IDLE_BLOCK_AUDIT_SOURCE,
      mode,
      run_id: runId,
      triggered_by: triggeredBy,
      pass_id: candidate.pass_id,
      holder_id: candidate.holder_id,
      pass_number: candidate.pass_number,
      last_event_date: candidate.last_event_date,
      days_idle: candidate.days_idle,
    },
  });

/** Снимает активность и ставит отметку. CAS: строки уже под FOR UPDATE, расхождение — ошибка. */
const markHolderAndDeactivate = async (
  client: PoolClient,
  candidate: IIdlePassRow,
  column: 'idle_blocked_at' | 'external_blocked_seen_at',
): Promise<void> => {
  const pass = await client.query(
    `UPDATE contractor_passes
        SET is_active = false, updated_at = now()
      WHERE id = $1::uuid AND status = 'applied' AND is_active`,
    [candidate.pass_id],
  );
  const holder = await client.query(
    `UPDATE contractor_pass_holders
        SET ${column} = now(), idle_block_failed_at = NULL
      WHERE id::text = $1
        AND pass_id = $2::uuid
        AND valid_until IS NULL
        AND idle_blocked_at IS NULL
        AND external_blocked_seen_at IS NULL`,
    [candidate.holder_id, candidate.pass_id],
  );
  if (pass.rowCount !== 1 || holder.rowCount !== 1) {
    throw new Error(`Пропуск ${candidate.pass_number} изменён во время записи`);
  }
};

const processCandidate = (
  candidate: IIdlePassRow,
  runId: string,
  today: string,
  triggeredBy: IRunIdleBlockParams['triggeredBy'],
  connection: ConnectionType,
): Promise<IdleBlockOutcome> => {
  const sigurEmployeeId = candidate.sigur_employee_id as number;
  return withTransaction(async client => {
    // Тот же ключ, что у blockEmployee и withSigurProfileGuard: операции над профилем идут по очереди.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`blacklist:sigur:${sigurEmployeeId}`]);
    const stillIdle = await lockIdleBlockCandidate(client, {
      orgDepartmentId: candidate.org_department_id,
      passId: candidate.pass_id,
      holderId: candidate.holder_id,
    }, today);
    if (!stillIdle) return 'changed';

    let blocked: boolean | null;
    try {
      blocked = await readLiveBlocked(sigurEmployeeId, connection);
    } catch (error) {
      // 422 считается «нет профиля» только на чтении: на записи это настоящая ошибка валидации.
      if (isSigurNotFound(error)) throw new SigurProfileGoneError(sigurEmployeeId);
      throw error;
    }

    if (blocked === true) {
      const info = await getSigurEmployeeBlockInfo(sigurEmployeeId);
      if (info?.reason) {
        await markHolderAndDeactivate(client, candidate, 'external_blocked_seen_at');
        return 'already_manual';
      }
      await writeIdleBlockAudit(client, candidate, runId, triggeredBy, 'reason_only');
      await markHolderAndDeactivate(client, candidate, 'idle_blocked_at');
      return 'reason_added';
    }

    await writeIdleBlockAudit(client, candidate, runId, triggeredBy, 'blocked');
    await markHolderAndDeactivate(client, candidate, 'idle_blocked_at');
    await sigurService.blockEmployee(sigurEmployeeId, connection);
    return 'blocked';
  });
};

/** Вне откатываемой транзакции: отметка ошибки отправляет пропуск в конец следующей очереди. */
const stampFailure = async (candidate: IIdlePassRow): Promise<void> => {
  try {
    await query('UPDATE contractor_pass_holders SET idle_block_failed_at = now() WHERE id::text = $1', [candidate.holder_id]);
  } catch (error) {
    console.error(`[pass-idle-block] отметка ошибки пропуска ${candidate.pass_number}:`, errorMessage(error));
  }
};

export const invalidateSigurCaches = (): void => {
  sigurService.invalidateEmployeeCache();
  invalidateSigurDirectoryCaches();
};

export const summarizeIdleBlock = (result: IIdleBlockResult): Record<string, unknown> => ({
  runId: result.runId,
  dryRun: result.dryRun,
  status: result.status,
  totalCandidates: result.totalCandidates,
  selected: result.selected,
  blocked: result.blocked,
  reasonAdded: result.reasonAdded,
  alreadyManual: result.alreadyManual,
  restored: result.restored,
  skipped: result.skipped.length,
  changed: result.changed.length,
  failed: result.failed.length,
  stoppedOnFailures: result.stoppedOnFailures,
  aborted: result.aborted,
  eventGaps: result.eventGaps,
});

export async function runContractorPassIdleBlock(params: IRunIdleBlockParams): Promise<IIdleBlockResult> {
  const { dryRun, force = false, limit = null, triggeredBy, shouldAbort } = params;
  const runId = randomUUID();
  const today = moscowTodayIso();
  const isAborted = (): boolean => shouldAbort?.() ?? false;
  const result: IIdleBlockResult = {
    runId,
    dryRun,
    status: 'completed',
    totalCandidates: 0,
    selected: 0,
    blocked: 0,
    reasonAdded: 0,
    alreadyManual: 0,
    restored: 0,
    skipped: [],
    changed: [],
    failed: [],
    stoppedOnFailures: false,
    aborted: false,
    eventGaps: [],
    candidates: [],
  };

  result.eventGaps = await findEventGaps(today);
  if (result.eventGaps.length > 0) {
    result.status = 'events_gap';
    if (!dryRun) {
      Sentry.captureMessage('contractor_pass_idle_block_events_gap', {
        level: 'warning',
        tags: { service: 'contractor-pass-idle-block' },
        extra: { runId, eventGaps: result.eventGaps },
      });
      console.log(`[pass-idle-block] ${JSON.stringify(summarizeIdleBlock(result))}`);
      return result;
    }
  }

  const connection = await sigurService.getBackgroundConnectionType();
  result.restored = await reconcileDirectUnblocks(today, runId, dryRun, connection, isAborted);

  const queue = await fetchIdleBlockCandidates(today);
  const selected = limit == null ? queue : queue.slice(0, limit);
  result.totalCandidates = queue.length;
  result.selected = selected.length;
  result.candidates = selected;

  const massStop = selected.length > IDLE_BLOCK_MAX_PER_RUN && !force;
  if (massStop && result.status === 'completed') {
    result.status = 'mass_stop';
    if (!dryRun) {
      Sentry.captureMessage('contractor_pass_idle_block_mass_stop', {
        level: 'warning',
        tags: { service: 'contractor-pass-idle-block' },
        extra: { runId, totalCandidates: queue.length, selected: selected.length },
      });
    }
  }

  if (dryRun || massStop) {
    console.log(`[pass-idle-block] ${JSON.stringify(summarizeIdleBlock(result))}`);
    return result;
  }

  let consecutiveFailures = 0;
  let exceptionReported = false;
  try {
    for (const candidate of selected) {
      if (isAborted()) {
        result.aborted = true;
        break;
      }
      try {
        const outcome = await processCandidate(candidate, runId, today, triggeredBy, connection);
        consecutiveFailures = 0;
        if (outcome === 'blocked') result.blocked += 1;
        if (outcome === 'reason_added') result.reasonAdded += 1;
        if (outcome === 'already_manual') result.alreadyManual += 1;
        if (outcome === 'changed') result.changed.push(candidate.pass_number);
      } catch (error) {
        await stampFailure(candidate);
        if (error instanceof SigurProfileGoneError) {
          result.skipped.push(candidate.pass_number);
          continue;
        }
        result.failed.push({ passNumber: candidate.pass_number, error: errorMessage(error) });
        consecutiveFailures += 1;
        if (!exceptionReported) {
          exceptionReported = true;
          Sentry.captureException(error, {
            tags: { service: 'contractor-pass-idle-block' },
            extra: { runId, passNumber: candidate.pass_number },
          });
        }
        if (consecutiveFailures >= IDLE_BLOCK_MAX_CONSECUTIVE_FAILURES) {
          result.stoppedOnFailures = true;
          break;
        }
      }
    }
  } finally {
    invalidateSigurCaches();
  }

  if (result.stoppedOnFailures || result.aborted) result.status = 'partial';
  console.log(`[pass-idle-block] ${JSON.stringify(summarizeIdleBlock(result))}`);
  return result;
}
