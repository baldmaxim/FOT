// Пересборка материализованных данных после смены типа зоны точки доступа (миграция 305).
//
// Смена типа зоны меняет расчёт часов у всех, кто ходил через точку. Живой табель считает пары
// на лету, но опирается на сохранённое: skud_daily_summary (первый вход, перерыв, обеденный
// вычет) и skud_travel_segments («Дорога»). Если их не пересобрать, день получится «гибридом» —
// новые пары со старым обедом. Именно так выглядел октябрь после инцидента 12.10.2026.
//
// Ядро reconcileAccessPointZone идемпотентно и принимает ЯВНЫЙ план: какие пары сводки
// пересчитать, за какой диапазон пересобрать «Дорогу», за какой — пометить версии для 1С.
// Штатная смена типа и разовое восстановление после инцидента строят разные планы
// (scripts/reconcile-access-point-zone.ts), поэтому диапазоны не выводятся из одной даты.
//
// Очередь skud_access_point_zone_reconcile: задача создаётся в одной транзакции со сменой типа,
// воркер забирает её арендой (FOR UPDATE SKIP LOCKED — образец hr-ocr/worker.ts). Пересборка
// не идёт внутри HTTP-запроса: на крупной точке это тысячи пересчётов.

import * as Sentry from '@sentry/node';
import { execute, getPool, query, withTransaction } from '../config/postgres.js';
import { moscowTodayIso } from '../utils/date.utils.js';
import { auditService } from './audit.service.js';
import { invalidateInternalPointsCache } from './skud-shared.service.js';
import { notifySkudRealtimeChanged } from './skud-realtime.service.js';
import { calculateAndSyncTravelSegments, invalidateTravelSegmentsCache } from './skud-travel.service.js';
import { markVersionDirtyForOperatorRebuild } from './timesheet-version-maintenance.js';

const SUMMARY_BATCH = 200;
const TICK_MS = 60_000;
const STARTUP_DELAY_MS = 20_000;
const LEASE_MINUTES = 30;
const MAX_ATTEMPTS = 5;

export interface IZoneReconcilePlan {
  accessPointName: string;
  /** Пары сводки к пересчёту; batch_recalculate_skud_daily_summary сам добавляет день D−1. */
  summaryPairs: Array<{ emp_id: number; date: string }>;
  /**
   * Пары, пересчитываемые ровно за свой день, без D−1. Нужны разовому восстановлению: строки
   * закрытых месяцев чинятся точечно, соседние дни остаются нетронутыми.
   */
  summaryExactPairs?: Array<{ emp_id: number; date: string }>;
  /** «Дорога» пересобирается целиком за диапазон у этих сотрудников. */
  travelEmployeeIds: number[];
  travelFrom: string;
  travelTo: string;
  /** Диапазон закрытых подач, помечаемых на новую редакцию для 1С; null — версии не трогать. */
  versionsFrom: string | null;
  versionsTo: string | null;
}

export interface ILostTravelDecision {
  employee_id: number;
  work_date: string;
  exit_time: string;
  entry_time: string;
  from_access_point_name: string | null;
  to_access_point_name: string | null;
  status: string;
  approved_by: string | null;
  approved_at: string | null;
  approval_comment: string | null;
}

export interface IZoneReconcileResult {
  summaryPairs: number;
  /** Строк сводки, значения которых реально изменились (повторный прогон даёт 0). */
  summaryChanged: number;
  travelEmployees: number;
  /** Сегментов «Дороги», добавленных, исчезнувших или сменивших зачёт. */
  travelChanged: number;
  lostTravelDecisions: ILostTravelDecision[];
  markedApprovalIds: number[];
}

const shiftDay = (date: string, days: number): string =>
  new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);

const travelKey = (row: Pick<ILostTravelDecision, 'employee_id' | 'work_date' | 'exit_time' | 'entry_time' | 'from_access_point_name' | 'to_access_point_name'>): string =>
  [Number(row.employee_id), String(row.work_date).slice(0, 10), String(row.exit_time).slice(0, 8), String(row.entry_time).slice(0, 8),
    row.from_access_point_name ?? '', row.to_access_point_name ?? ''].join('|');

/** Отпечаток строк сводки сотрудников за диапазон: по нему видно, что пересчёт реально изменил. */
const summaryFingerprint = async (employeeIds: number[], from: string, to: string): Promise<Map<string, string>> => {
  const rows = await query<{ key: string; fp: string }>(
    `SELECT employee_id || '_' || date::text AS key,
            md5(concat_ws('|', first_entry, last_exit, total_minutes, break_minutes, is_present)) AS fp
       FROM skud_daily_summary
      WHERE employee_id = ANY($1::bigint[]) AND date BETWEEN $2 AND $3`,
    [employeeIds, from, to],
  );
  return new Map(rows.map(row => [row.key, row.fp]));
};

