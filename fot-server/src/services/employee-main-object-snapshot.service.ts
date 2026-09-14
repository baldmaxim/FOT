/**
 * Снимок «основного объекта» (миграция 277) и часов по всем объектам (миграция 279):
 * по СКУД и корректировкам за 30 полных дней — вчера и 29 дней до него по Москве.
 *
 * Расчёт тяжёлый (~25 с на организацию), поэтому идёт раз в сутки ночью
 * (employee-main-object-snapshot.scheduler), а «Экспорт сотрудников», столбцы «Объект»
 * и «Статья затрат» читают готовое. Алгоритм тот же — loadObjectHoursByEmployee.
 *
 * Поколения. Каждый запуск получает id при старте; строки обеих таблиц снимка несут run_id,
 * а активное поколение задаёт employee_main_object_snapshot_state.active_run_id. Публикация —
 * одна транзакция под advisory-lock: проверка порядка поколений → DELETE обеих таблиц →
 * INSERT → run ok + object_hours_ready → перевод указателя. Расчёт, устаревший к моменту
 * публикации (более поздний период или тот же период, но запущенный позже, уже опубликован),
 * помечается superseded и снимок не трогает. Любой сбой — ROLLBACK, прошлое поколение цело.
 */
import type { PoolClient } from 'pg';
import { execute, query, queryOne, withReadOnlySnapshot, withTransaction } from '../config/postgres.js';
import { moscowTodayIso } from '../utils/date.utils.js';
import {
  compareObjectHours,
  loadObjectHoursByEmployee,
  mainObjectsFromLists,
  type IMainObject,
} from './employees-export-objects.service.js';
import type { IExportPeriod } from './employees-export.service.js';

/** Длина периода в календарных днях. */
export const SNAPSHOT_PERIOD_DAYS = 30;

/** Advisory-lock публикации снимка: сериализует запись конкурирующих пересчётов. */
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

interface IRunRow {
  id: number | string;
  period_start: string;
  period_end: string;
  finished_at: string | null;
}

/** Активное поколение: указатель state → запуск ok с готовыми обеими таблицами. */
const ACTIVE_RUN_SQL = `
  SELECT r.id, to_char(r.period_start, 'YYYY-MM-DD') AS period_start,
         to_char(r.period_end, 'YYYY-MM-DD') AS period_end, r.finished_at
    FROM employee_main_object_snapshot_state s
    JOIN employee_main_object_snapshot_runs r ON r.id = s.active_run_id
   WHERE s.singleton AND r.status = 'ok' AND r.object_hours_ready`;

const toRun = (row: IRunRow): ISnapshotRun => ({
  id: Number(row.id),
  period: { start: row.period_start, end: row.period_end },
  finishedAt: row.finished_at,
});

/** Опубликованное поколение или null, если снимка новой версии ещё нет. */
export async function loadActiveSnapshotRun(): Promise<ISnapshotRun | null> {
  const row = await queryOne<IRunRow>(ACTIVE_RUN_SQL);
  return row ? toRun(row) : null;
}

export interface ISnapshotData {
  run: ISnapshotRun;
  /** employee_id → название основного объекта. */
  objects: Map<number, string>;
  /** employee_id → объекты с часами, порядок compareObjectHours. Нет ключа — часов нет. */
  objectLists: Map<number, IMainObject[]>;
}

/**
 * Снимок для набора сотрудников из ОДНОГО состояния БД: указатель, основной объект и
 * списки читаются в REPEATABLE READ, поэтому публикация между запросами их не разведёт.
 * null — опубликованного поколения нет, вызывающий решает, считать ли на лету.
 */
export async function loadSnapshotData(employeeIds: readonly number[]): Promise<ISnapshotData | null> {
  const ids = [...new Set(employeeIds.filter(id => Number.isInteger(id) && id > 0))];

  return withReadOnlySnapshot(async client => {
    const runRow = (await client.query<IRunRow>(ACTIVE_RUN_SQL)).rows[0];
    if (!runRow) return null;
    const run = toRun(runRow);

    const objects = new Map<number, string>();
    const objectLists = new Map<number, IMainObject[]>();
    if (ids.length === 0) return { run, objects, objectLists };

    const mainRows = (await client.query<{ employee_id: number | string; object_name: string }>(
      `SELECT employee_id, object_name FROM employee_main_object_snapshot
        WHERE run_id = $1 AND employee_id = ANY($2::int[])`,
      [run.id, ids],
    )).rows;
    for (const row of mainRows) objects.set(Number(row.employee_id), row.object_name);

    const hourRows = (await client.query<{
      employee_id: number | string; skud_object_id: string; object_name: string; hours: string | number;
    }>(
      `SELECT employee_id, skud_object_id::text AS skud_object_id, object_name, hours
         FROM employee_object_hours_snapshot
        WHERE run_id = $1 AND employee_id = ANY($2::int[])`,
      [run.id, ids],
    )).rows;
    for (const row of hourRows) {
      const employeeId = Number(row.employee_id);
      const item: IMainObject = { objectId: row.skud_object_id, objectName: row.object_name, hours: Number(row.hours) };
      const list = objectLists.get(employeeId);
      if (list) list.push(item);
      else objectLists.set(employeeId, [item]);
    }
    for (const list of objectLists.values()) list.sort(compareObjectHours);

    return { run, objects, objectLists };
  });
}

