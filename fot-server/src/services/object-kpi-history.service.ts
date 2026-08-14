import type { PoolClient } from 'pg';

import { query } from '../config/postgres.js';
import { failWith } from './object-kpi-errors.js';

/**
 * Единый журнал изменений KPI-контура (object_kpi_history).
 *
 * Снапшот в jsonb, а не колонками: сущностей шесть и они разнородные. Пишется ТЕМ ЖЕ
 * PoolClient, что и сама правка, — иначе при откате транзакции в журнале осталась бы
 * запись о несостоявшемся изменении.
 */

export type ObjectKpiEntityKind =
  | 'contract'
  | 'addendum'
  | 'ks2'
  | 'assignment'
  | 'global_role'
  | 'plan';

export interface ObjectKpiActor {
  /** user_profiles.id — может быть null у системных операций (freezer). */
  userId: string | null;
  userName: string | null;
}

export interface RecordHistoryInput {
  skudObjectId: string | null;
  entityKind: ObjectKpiEntityKind;
  entityId: string | null;
  action: 'create' | 'update' | 'delete';
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  changedFields?: string[];
  reason?: string | null;
  actor: ObjectKpiActor;
}

/**
 * Какие поля реально изменились. Сравнение через String(): numeric приходит из
 * драйвера строкой, а в патче лежит number — прямое !== пометило бы изменённым
 * каждое денежное поле при любом сохранении.
 */
export function diffFields(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): string[] {
  if (!before || !after) return [];
  const fields: string[] = [];
  for (const key of Object.keys(after)) {
    const a = before[key];
    const b = after[key];
    if (a === b) continue;
    if (a == null && b == null) continue;
    if (a != null && b != null && String(a) === String(b)) continue;
    fields.push(key);
  }
  return fields;
}

export async function recordObjectKpiHistory(
  client: PoolClient,
  input: RecordHistoryInput,
): Promise<void> {
  const changedFields = input.changedFields ?? diffFields(input.before, input.after);

  await client.query(
    `INSERT INTO object_kpi_history (
       skud_object_id, entity_kind, entity_id, action,
       changed_fields, before_data, after_data, reason, changed_by, changed_by_name
     ) VALUES ($1, $2, $3, $4, $5::text[], $6::jsonb, $7::jsonb, $8, $9, $10)`,
    [
      input.skudObjectId,
      input.entityKind,
      input.entityId,
      input.action,
      changedFields,
      input.before ? JSON.stringify(input.before) : null,
      input.after ? JSON.stringify(input.after) : null,
      input.reason?.trim() || null,
      input.actor.userId,
      input.actor.userName,
    ],
  );
}

export interface ObjectKpiHistoryRow {
  id: string;
  skud_object_id: string | null;
  entity_kind: ObjectKpiEntityKind;
  entity_id: string | null;
  action: 'create' | 'update' | 'delete';
  changed_fields: string[];
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown> | null;
  reason: string | null;
  changed_by_name: string | null;
  changed_at: string;
}

export async function listObjectKpiHistory(
  skudObjectId: string,
  limit = 200,
): Promise<ObjectKpiHistoryRow[]> {
  return query<ObjectKpiHistoryRow>(
    `SELECT id, skud_object_id, entity_kind, entity_id, action, changed_fields,
            before_data, after_data, reason, changed_by_name, changed_at
       FROM object_kpi_history
      WHERE skud_object_id = $1
      ORDER BY changed_at DESC
      LIMIT $2`,
    [skudObjectId, limit],
  );
}

/**
 * Зафиксирован ли месяц объекта (п. 2.8).
 *
 * Смотрит текущую ревизию снимка. Правка исходных данных за такой месяц разрешена,
 * но требует основания: сам снимок при этом не меняется — в отчёте поднимется
 * plan_drift, и расхождение будет видно вместе с причиной из журнала.
 */
export async function isMonthFixed(
  client: PoolClient,
  skudObjectId: string,
  periodMonth: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1
       FROM object_kpi_month_plans
      WHERE skud_object_id = $1
        AND period_month = date_trunc('month', $2::date::timestamp)::date
        AND is_current
        AND status IN ('fixed', 'corrected')
      LIMIT 1`,
    [skudObjectId, periodMonth],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Требование основания при правке закрытого месяца. Вызывается ДО записи, чтобы
 * транзакция не выполняла работу, которую всё равно откатит.
 */
export async function requireReasonIfMonthFixed(
  client: PoolClient,
  skudObjectId: string,
  periodMonth: string | null,
  reason: string | null | undefined,
): Promise<void> {
  if (!periodMonth) return;
  if (reason?.trim()) return;
  if (!(await isMonthFixed(client, skudObjectId, periodMonth))) return;

  failWith({
    http: 400,
    code: 'reason_required',
    message: 'План этого месяца уже зафиксирован — укажите основание правки',
  });
}

/**
 * То же требование для правок, которые бьют по ВСЕМ месяцам сразу: стоимость договора,
 * плановая ЗОС, дата начала расчёта. Привязать такую правку к одному месяцу нельзя,
 * поэтому основание требуется, как только у объекта есть хоть один закрытый месяц.
 */
export async function requireReasonIfObjectHasFixedMonths(
  client: PoolClient,
  skudObjectId: string,
  reason: string | null | undefined,
): Promise<void> {
  if (reason?.trim()) return;

  const result = await client.query(
    `SELECT 1
       FROM object_kpi_month_plans
      WHERE skud_object_id = $1
        AND is_current
        AND status IN ('fixed', 'corrected')
      LIMIT 1`,
    [skudObjectId],
  );
  if ((result.rowCount ?? 0) === 0) return;

  failWith({
    http: 400,
    code: 'reason_required',
    message: 'У объекта есть зафиксированные месяцы — укажите основание правки',
  });
}