const travelFingerprint = async (employeeIds: number[], from: string, to: string): Promise<Map<string, string>> => {
  const rows = await query<ILostTravelDecision & { credited_minutes: number }>(
    `SELECT employee_id, work_date::text AS work_date, exit_time::text AS exit_time, entry_time::text AS entry_time,
            from_access_point_name, to_access_point_name, status, credited_minutes
       FROM skud_travel_segments
      WHERE employee_id = ANY($1::bigint[]) AND work_date BETWEEN $2 AND $3`,
    [employeeIds, from, to],
  );
  return new Map(rows.map(row => [travelKey(row), `${row.status}|${row.credited_minutes}`]));
};

const countDiff = (before: Map<string, string>, after: Map<string, string>): number => {
  let changed = 0;
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(key) !== after.get(key)) changed += 1;
  }
  return changed;
};

/** План штатной смены типа с даты from: всё, что касается точки, от этой даты по to. */
export async function buildZoneChangePlan(accessPointName: string, from: string, to: string, markVersions: boolean): Promise<IZoneReconcilePlan> {
  const rows = await query<{ employee_id: number; event_date: string }>(
    `SELECT DISTINCT employee_id, event_date::text AS event_date
       FROM skud_events
      WHERE event_date BETWEEN $2 AND $3 AND employee_id IS NOT NULL AND btrim(access_point) = $1`,
    [accessPointName, from, to],
  );
  return {
    accessPointName,
    summaryPairs: rows.map(row => ({ emp_id: Number(row.employee_id), date: String(row.event_date).slice(0, 10) })),
    travelEmployeeIds: [...new Set(rows.map(row => Number(row.employee_id)))],
    travelFrom: from,
    travelTo: to,
    // Пересчёт пары (сотрудник, from) задевает и день from − 1.
    versionsFrom: markVersions ? shiftDay(from, -1) : null,
    versionsTo: markVersions ? to : null,
  };
}