export interface IMainObjectsResult {
  period: IExportPeriod;
  objects: Map<number, string>;
  /** employee_id → названия объектов с часами за период, от большего к меньшему. */
  objectNamesByEmployee: Map<number, string[]>;
  source: 'snapshot' | 'live';
}

const namesOf = (lists: Map<number, IMainObject[]>): Map<number, string[]> => {
  const result = new Map<number, string[]>();
  for (const [employeeId, list] of lists) result.set(employeeId, list.map(item => item.objectName));
  return result;
};

/**
 * Объекты для потребителей (Excel, столбцы «Объект» и «Статья затрат»): из опубликованного
 * поколения, а пока его нет — целиком расчётом на лету за livePeriod (основной объект и
 * списки из одного расчёта, чтобы не смешивать периоды и источники).
 */
export async function loadMainObjects(
  employeeIds: number[],
  livePeriod: IExportPeriod,
): Promise<IMainObjectsResult> {
  const snapshot = await loadSnapshotData(employeeIds);
  if (snapshot) {
    return {
      period: snapshot.run.period,
      objects: snapshot.objects,
      objectNamesByEmployee: namesOf(snapshot.objectLists),
      source: 'snapshot',
    };
  }

  const lists = employeeIds.length > 0
    ? await loadObjectHoursByEmployee(employeeIds, livePeriod)
    : new Map<number, IMainObject[]>();
  const objects = new Map<number, string>();
  for (const [employeeId, main] of mainObjectsFromLists(lists)) objects.set(employeeId, main.objectName);
  return { period: livePeriod, objects, objectNamesByEmployee: namesOf(lists), source: 'live' };
}

export interface IRebuildResult {
  period: IExportPeriod;
  employees: number;
  withObject: number;
  durationMs: number;
  /** dryRun — расчёт без записи в БД. */
  dryRun: boolean;
  /** false — расчёт устарел к публикации (superseded), активное поколение не менялось. */
  published: boolean;
  /** Только при dryRun: результат для сверки. */
  preview?: Map<number, IMainObject>;
  previewLists?: Map<number, IMainObject[]>;
}

export interface IGeneration {
  runId: number;
  /** YYYY-MM-DD. */
  periodEnd: string;
}

/**
 * Можно ли публиковать candidate поверх active. Более поздний период побеждает; при равном
 * периоде — запуск с большим id (id выдаётся при старте), так расчёт, начавшийся раньше,
 * не перезапишет уже опубликованный более поздний.
 */
