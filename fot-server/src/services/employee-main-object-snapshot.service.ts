/**
 * Снимок «основного объекта» сотрудников (миграция 277): объект с наибольшими часами
 * по СКУД и корректировкам за 30 полных дней — вчера и 29 дней до него по Москве.
 *
 * Расчёт тяжёлый (~25 с на организацию), поэтому идёт раз в сутки ночью
 * (employee-main-object-snapshot.scheduler), а «Экспорт сотрудников» и столбец «Объект»
 * читают готовое. Алгоритм тот же — loadMainObjectDetailedByEmployee.
 *
 * Запись атомарна: DELETE всего снимка + INSERT нового в одной транзакции. Сбой расчёта
 * или записи оставляет прошлый снимок нетронутым, запуск помечается в журнале как error.
 */
import { execute, query, queryOne, withTransaction } from '../config/postgres.js';
import { moscowTodayIso } from '../utils/date.utils.js';
import {
  loadMainObjectByEmployee,
  loadMainObjectDetailedByEmployee,
  type IMainObject,
} from './employees-export-objects.service.js';
import type { IExportPeriod } from './employees-export.service.js';

/** Длина периода в календарных днях. */
export const SNAPSHOT_PERIOD_DAYS = 30;

/** Advisory-lock записи снимка: исключает два одновременных пересчёта. */
export const SNAPSHOT_LOCK_KEY = 277_0001;

/** Строк на один INSERT: держит размер параметров запроса в разумных пределах. */
const INSERT_BATCH_SIZE = 5000;