export async function reconcileAccessPointZone(
  plan: IZoneReconcilePlan,
  // Последняя проверка перед пометкой версий: false — версии пометит кто-то другой (см. воркер).
  shouldMarkVersions: () => Promise<boolean> = async () => true,
): Promise<IZoneReconcileResult> {
  invalidateInternalPointsCache();

  // 1. Сводка.
  const exactPairs = plan.summaryExactPairs ?? [];
  const allPairs = [...plan.summaryPairs, ...exactPairs];
  const summaryEmployees = [...new Set(allPairs.map(pair => pair.emp_id))];
  let summaryChanged = 0;
  if (allPairs.length > 0) {
    const dates = allPairs.map(pair => pair.date).sort();
    const from = shiftDay(dates[0], -1);
    const to = dates[dates.length - 1];
    const before = await summaryFingerprint(summaryEmployees, from, to);
    for (let index = 0; index < plan.summaryPairs.length; index += SUMMARY_BATCH) {
      const chunk = plan.summaryPairs.slice(index, index + SUMMARY_BATCH);
      await query('SELECT public.batch_recalculate_skud_daily_summary($1::jsonb)', [JSON.stringify(chunk)]);
    }
    for (let index = 0; index < exactPairs.length; index += SUMMARY_BATCH) {
      const chunk = exactPairs.slice(index, index + SUMMARY_BATCH);
      await query(
        `SELECT public.recalculate_skud_daily_summary(NULL::uuid, (x->>'emp_id')::bigint, (x->>'date')::date)
           FROM jsonb_array_elements($1::jsonb) x`,
        [JSON.stringify(chunk)],
      );
    }
    summaryChanged = countDiff(before, await summaryFingerprint(summaryEmployees, from, to));
  }

  // 2. «Дорога». Решение привязано к ключу сегмента: если после пересборки ключа больше нет,
  //    решение исчезает вместе со строкой — сохраняем его в аудит.
  const lostTravelDecisions: ILostTravelDecision[] = [];
  let travelChanged = 0;
  if (plan.travelEmployeeIds.length > 0 && plan.travelFrom <= plan.travelTo) {
    const before = await travelFingerprint(plan.travelEmployeeIds, plan.travelFrom, plan.travelTo);
    const decided = await query<ILostTravelDecision>(
      `SELECT employee_id, work_date::text AS work_date, exit_time::text AS exit_time, entry_time::text AS entry_time,
              from_access_point_name, to_access_point_name, status, approved_by,
              approved_at::text AS approved_at, approval_comment
         FROM skud_travel_segments
        WHERE employee_id = ANY($1::bigint[]) AND work_date BETWEEN $2 AND $3
          AND status IN ('approved', 'rejected')`,
      [plan.travelEmployeeIds, plan.travelFrom, plan.travelTo],
    );
    await calculateAndSyncTravelSegments({
      employeeIds: plan.travelEmployeeIds,
      startDate: plan.travelFrom,
      endDate: plan.travelTo,
    });
    invalidateTravelSegmentsCache();
    const after = await travelFingerprint(plan.travelEmployeeIds, plan.travelFrom, plan.travelTo);
    travelChanged = countDiff(before, after);
    lostTravelDecisions.push(...decided.filter(row => !after.has(travelKey(row))));
  }

  // 3. Кэши табеля, присутствия и дашборда — после того, как данные уже пересчитаны.
  const employeeIds = [...new Set([...summaryEmployees, ...plan.travelEmployeeIds])];
  notifySkudRealtimeChanged({
    source: 'timesheet_refresh',
    employeeIds,
    from: plan.travelFrom,
    to: plan.travelTo,
    recalculatedCount: allPairs.length,
  });

  // 4. 1С: закрытые утверждённые подачи получают новую редакцию, если часы в них изменились.
  //    Решает content_hash в materializeVersion — без изменений редакция не создаётся.
  let markedApprovalIds: number[] = [];
  if (plan.versionsFrom && plan.versionsTo && employeeIds.length > 0 && await shouldMarkVersions()) {
    const approvals = await query<{ id: number }>(
      `SELECT DISTINCT a.id
         FROM timesheet_approvals a
         JOIN timesheet_approval_employees ae ON ae.approval_id = a.id
        WHERE a.status = 'approved' AND a.unlocked_at IS NULL
          AND a.end_date >= $1 AND a.start_date <= $2
          AND ae.employee_id = ANY($3::bigint[])`,
      [plan.versionsFrom, plan.versionsTo, employeeIds],
    );
    markedApprovalIds = approvals.map(row => Number(row.id));
    await markVersionDirtyForOperatorRebuild(getPool(), markedApprovalIds);
  }

  const result: IZoneReconcileResult = {
    summaryPairs: allPairs.length,
    summaryChanged,
    travelEmployees: plan.travelEmployeeIds.length,
    travelChanged,
    lostTravelDecisions,
    markedApprovalIds,
  };

  await auditService.log({
    user_id: null,
    action: 'SKUD_ACCESS_POINT_ZONE_RECONCILED',
    entity_type: 'skud_access_point',
    entity_id: plan.accessPointName,
    details: {
      travel_from: plan.travelFrom,
      travel_to: plan.travelTo,
      versions_from: plan.versionsFrom,
      versions_to: plan.versionsTo,
      summary_pairs: result.summaryPairs,
      summary_changed: result.summaryChanged,
      travel_employees: result.travelEmployees,
      travel_changed: result.travelChanged,
      lost_travel_decisions: result.lostTravelDecisions,
      marked_approval_ids: result.markedApprovalIds,
    },
  });

  return result;
}

// ─── Очередь ────────────────────────────────────────────────────────────────────────────────

interface ITaskRow {
  id: number;
  access_point_name: string;
  from_date: string;
  to_date: string;
  mark_versions: boolean;
  attempts: number;
}

/**
 * Забирает самую старую задачу и вместе с ней все ждущие задачи ТОЙ ЖЕ точки: несколько смен
 * типа подряд пересобираются один раз, от самой ранней даты. Иначе первая задача успела бы
 * пометить версии по промежуточному состоянию, пока вторая ещё пересчитывает сводку.
 */