export function isNewerGeneration(candidate: IGeneration, active: IGeneration | null): boolean {
  if (!active) return true;
  if (candidate.periodEnd !== active.periodEnd) return candidate.periodEnd > active.periodEnd;
  return candidate.runId > active.runId;
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

async function publishSnapshot(
  client: PoolClient,
  params: {
    runId: number;
    period: IExportPeriod;
    lists: Map<number, IMainObject[]>;
    mains: Map<number, IMainObject>;
    employees: number;
    durationMs: () => number;
  },
): Promise<boolean> {
  const { runId, period, lists, mains, employees, durationMs } = params;

  await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [SNAPSHOT_LOCK_KEY]);
  const state = (await client.query<{ active_run_id: number | string | null; period_end: string | null }>(
    `SELECT s.active_run_id, to_char(r.period_end, 'YYYY-MM-DD') AS period_end
       FROM employee_main_object_snapshot_state s
       LEFT JOIN employee_main_object_snapshot_runs r ON r.id = s.active_run_id
      WHERE s.singleton
      FOR UPDATE OF s`,
  )).rows[0];
  if (!state) throw new Error('Нет строки employee_main_object_snapshot_state (миграция 279 не применена?)');

  const active = state.active_run_id !== null && state.period_end !== null
    ? { runId: Number(state.active_run_id), periodEnd: state.period_end }
    : null;
  if (!isNewerGeneration({ runId, periodEnd: period.end }, active)) {
    await client.query(
      `UPDATE employee_main_object_snapshot_runs
          SET status = 'superseded', finished_at = now(), duration_ms = $2, error = $3
        WHERE id = $1`,
      [runId, durationMs(), `Опубликовано более свежее поколение: run ${active?.runId}`],
    );
    return false;
  }

  await client.query('DELETE FROM employee_main_object_snapshot');
  await client.query('DELETE FROM employee_object_hours_snapshot');

  const mainEntries = [...mains.entries()];
  for (let index = 0; index < mainEntries.length; index += INSERT_BATCH_SIZE) {
    const batch = mainEntries.slice(index, index + INSERT_BATCH_SIZE);
    // JOIN employees: сотрудника могли удалить за время расчёта — его строку пропускаем,
    // а не роняем всю запись на внешнем ключе.
    await client.query(
      `INSERT INTO employee_main_object_snapshot
         (employee_id, skud_object_id, object_name, hours, period_start, period_end, run_id)
       SELECT u.employee_id, u.skud_object_id, u.object_name, u.hours, $5::date, $6::date, $7::bigint
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
        runId,
      ],
    );
  }

  const objectRows: Array<[number, IMainObject]> = [];
  for (const [employeeId, list] of lists) {
    for (const item of list) objectRows.push([employeeId, item]);
  }
  for (let index = 0; index < objectRows.length; index += INSERT_BATCH_SIZE) {
    const batch = objectRows.slice(index, index + INSERT_BATCH_SIZE);
    await client.query(
      `INSERT INTO employee_object_hours_snapshot
         (employee_id, skud_object_id, object_name, hours, run_id)
       SELECT u.employee_id, u.skud_object_id, u.object_name, u.hours, $5::bigint
         FROM unnest($1::int[], $2::uuid[], $3::text[], $4::numeric[])
              AS u(employee_id, skud_object_id, object_name, hours)
         JOIN employees e ON e.id = u.employee_id`,
      [
        batch.map(([employeeId]) => employeeId),
        batch.map(([, item]) => item.objectId),
        batch.map(([, item]) => item.objectName),
        batch.map(([, item]) => item.hours),
        runId,
      ],
    );
  }

  await client.query(
    `UPDATE employee_main_object_snapshot_runs
        SET status = 'ok', object_hours_ready = true, finished_at = now(),
            employees = $2, with_object = $3, duration_ms = $4
      WHERE id = $1`,
    [runId, employees, mains.size, durationMs()],
  );
  await client.query(
    `UPDATE employee_main_object_snapshot_state
        SET active_run_id = $1, published_at = now()
      WHERE singleton`,
    [runId],
  );
  return true;
}

export async function rebuildMainObjectSnapshot(
  options: { now?: Date; dryRun?: boolean } = {},
): Promise<IRebuildResult> {
  const startedAt = Date.now();
  const period = resolveSnapshotPeriod(options.now);
  const dryRun = options.dryRun === true;
  const durationMs = () => Date.now() - startedAt;

  let runId: number | null = null;
  if (!dryRun) {
    const run = await queryOne<{ id: number | string }>(
      `INSERT INTO employee_main_object_snapshot_runs (period_start, period_end, status)
       VALUES ($1::date, $2::date, 'running') RETURNING id`,
      [period.start, period.end],
    );
    if (!run) throw new Error('Не удалось создать запись журнала пересчёта снимка');
    runId = Number(run.id);
  }

  try {
    const employeeIds = await loadSnapshotEmployeeIds(period);
    const lists = await loadObjectHoursByEmployee(employeeIds, period);
    const mains = mainObjectsFromLists(lists);

    if (dryRun || runId === null) {
      return {
        period, employees: employeeIds.length, withObject: mains.size, durationMs: durationMs(),
        dryRun: true, published: false, preview: mains, previewLists: lists,
      };
    }

    const publishRunId = runId;
    const published = await withTransaction(client => publishSnapshot(client, {
      runId: publishRunId, period, lists, mains, employees: employeeIds.length, durationMs,
    }));

    return { period, employees: employeeIds.length, withObject: mains.size, durationMs: durationMs(), dryRun, published };
  } catch (error) {
    if (runId !== null) {
      const message = error instanceof Error ? error.message : String(error);
      await execute(
        `UPDATE employee_main_object_snapshot_runs
            SET status = 'error', finished_at = now(), duration_ms = $2, error = $3
          WHERE id = $1`,
        [runId, durationMs(), message.slice(0, 2000)],
      ).catch((markError: unknown) => {
        console.error('[main-object-snapshot] не удалось отметить сбой запуска:', markError);
      });
    }
    throw error;
  }
}
