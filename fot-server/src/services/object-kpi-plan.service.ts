import type { PoolClient } from 'pg';

import { query } from '../config/postgres.js';
import { failWith } from './object-kpi-errors.js';
import { recordObjectKpiHistory, type ObjectKpiActor } from './object-kpi-history.service.js';
import { OBJECT_KPI_REPORT_SQL, type ObjectKpiReportRow } from './object-kpi-report.service.js';
import { isEconomicsHeadLive } from './object-kpi-roles-cache.service.js';

/**
 * Снимок месячного плана (п. 2.8): фиксация, пересмотр, чтение ревизий.
 *
 * Значения снимка НИКОГДА не считаются здесь отдельной формулой — они берутся из
 * OBJECT_KPI_REPORT_SQL, того же запроса, что рисует отчёт. Вторая реализация формул
 * рано или поздно разойдётся с первой, и «зафиксированный план» перестал бы совпадать
 * с тем, что человек видел на экране в момент нажатия кнопки.
 */

export interface ObjectKpiMonthPlanRow {
  id: string;
  skud_object_id: string;
  period_month: string;
  revision: number;
  is_current: boolean;
  contract_total: string | null;
  ks2_cumulative_before: string | null;
  remainder: string | null;
  planned_zos_date_used: string | null;
  control_date: string | null;
  months_remaining: number | null;
  calculated_plan_amount: string | null;
  override_plan_amount: string | null;
  plan_amount: string | null;
  status: 'open' | 'fixed' | 'corrected' | 'data_incomplete';
  fixed_at: string | null;
  fixed_by: string | null;
  /** Только в listMonthPlans (чтение для UI): в RETURNING у INSERT/UPDATE его нет. */
  fixed_by_name?: string | null;
  fixed_source: 'auto' | 'manual' | 'economics_head_override' | null;
  correction_reason: string | null;
  superseded_at: string | null;
  created_at: string;
}

const PLAN_COLUMNS = `
  id, skud_object_id, to_char(period_month, 'YYYY-MM-DD') AS period_month, revision, is_current,
  contract_total, ks2_cumulative_before, remainder,
  to_char(planned_zos_date_used, 'YYYY-MM-DD') AS planned_zos_date_used,
  to_char(control_date, 'YYYY-MM-DD')          AS control_date,
  months_remaining, calculated_plan_amount, override_plan_amount, plan_amount,
  status, fixed_at, fixed_by, fixed_source, correction_reason, superseded_at, created_at`;

/** Нормализация «месяца» к 1-му числу: снаружи приходит и `YYYY-MM`, и `YYYY-MM-DD`. */
export function normalizeMonth(value: string): string {
  const match = /^(\d{4})-(\d{2})/.exec(value);
  if (!match) {
    failWith({ http: 400, code: 'bad_month', message: 'Некорректный месяц (ожидается YYYY-MM)' });
  }
  return `${match![1]}-${match![2]}-01`;
}

export async function listMonthPlans(
  objectId: string,
  monthFrom: string,
  monthTo: string,
  options: { currentOnly?: boolean } = {},
): Promise<ObjectKpiMonthPlanRow[]> {
  // JOIN только здесь, в чтении для UI: fixed_source — это ИСТОЧНИК операции
  // ('manual'/'auto'/'economics_head_override'), а не человек, и подпись «правил такой-то»
  // без имени не собирается. В RETURNING у INSERT/UPDATE (PLAN_COLUMNS) джойна нет.
  return query<ObjectKpiMonthPlanRow>(
    `SELECT ${PLAN_COLUMNS},
            (SELECT up.full_name FROM user_profiles up
              WHERE up.id = object_kpi_month_plans.fixed_by) AS fixed_by_name
       FROM object_kpi_month_plans
      WHERE skud_object_id = $1
        AND period_month BETWEEN $2::date AND $3::date
        ${options.currentOnly ? 'AND is_current' : ''}
      ORDER BY period_month DESC, revision DESC`,
    [objectId, normalizeMonth(monthFrom), normalizeMonth(monthTo)],
  );
}

/**
 * Строка отчёта за один месяц — источник значений снимка. Читается ТЕМ ЖЕ client,
 * то есть внутри транзакции фиксации: между чтением и записью никто не успеет
 * подписать акт и сдвинуть остаток.
 */
async function loadReportRow(
  client: PoolClient,
  objectId: string,
  periodMonth: string,
): Promise<ObjectKpiReportRow> {
  const result = await client.query<ObjectKpiReportRow>(OBJECT_KPI_REPORT_SQL, [
    periodMonth,
    periodMonth,
    [objectId],
  ]);
  const row = result.rows[0];
  if (!row) {
    failWith({
      http: 404,
      code: 'month_not_applicable',
      message: 'Объект не участвует в расчёте за этот месяц',
    });
  }
  return row!;
}