const leaseTasks = async (): Promise<ITaskRow[]> =>
  withTransaction(async client => {
    const head = (await client.query<ITaskRow>(
      `SELECT id, access_point_name, from_date::text AS from_date, to_date::text AS to_date, mark_versions, attempts
         FROM skud_access_point_zone_reconcile
        WHERE next_run_at <= now()
          AND (state = 'queued' OR (state = 'leased' AND lease_until < now()))
        ORDER BY id
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
    )).rows[0];
    if (!head) return [];
    const leased = await client.query<ITaskRow>(
      `UPDATE skud_access_point_zone_reconcile t
          SET state = 'leased', lease_until = now() + ($2 || ' minutes')::interval,
              attempts = attempts + 1, updated_at = now()
        WHERE t.access_point_name = $1
          AND (t.state = 'queued' OR (t.state = 'leased' AND t.lease_until < now()))
        RETURNING t.id, t.access_point_name, t.from_date::text AS from_date, t.to_date::text AS to_date,
                  t.mark_versions, t.attempts`,
      [head.access_point_name, String(LEASE_MINUTES)],
    );
    return leased.rows;
  });

const finishTasks = async (ids: number[], state: 'done' | 'failed', error: string | null): Promise<void> => {
  await execute(
    `UPDATE skud_access_point_zone_reconcile
        SET state = $2, lease_until = NULL, last_error = $3, updated_at = now()
      WHERE id = ANY($1::bigint[])`,
    [ids, state, error],
  );
};

const rescheduleTasks = async (ids: number[], attempts: number, error: string): Promise<void> => {
  await execute(
    `UPDATE skud_access_point_zone_reconcile
        SET state = 'queued', lease_until = NULL, last_error = $2, updated_at = now(),
            next_run_at = now() + ($3 || ' minutes')::interval
      WHERE id = ANY($1::bigint[])`,
    [ids, error, String(Math.min(60, 2 ** attempts))],
  );
};

/** Обрабатывает одну группу задач. Возвращает false, если очередь пуста. */
export async function runZoneReconcileOnce(): Promise<boolean> {
  const tasks = await leaseTasks();
  if (tasks.length === 0) return false;

  const ids = tasks.map(task => Number(task.id));
  const name = tasks[0].access_point_name;
  const from = tasks.map(task => task.from_date).sort()[0];
  const today = moscowTodayIso();
  const to = [...tasks.map(task => task.to_date), today].sort().pop() ?? today;
  const attempts = Math.max(...tasks.map(task => task.attempts));

  try {
    const plan = await buildZoneChangePlan(name, from, to, tasks.some(task => task.mark_versions));
    // Пока шёл пересчёт, тип могли сменить ещё раз. Тогда версии пометит следующая задача —
    // по итоговому состоянию, а не по промежуточному; чтобы она покрыла и наш диапазон,
    // расширяем её до нашей даты начала.
    const result = await reconcileAccessPointZone(plan, async () => {
      const widened = await execute(
        `UPDATE skud_access_point_zone_reconcile
            SET from_date = LEAST(from_date, $2::date), mark_versions = true, updated_at = now()
          WHERE access_point_name = $1 AND state = 'queued' AND NOT (id = ANY($3::bigint[]))`,
        [name, from, ids],
      );
      return widened === 0;
    });
    await finishTasks(ids, 'done', null);
    console.log(
      `[access-point-zone] «${name}» с ${from}: сводка ${result.summaryChanged}/${result.summaryPairs}, ` +
      `«Дорога» ${result.travelChanged}, версий помечено ${result.markedApprovalIds.length}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[access-point-zone] «${name}»: пересборка не удалась (попытка ${attempts}) — ${message}`);
    if (attempts >= MAX_ATTEMPTS) {
      await finishTasks(ids, 'failed', message.slice(0, 1000));
      Sentry.captureException(error, { tags: { job: 'access-point-zone-reconcile' }, extra: { accessPointName: name, from, to } });
    } else {
      await rescheduleTasks(ids, attempts, message.slice(0, 1000));
    }
  }
  return true;
}

let timer: NodeJS.Timeout | null = null;
let startupTimeout: NodeJS.Timeout | null = null;
let ticking = false;

const tick = async (): Promise<void> => {
  if (ticking) return;
  ticking = true;
  try {
    // По одной группе за раз: пересборки разных точек задевают одни и те же строки сводки.
    while (await runZoneReconcileOnce()) { /* до опустошения очереди */ }
  } catch (error) {
    console.error('[access-point-zone] ошибка воркера:', error instanceof Error ? error.message : error);
  } finally {
    ticking = false;
  }
};

/** Сразу после смены типа: не ждём следующего тика. */
export function kickAccessPointZoneReconcile(): void {
  void tick();
}

export function startAccessPointZoneReconcileWorker(): void {
  if (timer || startupTimeout) return;
  // Задачи, не доведённые до рестарта, подхватываются сами: просроченная аренда = снова в очереди.
  startupTimeout = setTimeout(() => {
    startupTimeout = null;
    void tick();
  }, STARTUP_DELAY_MS);
  startupTimeout.unref();
  timer = setInterval(() => { void tick(); }, TICK_MS);
  timer.unref();
}

export function stopAccessPointZoneReconcileWorker(): void {
  if (startupTimeout) clearTimeout(startupTimeout);
  if (timer) clearInterval(timer);
  startupTimeout = null;
  timer = null;
}
