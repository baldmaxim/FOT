import { execute, query, queryOne } from '../config/postgres.js';
import { encryptionService } from './encryption.service.js';
import { msisdnHash, normalizeMsisdn } from './mts-business-cdr.service.js';
import { MtsBusinessApiError } from './mts-business-base.service.js';

/**
 * Персистентный «Лог синхронизации» МТС Бизнес (миграция 222):
 * mts_business_sync_runs — по строке на прогон, mts_business_sync_log — записи
 * warn/error по номерам/шагам и diff-события данных абонента.
 *
 * Правила (как auditService): любая ошибка записи глотается (console.error),
 * синки НИКОГДА не падают и не ждут лог. В message/details — БЕЗ ПДн
 * (паспорт/дата рождения не попадают; mts_fio/mts_comment хранятся открыто).
 * Номер — только hash+enc, как во всех таблицах модуля.
 */

export type MtsSyncJob = 'refresh_all' | 'cdr_daily' | 'metrics_daily' | 'catalog_weekly' | 'rolling';
export type MtsSyncRunStatus = 'ok' | 'partial' | 'error' | 'interrupted';
export type MtsSyncLogLevel = 'info' | 'warn' | 'error';

export interface IMtsSyncLogEntry {
  level: MtsSyncLogLevel;
  step?: string | null;
  accountId?: string | null;
  /** Сырой номер: сервис сам делает hash + enc; в открытом виде не хранится. */
  msisdn?: string | null;
  errorCode?: string | null;
  bucket?: string | null;
  message: string;
  details?: Record<string, unknown> | null;
}

export interface IMtsSyncRunLogger {
  /** null — startRun не смог записать прогон, все методы no-op. */
  runId: string | null;
  log(entry: IMtsSyncLogEntry): Promise<void>;
  finish(
    status: MtsSyncRunStatus,
    opts?: { summary?: string | null; stats?: Record<string, unknown> | null; error?: string | null },
  ): Promise<void>;
}

/**
 * Записать изменения ФИО из МТС (diff от syncMtsNames): привязанный к сотруднику
 * номер — warn (расхождение стоит заметить), остальные — info.
 */
export const logFioChanges = async (
  log: IMtsSyncRunLogger | undefined,
  accountId: string | null,
  changes: Array<{ msisdn: string; oldFio: string; newFio: string; linkedEmployeeId: number | null }> | undefined,
): Promise<void> => {
  for (const c of changes ?? []) {
    await log?.log(c.linkedEmployeeId != null
      ? {
          level: 'warn', step: 'fio_diff', msisdn: c.msisdn, accountId,
          message: 'ФИО в МТС изменилось у привязанного номера',
          details: { fio: { old: c.oldFio, new: c.newFio }, employeeId: c.linkedEmployeeId },
        }
      : {
          level: 'info', step: 'fio_diff', msisdn: c.msisdn, accountId,
          message: 'ФИО в МТС изменилось',
          details: { fio: { old: c.oldFio, new: c.newFio } },
        });
  }
};

/** '401/1014' из MtsBusinessApiError; null — не API-ошибка. */
export const mtsErrorCodeOf = (error: unknown): string | null => {
  if (!(error instanceof MtsBusinessApiError)) return null;
  if (error.status <= 0) return null;
  return error.code ? `${error.status}/${error.code}` : String(error.status);
};

// Кап записей на прогон: «МТС лёг × 1500 номеров» не должен раздувать таблицу.
const MAX_ENTRIES_PER_RUN = 500;
const RETENTION_DAYS = 60;

// Суточный гард оппортунистической чистки (любой ночной шедулер вызывает
// startRun → чистка гарантированно ежедневная без отдельного таймера).
let lastCleanupYmd = '';

const runCleanupIfDue = (): void => {
  const ymd = new Date().toISOString().slice(0, 10);
  if (ymd === lastCleanupYmd) return;
  lastCleanupYmd = ymd;
  void (async () => {
    try {
      // Строки с run_id чистятся каскадом от runs; отдельный DELETE по log
      // добирает standalone-строки (run_id IS NULL) от rolling-конвейера.
      const logs = await execute(
        `DELETE FROM mts_business_sync_log WHERE at < now() - make_interval(days => $1)`,
        [RETENTION_DAYS],
      );
      const runs = await execute(
        `DELETE FROM mts_business_sync_runs WHERE started_at < now() - make_interval(days => $1)`,
        [RETENTION_DAYS],
      );
      if (logs > 0 || runs > 0) {
        console.log(`[mts-biz-sync-log] retention: удалено прогонов=${runs}, записей=${logs}`);
      }
    } catch (error) {
      console.error('[mts-biz-sync-log] retention-чистка не удалась:', error);
    }
  })();
};