/**
 * Семёрка замороженных величин берётся ЦЕЛИКОМ или не берётся вовсе.
 * Смешение «часть из снимка, часть пересчётом» ломает тождество
 * remainder / months_remaining = plan_amount прямо в строке отчёта.
 */
function snapshotValues(row: ObjectKpiReportRow) {
  const incomplete = row.data_quality !== 'ok' || row.plan_amount_calc === null;
  return {
    status: incomplete ? ('data_incomplete' as const) : ('fixed' as const),
    contract_total: incomplete ? null : row.contract_total,
    ks2_cumulative_before: incomplete ? null : row.ks2_cumulative_before,
    remainder: incomplete ? null : row.remainder,
    planned_zos_date_used: incomplete ? null : row.planned_zos_date_used,
    control_date: incomplete ? null : row.control_date,
    months_remaining: incomplete ? null : row.months_remaining,
    // При data_incomplete план обязан быть NULL, а не нулём: ноль в знаменателе
    // совокупного KPI занизил бы процент руководителя за месяц, где данных не было.
    calculated_plan_amount: incomplete ? null : row.plan_amount_calc,
  };
}

/**
 * Фиксация месяца.
 *
 * ON CONFLICT ... DO UPDATE, а не DO NOTHING: строка `open` могла быть создана раньше
 * (например, ручным сохранением плана), и DO NOTHING оставил бы её незакрытой навсегда.
 * Условие `WHERE status = 'open'` защищает уже зафиксированные и пересмотренные месяцы —
 * этого достаточно и при нескольких инстансах, отдельный advisory-lock не нужен.
 *
 * @returns строку снимка либо null, если месяц уже был закрыт (для авто-прогона это
 *          нормальный исход, для ручной кнопки контроллер отдаёт 409 plan_frozen).
 */
export async function fixMonthPlan(
  client: PoolClient,
  actor: ObjectKpiActor,
  objectId: string,
  periodMonthRaw: string,
  source: 'auto' | 'manual',
): Promise<ObjectKpiMonthPlanRow | null> {
  const periodMonth = normalizeMonth(periodMonthRaw);
  const reportRow = await loadReportRow(client, objectId, periodMonth);
  const values = snapshotValues(reportRow);

  const result = await client.query<ObjectKpiMonthPlanRow>(
    `INSERT INTO object_kpi_month_plans (
       skud_object_id, period_month, revision, is_current,
       contract_total, ks2_cumulative_before, remainder,
       planned_zos_date_used, control_date, months_remaining,
       calculated_plan_amount, status, fixed_at, fixed_by, fixed_source
     ) VALUES ($1,$2,1,true,$3,$4,$5,$6,$7,$8,$9,$10,now(),$11,$12)
     ON CONFLICT (skud_object_id, period_month) WHERE is_current
     DO UPDATE SET
       contract_total        = EXCLUDED.contract_total,
       ks2_cumulative_before = EXCLUDED.ks2_cumulative_before,
       remainder             = EXCLUDED.remainder,
       planned_zos_date_used = EXCLUDED.planned_zos_date_used,
       control_date          = EXCLUDED.control_date,
       months_remaining      = EXCLUDED.months_remaining,
       calculated_plan_amount = EXCLUDED.calculated_plan_amount,
       status     = EXCLUDED.status,
       fixed_at   = now(),
       fixed_by   = EXCLUDED.fixed_by,
       fixed_source = EXCLUDED.fixed_source
     WHERE object_kpi_month_plans.status = 'open'
     RETURNING ${PLAN_COLUMNS}`,
    [
      objectId,
      periodMonth,
      values.contract_total,
      values.ks2_cumulative_before,
      values.remainder,
      values.planned_zos_date_used,
      values.control_date,
      values.months_remaining,
      values.calculated_plan_amount,
      values.status,
      actor.userId,
      source,
    ],
  );

  const row = result.rows[0];
  if (!row) return null;  // месяц уже fixed/corrected — трогать нельзя

  await recordObjectKpiHistory(client, {
    skudObjectId: objectId,
    entityKind: 'plan',
    entityId: row.id,
    action: 'create',
    after: { ...row },
    changedFields: ['status', 'plan_amount'],
    reason: source === 'auto' ? 'Автоматическая фиксация плана месяца' : null,
    actor,
  });
  return row;
}