const shiftIsoDate = (iso: string, days: number): string => {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

/** Полные сутки: вчера (МСК) и 29 дней до него. Сегодняшний неполный день не входит. */
export function resolveSnapshotPeriod(now: Date = new Date()): IExportPeriod {
  const end = shiftIsoDate(moscowTodayIso(now), -1);
  return { start: shiftIsoDate(end, -(SNAPSHOT_PERIOD_DAYS - 1)), end };
}

export interface ISnapshotRun {
  id: number;
  period: IExportPeriod;
  finishedAt: string | null;
}

/** Последний успешный расчёт или null, если снимка ещё нет. */
export async function loadLatestSnapshotRun(): Promise<ISnapshotRun | null> {
  const row = await queryOne<{ id: number | string; period_start: string; period_end: string; finished_at: string | null }>(
    `SELECT id, to_char(period_start, 'YYYY-MM-DD') AS period_start,
            to_char(period_end, 'YYYY-MM-DD') AS period_end, finished_at
       FROM employee_main_object_snapshot_runs
      WHERE status = 'ok'
      ORDER BY period_end DESC, id DESC
      LIMIT 1`,
  );
  if (!row) return null;
  return {
    id: Number(row.id),
    period: { start: row.period_start, end: row.period_end },
    finishedAt: row.finished_at,
  };
}

/**
 * Основной объект из снимка для набора сотрудников. null — снимка ещё нет (миграция
 * применена, первый расчёт не прошёл): вызывающий решает, считать ли на лету.
 */
export async function loadMainObjectsFromSnapshot(
  employeeIds: readonly number[],
): Promise<{ period: IExportPeriod; objects: Map<number, string> } | null> {
  const run = await loadLatestSnapshotRun();
  if (!run) return null;

  const objects = new Map<number, string>();
  const ids = [...new Set(employeeIds.filter(id => Number.isInteger(id) && id > 0))];
  if (ids.length > 0) {
    const rows = await query<{ employee_id: number | string; object_name: string }>(
      'SELECT employee_id, object_name FROM employee_main_object_snapshot WHERE employee_id = ANY($1::int[])',
      [ids],
    );
    for (const row of rows) objects.set(Number(row.employee_id), row.object_name);
  }
  return { period: run.period, objects };
}

export interface IMainObjectsResult {
  period: IExportPeriod;
  objects: Map<number, string>;
  source: 'snapshot' | 'live';
}

/**
 * Основной объект для потребителей (Excel, столбец «Объект»): из снимка, а пока его
 * нет (миграция применена, первый расчёт не прошёл) — расчётом на лету за livePeriod.
 */
export async function loadMainObjects(
  employeeIds: number[],
  livePeriod: IExportPeriod,
): Promise<IMainObjectsResult> {
  const snapshot = await loadMainObjectsFromSnapshot(employeeIds);
  if (snapshot) return { ...snapshot, source: 'snapshot' };
  const objects = employeeIds.length > 0
    ? await loadMainObjectByEmployee(employeeIds, livePeriod)
    : new Map<number, string>();
  return { period: livePeriod, objects, source: 'live' };
}

export interface IRebuildResult {
  period: IExportPeriod;
  employees: number;
  withObject: number;
  durationMs: number;
  /** dryRun — расчёт без записи в БД. */
  dryRun: boolean;
  /** Только при dryRun: результат для сверки. */
  preview?: Map<number, IMainObject>;
}

/**
 * Охват снимка — все, кого могут показать «Управление кадрами» и Excel-выгрузка:
 * не архивные работающие + уволенные не раньше начала периода.
 */
async function loadSnapshotEmployeeIds(period: IExportPeriod): Promise<number[]> {
  const rows = await query<{ id: number | string }>(
    `SELECT id FROM employees
      WHERE is_archived = false
        AND (employment_status <> 'fired' OR dismissal_date >= $1::date)
      ORDER BY id`,
    [period.start],
  );
  return rows.map(row => Number(row.id));
}

export async function rebuildMainObjectSnapshot(
  options: { now?: Date; dryRun?: boolean } = {},
): Promise<IRebuildResult> {
  const startedAt = Date.now();
  const period = resolveSnapshotPeriod(options.now);
  const dryRun = options.dryRun === true;

  let runId: number | null = null;
  if (!dryRun) {
    const run = await queryOne<{ id: number | string }>(
      `INSERT INTO employee_main_object_snapshot_runs (period_start, period_end, status)
       VALUES ($1::date, $2::date, 'running') RETURNING id`,
      [period.start, period.end],
    );
    runId = run ? Number(run.id) : null;
  }

  try {
    const employeeIds = await loadSnapshotEmployeeIds(period);
    const mains = await loadMainObjectDetailedByEmployee(employeeIds, period);
    const durationMs = () => Date.now() - startedAt;

    if (dryRun) {
      return { period, employees: employeeIds.length, withObject: mains.size, durationMs: durationMs(), dryRun, preview: mains };
    }

    const entries = [...mains.entries()];
    await withTransaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [SNAPSHOT_LOCK_KEY]);
      await client.query('DELETE FROM employee_main_object_snapshot');
      for (let index = 0; index < entries.length; index += INSERT_BATCH_SIZE) {
        const batch = entries.slice(index, index + INSERT_BATCH_SIZE);
        // JOIN employees: сотрудника могли удалить за время расчёта — его строку пропускаем,
        // а не роняем всю запись на внешнем ключе.
        await client.query(
          `INSERT INTO employee_main_object_snapshot
             (employee_id, skud_object_id, object_name, hours, period_start, period_end)
           SELECT u.employee_id, u.skud_object_id, u.object_name, u.hours, $5::date, $6::date
             FROM unnest($1::int[], $2::uuid[], $3::text[], $4::numeric[])
                  AS u(employee_id, skud_object_id, object_name, hours)
             JOIN employees e ON e.id = u.employee_id`,
          [
            batch.map(([employeeId]) => employeeId),
            batch.map(([, main]) => main.objectId),
            batch.map(([, main]) => main.objectName),
            batch.map(([, main]) => main.hours),
            period.start,
            period.end,
          ],
        );
      }
      if (runId !== null) {
        await client.query(
          `UPDATE employee_main_object_snapshot_runs
              SET status = 'ok', finished_at = now(), employees = $2, with_object = $3, duration_ms = $4
            WHERE id = $1`,
          [runId, employeeIds.length, mains.size, durationMs()],
        );
      }
    });

    return { period, employees: employeeIds.length, withObject: mains.size, durationMs: durationMs(), dryRun };
  } catch (error) {
    if (runId !== null) {
      const message = error instanceof Error ? error.message : String(error);
      await execute(
        `UPDATE employee_main_object_snapshot_runs
            SET status = 'error', finished_at = now(), duration_ms = $2, error = $3
          WHERE id = $1`,
        [runId, Date.now() - startedAt, message.slice(0, 2000)],
      ).catch((markError: unknown) => {
        console.error('[main-object-snapshot] не удалось отметить сбой запуска:', markError);
      });
    }
    throw error;
  }
}