const insertEntry = async (job: MtsSyncJob, runId: string | null, entry: IMtsSyncLogEntry): Promise<void> => {
  const hash = entry.msisdn ? msisdnHash(entry.msisdn) : null;
  const norm = entry.msisdn ? normalizeMsisdn(entry.msisdn) : null;
  await execute(
    `INSERT INTO mts_business_sync_log
       (run_id, level, job, step, account_id, msisdn_hash, msisdn_enc, error_code, bucket, message, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      runId,
      entry.level,
      job,
      entry.step ?? null,
      entry.accountId ?? null,
      hash,
      norm ? encryptionService.encrypt(norm) : null,
      entry.errorCode ?? null,
      entry.bucket ?? null,
      entry.message,
      entry.details != null ? JSON.stringify(entry.details) : null,
    ],
  );
};

class RunLogger implements IMtsSyncRunLogger {
  private entryCount = 0;
  private droppedCount = 0;

  constructor(
    public readonly runId: string | null,
    private readonly job: MtsSyncJob,
  ) {}

  async log(entry: IMtsSyncLogEntry): Promise<void> {
    if (this.runId == null) return;
    if (this.entryCount >= MAX_ENTRIES_PER_RUN) {
      this.droppedCount++;
      return;
    }
    this.entryCount++;
    try {
      await insertEntry(this.job, this.runId, entry);
    } catch (error) {
      console.error('[mts-biz-sync-log] запись лога не удалась:', error);
    }
  }

  async finish(
    status: MtsSyncRunStatus,
    opts?: { summary?: string | null; stats?: Record<string, unknown> | null; error?: string | null },
  ): Promise<void> {
    if (this.runId == null) return;
    try {
      if (this.droppedCount > 0) {
        await insertEntry(this.job, this.runId, {
          level: 'warn',
          step: 'log_cap',
          message: `Ещё ${this.droppedCount} записей свёрнуто (лимит ${MAX_ENTRIES_PER_RUN} на прогон)`,
        });
      }
      await execute(
        `UPDATE mts_business_sync_runs
            SET status = $2, finished_at = now(), summary = $3, stats = $4, error = $5
          WHERE id = $1`,
        [
          this.runId,
          status,
          opts?.summary ?? null,
          opts?.stats != null ? JSON.stringify(opts.stats) : null,
          opts?.error ?? null,
        ],
      );
    } catch (error) {
      console.error('[mts-biz-sync-log] завершение прогона не записалось:', error);
    }
  }
}

export interface IMtsSyncRunRow {
  id: string;
  job: string;
  initiator: string;
  accountId: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  summary: string | null;
  stats: Record<string, unknown> | null;
  error: string | null;
}

export interface IMtsSyncLogRow {
  id: number;
  runId: string | null;
  at: string;
  level: string;
  job: string;
  step: string | null;
  accountId: string | null;
  msisdn: string | null;
  errorCode: string | null;
  bucket: string | null;
  message: string;
  details: Record<string, unknown> | null;
}

export interface IMtsSyncRunFilters {
  limit: number;
  offset: number;
  job?: string;
  status?: string;
  onlyProblems?: boolean;
}

class MtsBusinessSyncLogService {
  /** Начать прогон. При ошибке БД возвращает no-op-хэндл (runId=null). */
  async startRun(opts: {
    job: MtsSyncJob;
    initiator: 'manual' | 'schedule';
    accountId?: string | null;
  }): Promise<IMtsSyncRunLogger> {
    runCleanupIfDue();
    try {
      const row = await queryOne<{ id: string }>(
        `INSERT INTO mts_business_sync_runs (job, initiator, account_id)
         VALUES ($1, $2, $3) RETURNING id`,
        [opts.job, opts.initiator, opts.accountId ?? null],
      );
      return new RunLogger(row?.id ?? null, opts.job);
    } catch (error) {
      console.error('[mts-biz-sync-log] старт прогона не записался:', error);
      return new RunLogger(null, opts.job);
    }
  }

  /** Одиночная запись без прогона (rolling-конвейер): run_id = NULL. */
  async logStandalone(job: MtsSyncJob, entry: IMtsSyncLogEntry): Promise<void> {
    try {
      await insertEntry(job, null, entry);
    } catch (error) {
      console.error('[mts-biz-sync-log] standalone-запись не удалась:', error);
    }
  }

  /**
   * Закрыть осиротевшие running-прогоны джоба. Вызывается сразу после захвата
   * lease этого джоба: раз lease взят — никакой другой инстанс этот джоб сейчас
   * не выполняет, значит все его «running»-прогоны убиты рестартом/деплоем.
   */
  async closeOrphanRunningRuns(job: MtsSyncJob): Promise<void> {
    try {
      const n = await execute(
        `UPDATE mts_business_sync_runs
            SET status = 'interrupted', finished_at = now(),
                error = COALESCE(error, 'Прерван (рестарт сервера или деплой)')
          WHERE job = $1 AND status = 'running'`,
        [job],
      );
      if (n > 0) console.warn(`[mts-biz-sync-log] job=${job}: закрыто осиротевших прогонов: ${n}`);
    } catch (error) {
      console.error('[mts-biz-sync-log] closeOrphanRunningRuns не удался:', error);
    }
  }

  /** На старте сервера: зависшие running-прогоны (>2 ч) → interrupted. */
  async reconcileInterruptedRuns(): Promise<void> {
    try {
      const n = await execute(
        `UPDATE mts_business_sync_runs
            SET status = 'interrupted', finished_at = now(),
                error = COALESCE(error, 'Прерван рестартом сервера')
          WHERE status = 'running' AND started_at < now() - interval '2 hours'`,
      );
      if (n > 0) console.warn(`[mts-biz-sync-log] помечено прерванных прогонов: ${n}`);
    } catch (error) {
      console.error('[mts-biz-sync-log] reconcile не удался:', error);
    }
  }

  async listRuns(filters: IMtsSyncRunFilters): Promise<{ runs: IMtsSyncRunRow[]; total: number }> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filters.job) {
      params.push(filters.job);
      where.push(`job = $${params.length}`);
    }
    if (filters.status) {
      params.push(filters.status);
      where.push(`status = $${params.length}`);
    } else if (filters.onlyProblems) {
      where.push(`status IN ('partial', 'error', 'interrupted')`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const totalRow = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM mts_business_sync_runs ${whereSql}`,
      params,
    );
    params.push(filters.limit, filters.offset);
    const rows = await query<{
      id: string; job: string; initiator: string; account_id: string | null;
      started_at: string; finished_at: string | null; status: string;
      summary: string | null; stats: Record<string, unknown> | null; error: string | null;
    }>(
      `SELECT id, job, initiator, account_id, started_at, finished_at, status, summary, stats, error
         FROM mts_business_sync_runs ${whereSql}
        ORDER BY started_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return {
      runs: rows.map(r => ({
        id: r.id,
        job: r.job,
        initiator: r.initiator,
        accountId: r.account_id,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        status: r.status,
        summary: r.summary,
        stats: r.stats,
        error: r.error,
      })),
      total: Number(totalRow?.count ?? 0),
    };
  }

  /** Записи прогона; runId=null — standalone-строки rolling-конвейера. */
  async listEntries(
    runId: string | null,
    opts: { limit: number; offset: number; level?: string },
  ): Promise<{ entries: IMtsSyncLogRow[]; total: number }> {
    const where: string[] = [runId == null ? 'run_id IS NULL' : 'run_id = $1'];
    const params: unknown[] = runId == null ? [] : [runId];
    if (opts.level === 'problems') {
      where.push(`level <> 'info'`);
    } else if (opts.level) {
      params.push(opts.level);
      where.push(`level = $${params.length}`);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const totalRow = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM mts_business_sync_log ${whereSql}`,
      params,
    );
    params.push(opts.limit, opts.offset);
    const rows = await query<{
      id: number; run_id: string | null; at: string; level: string; job: string;
      step: string | null; account_id: string | null; msisdn_enc: string | null;
      error_code: string | null; bucket: string | null; message: string;
      details: Record<string, unknown> | null;
    }>(
      `SELECT id, run_id, at, level, job, step, account_id, msisdn_enc, error_code, bucket, message, details
         FROM mts_business_sync_log ${whereSql}
        ORDER BY id ${runId == null ? 'DESC' : 'ASC'}
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return {
      entries: rows.map(r => ({
        id: Number(r.id),
        runId: r.run_id,
        at: r.at,
        level: r.level,
        job: r.job,
        step: r.step,
        accountId: r.account_id,
        msisdn: r.msisdn_enc ? encryptionService.decryptField(r.msisdn_enc) : null,
        errorCode: r.error_code,
        bucket: r.bucket,
        message: r.message,
        details: r.details,
      })),
      total: Number(totalRow?.count ?? 0),
    };
  }
}

export const mtsBusinessSyncLogService = new MtsBusinessSyncLogService();