export interface RevisePlanInput {
  /** Обязательно и непусто: пересмотр закрытого месяца без основания запрещён (п. 2.8). */
  reason: string;
  /** Ручная сумма плана. Без неё план пересчитывается формулой по текущим данным. */
  override_plan_amount?: number | string | null;
}

/**
 * Пересмотр закрытого месяца — новая ревизия, а не правка строки.
 *
 * Право проверяется В БД внутри этой же транзакции, а не по кэшу ролей: кэш живёт
 * 5 минут и инвалидируется локально в процессе, поэтому снятая роль иначе продолжала бы
 * работать на соседнем инстансе.
 */
export async function revisePlan(
  client: PoolClient,
  actor: ObjectKpiActor,
  actorEmployeeId: number | null,
  isAdmin: boolean,
  objectId: string,
  periodMonthRaw: string,
  input: RevisePlanInput,
): Promise<ObjectKpiMonthPlanRow> {
  const periodMonth = normalizeMonth(periodMonthRaw);

  if (!input.reason?.trim()) {
    failWith({ http: 400, code: 'reason_required', message: 'Укажите основание пересмотра плана' });
  }
  if (!isAdmin && !(await isEconomicsHeadLive(client, actorEmployeeId))) {
    failWith({
      http: 403,
      code: 'forbidden',
      message: 'Пересматривать зафиксированный план может только руководитель экономического отдела',
    });
  }

  const currentResult = await client.query<ObjectKpiMonthPlanRow>(
    `SELECT ${PLAN_COLUMNS}
       FROM object_kpi_month_plans
      WHERE skud_object_id = $1 AND period_month = $2::date AND is_current
      FOR UPDATE`,
    [objectId, periodMonth],
  );
  const current = currentResult.rows[0];
  if (!current) {
    failWith({
      http: 409,
      code: 'plan_not_fixed',
      message: 'План месяца ещё не зафиксирован — пересматривать нечего',
    });
  }

  // Расчётная половина обновляется всегда: даже при ручном значении в снимке должно
  // остаться видно, сколько давала формула на момент пересмотра.
  const reportRow = await loadReportRow(client, objectId, periodMonth);
  const values = snapshotValues(reportRow);
  const override = input.override_plan_amount ?? null;

  await client.query(
    `UPDATE object_kpi_month_plans
        SET is_current = false, superseded_at = now()
      WHERE id = $1`,
    [current!.id],
  );

  const inserted = await client.query<ObjectKpiMonthPlanRow>(
    `INSERT INTO object_kpi_month_plans (
       skud_object_id, period_month, revision, is_current,
       contract_total, ks2_cumulative_before, remainder,
       planned_zos_date_used, control_date, months_remaining,
       calculated_plan_amount, override_plan_amount,
       status, fixed_at, fixed_by, fixed_source, correction_reason
     ) VALUES ($1,$2,$3,true,$4,$5,$6,$7,$8,$9,$10,$11,'corrected',now(),$12,'economics_head_override',$13)
     RETURNING ${PLAN_COLUMNS}`,
    [
      objectId,
      periodMonth,
      current!.revision + 1,
      values.contract_total,
      values.ks2_cumulative_before,
      values.remainder,
      values.planned_zos_date_used,
      values.control_date,
      values.months_remaining,
      values.calculated_plan_amount,
      override,
      actor.userId,
      input.reason.trim(),
    ],
  );
  const next = inserted.rows[0];

  await recordObjectKpiHistory(client, {
    skudObjectId: objectId,
    entityKind: 'plan',
    entityId: next.id,
    action: 'update',
    before: { ...current },
    after: { ...next },
    reason: input.reason.trim(),
    actor,
  });
  return next;
}

/**
 * Объекты, у которых за месяц нет текущей ревизии снимка. Нужен авто-фиксации:
 * дешевле спросить у БД разницу, чем гонять отчёт по всей стройке.
 */
export async function listObjectsWithoutCurrentPlan(periodMonthRaw: string): Promise<string[]> {
  const periodMonth = normalizeMonth(periodMonthRaw);
  const rows = await query<{ id: string }>(
    `SELECT o.id
       FROM skud_objects o
      WHERE EXISTS (SELECT 1 FROM object_contracts c WHERE c.skud_object_id = o.id AND c.is_active)
        AND NOT EXISTS (
          SELECT 1 FROM object_kpi_month_plans p
           WHERE p.skud_object_id = o.id
             AND p.period_month = $1::date
             AND p.is_current
             AND p.status <> 'open'
        )
      ORDER BY o.name`,
    [periodMonth],
  );
  return rows.map((row) => row.id);
}
