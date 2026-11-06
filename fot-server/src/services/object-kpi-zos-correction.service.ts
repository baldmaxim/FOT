import type { PoolClient } from 'pg';

import { AUDIT_ACTIONS, auditService } from './audit.service.js';
import { failWith } from './object-kpi-errors.js';
import { recordObjectKpiHistory, type ObjectKpiActor } from './object-kpi-history.service.js';
import { PLAN_COLUMNS, snapshotValues, type ObjectKpiMonthPlanRow } from './object-kpi-plan.service.js';
import { OBJECT_KPI_REPORT_SQL, type ObjectKpiReportRow } from './object-kpi-report.service.js';
import { lockContract, updateContract } from './object-kpi.service.js';

/**
 * Исправление плановой ЗОС как ошибки исходных данных (п. 2.8 и 8.2 приказа): во всех месяцах,
 * включая уже зафиксированные.
 *
 * Обычная правка договора меняет дату только в незафиксированных месяцах: закрытый месяц хранит
 * ЗОС в снимке (п. 6.3), и «Пересмотр плана» берёт её оттуда же. Здесь закрытый месяц получает
 * новую ревизию, посчитанную уже по исправленной дате: старая строка снимается с текущих, и
 * OBJECT_KPI_REPORT_SQL считает месяц как открытый. Строки не удаляются — ревизии append-only.
 *
 * Всё — в транзакции вызывающего. Любое расхождение с ожидаемым состоянием (дата, версия, номер
 * договора, набор месяцев и их ревизий, ручной план) — отказ до первой записи, без частичных
 * изменений. Откат операции — та же правка в обратную сторону следующей ревизией
 * (buildRevertTargets), проверяющая, что после операции ничего не менялось.
 */

export const ZOS_CORRECTION_KIND = 'zos_correction';
export const ZOS_CORRECTION_REVERT_KIND = 'zos_correction_revert';

export interface IZosCorrectionMonth {
  /** YYYY-MM-01. */
  month: string;
  /** id и номер текущей ревизии снимка, которые ожидаются до правки. */
  planId: string;
  revision: number;
}

export interface IZosCorrectionTarget {
  objectId: string;
  objectName: string;
  contractId: string;
  contractNumber: string;
  /** Версия договора до правки: её же проверяет updateContract. */
  contractVersion: number;
  /** Плановая ЗОС до правки и после (YYYY-MM-DD). */
  fromDate: string;
  toDate: string;
  /** Ровно этот набор текущих закрытых снимков объекта; любой другой текущий — отказ. */
  fixedMonths: ReadonlyArray<IZosCorrectionMonth>;
  /** Основание — документ. id операции дописывается сервисом. */
  reason: string;
}

export interface IZosCorrectionMonthResult {
  month: string;
  before: ObjectKpiMonthPlanRow;
  after: ObjectKpiMonthPlanRow;
}

export interface IZosCorrectionTargetResult {
  objectId: string;
  objectName: string;
  contractVersionAfter: number;
  months: IZosCorrectionMonthResult[];
}

export interface IZosCorrectionOptions {
  operationId: string;
  /** Откат: id исправленной операции; пишется в историю и аудит. */
  revertsOperationId?: string | null;
}

// Объявление функции, а не стрелка: так TypeScript сужает типы после `if (...) fail(...)`.
function fail(message: string): never {
  return failWith({ http: 409, code: 'zos_correction_precondition', message });
}

/** Дата + N календарных месяцев с последним днём месяца, как `date + interval` в PostgreSQL. */
export const addMonthsClamped = (date: string, months: number): string => {
  const [year, month, day] = date.split('-').map(Number);
  const total = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(total / 12);
  const targetMonth = total % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${targetYear}-${pad(targetMonth + 1)}-${pad(Math.min(day, lastDay))}`;
};

const reasonWithOperation = (reason: string, options: IZosCorrectionOptions): string => (
  options.revertsOperationId
    ? `${reason} [откат операции ${options.revertsOperationId}; операция ${options.operationId}]`
    : `${reason} [операция ${options.operationId}]`
);

/** Договоры и все текущие строки снимков — под блокировкой, в одном порядке у всех вызовов. */
async function lockAndCheck(
  client: PoolClient,
  targets: ReadonlyArray<IZosCorrectionTarget>,
): Promise<Map<string, ObjectKpiMonthPlanRow[]>> {
  for (const target of targets) {
    const contract = await lockContract(client, target.contractId);
    const object = await client.query<{ name: string }>('SELECT name FROM skud_objects WHERE id = $1', [target.objectId]);
    const label = `${target.objectName}`;
    if (object.rows[0]?.name !== target.objectName) fail(`${label}: объект не найден или переименован`);
    if (contract.skud_object_id !== target.objectId) fail(`${label}: договор принадлежит другому объекту`);
    if (!contract.is_active) fail(`${label}: договор неактивен`);
    if (contract.contract_number !== target.contractNumber) {
      fail(`${label}: номер договора ${contract.contract_number ?? '—'}, ожидался ${target.contractNumber}`);
    }
    if (Number(contract.version) !== target.contractVersion) {
      fail(`${label}: версия договора ${contract.version}, ожидалась ${target.contractVersion} — договор правили`);
    }
    if (contract.planned_zos_date !== target.fromDate) {
      fail(`${label}: плановая ЗОС ${contract.planned_zos_date ?? '—'}, ожидалась ${target.fromDate}`);
    }
    if (contract.actual_zos_date) fail(`${label}: внесён фактический ЗОС ${contract.actual_zos_date}`);
  }

  const plans = await client.query<ObjectKpiMonthPlanRow>(
    `SELECT ${PLAN_COLUMNS}
       FROM object_kpi_month_plans
      WHERE skud_object_id = ANY($1::uuid[]) AND is_current
      ORDER BY skud_object_id, period_month
      FOR UPDATE`,
    [targets.map(target => target.objectId)],
  );

  const byObject = new Map<string, ObjectKpiMonthPlanRow[]>();
  for (const target of targets) {
    const rows = plans.rows.filter(row => row.skud_object_id === target.objectId);
    const label = target.objectName;
    const overridden = rows.find(row => row.override_plan_amount !== null);
    if (overridden) fail(`${label}: в ${overridden.period_month.slice(0, 7)} задан ручной план`);

    const expected = [...target.fixedMonths].sort((a, b) => a.month.localeCompare(b.month));
    const describe = (list: Array<{ month: string; id: string; revision: number }>): string =>
      list.map(item => `${item.month.slice(0, 7)}#${item.revision}:${item.id}`).join(', ') || 'нет';
    const actual = rows.map(row => ({ month: row.period_month, id: row.id, revision: row.revision }));
    const same = actual.length === expected.length && expected.every((item, index) => (
      actual[index].month === item.month
      && actual[index].id === item.planId
      && actual[index].revision === item.revision
    ));
    if (!same) {
      fail(`${label}: текущие снимки ${describe(actual)}, ожидались ${describe(expected.map(item => ({ month: item.month, id: item.planId, revision: item.revision })))}`);
    }
    const notClosed = rows.find(row => row.status !== 'fixed' && row.status !== 'corrected');
    if (notClosed) fail(`${label}: снимок ${notClosed.period_month.slice(0, 7)} в статусе ${notClosed.status}`);
    byObject.set(target.objectId, rows);
  }
  return byObject;
}

async function reviseMonth(
  client: PoolClient,
  actor: ObjectKpiActor,
  target: IZosCorrectionTarget,
  current: ObjectKpiMonthPlanRow,
  reason: string,
  options: IZosCorrectionOptions,
): Promise<ObjectKpiMonthPlanRow> {
  const label = `${target.objectName}, ${current.period_month.slice(0, 7)}`;
  const superseded = await client.query(
    `UPDATE object_kpi_month_plans SET is_current = false, superseded_at = now()
      WHERE id = $1 AND is_current`,
    [current.id],
  );
  if (superseded.rowCount !== 1) fail(`${label}: снимок уже не текущий`);

  // Снимка у месяца больше нет — отчёт считает его по договору, то есть по новой дате.
  const report = await client.query<ObjectKpiReportRow>(OBJECT_KPI_REPORT_SQL, [
    current.period_month,
    current.period_month,
    [target.objectId],
  ]);
  const row = report.rows[0];
  if (!row) fail(`${label}: объект выпал из расчёта месяца`);
  const values = snapshotValues(row);
  if (values.status === 'data_incomplete') fail(`${label}: месяц стал неполным (${row.data_quality})`);
  const expectedControl = addMonthsClamped(target.toDate, 3);
  if (values.planned_zos_date_used !== target.toDate || values.control_date !== expectedControl) {
    fail(`${label}: в расчёте ЗОС ${values.planned_zos_date_used}, контроль ${values.control_date}; ожидались ${target.toDate} и ${expectedControl}`);
  }

  const inserted = await client.query<ObjectKpiMonthPlanRow>(
    `INSERT INTO object_kpi_month_plans (
       skud_object_id, period_month, revision, is_current,
       contract_total, ks2_cumulative_before, remainder,
       planned_zos_date_used, control_date, months_remaining,
       calculated_plan_amount, override_plan_amount,
       status, fixed_at, fixed_by, fixed_source, correction_reason
     ) VALUES ($1,$2,$3,true,$4,$5,$6,$7,$8,$9,$10,NULL,'corrected',now(),$11,'economics_head_override',$12)
     RETURNING ${PLAN_COLUMNS}`,
    [
      target.objectId,
      current.period_month,
      current.revision + 1,
      values.contract_total,
      values.ks2_cumulative_before,
      values.remainder,
      values.planned_zos_date_used,
      values.control_date,
      values.months_remaining,
      values.calculated_plan_amount,
      actor.userId,
      reason,
    ],
  );
  const next = inserted.rows[0];

  await recordObjectKpiHistory(client, {
    skudObjectId: target.objectId,
    entityKind: 'plan',
    entityId: next.id,
    action: 'update',
    before: { ...current },
    after: { ...next },
    reason,
    actor,
  });
  await auditService.logWithClient(client, {
    user_id: actor.userId,
    action: AUDIT_ACTIONS.OBJECT_KPI_PLAN_REVISED,
    entity_type: 'object_kpi_month_plan',
    entity_id: next.id,
    details: {
      kind: options.revertsOperationId ? ZOS_CORRECTION_REVERT_KIND : ZOS_CORRECTION_KIND,
      operation_id: options.operationId,
      reverts_operation_id: options.revertsOperationId ?? null,
      object_id: target.objectId,
      period_month: current.period_month,
      plan_id_before: current.id,
      plan_id_after: next.id,
      revision_after: next.revision,
      reason,
    },
  });
  return next;
}

/**
 * Правка плановой ЗОС у набора объектов в транзакции вызывающего. Сначала все блокировки и
 * проверки — потом записи: при любом отказе не записано ничего.
 */
export async function correctPlannedZos(
  client: PoolClient,
  actor: ObjectKpiActor,
  targetsInput: ReadonlyArray<IZosCorrectionTarget>,
  options: IZosCorrectionOptions,
): Promise<IZosCorrectionTargetResult[]> {
  if (!actor.userId) fail('Не указан ответственный');
  // Порядок блокировок одинаков у всех вызовов — по id объекта.
  const targets = [...targetsInput].sort((a, b) => a.objectId.localeCompare(b.objectId));
  const plansByObject = await lockAndCheck(client, targets);

  const results: IZosCorrectionTargetResult[] = [];
  for (const target of targets) {
    const reason = reasonWithOperation(target.reason, options);
    const updated = await updateContract(
      client,
      actor,
      target.contractId,
      target.contractVersion,
      { planned_zos_date: target.toDate },
      reason,
    );
    await auditService.logWithClient(client, {
      user_id: actor.userId,
      action: AUDIT_ACTIONS.OBJECT_KPI_CONTRACT_SAVED,
      entity_type: 'object_contract',
      entity_id: target.contractId,
      details: {
        kind: options.revertsOperationId ? ZOS_CORRECTION_REVERT_KIND : ZOS_CORRECTION_KIND,
        operation_id: options.operationId,
        reverts_operation_id: options.revertsOperationId ?? null,
        object_id: target.objectId,
        action: 'update',
        from_date: target.fromDate,
        to_date: target.toDate,
        version_after: Number(updated.version),
        reason,
      },
    });

    const months: IZosCorrectionMonthResult[] = [];
    for (const current of plansByObject.get(target.objectId) ?? []) {
      const after = await reviseMonth(client, actor, target, current, reason, options);
      months.push({ month: current.period_month, before: current, after });
    }
    results.push({
      objectId: target.objectId,
      objectName: target.objectName,
      contractVersionAfter: Number(updated.version),
      months,
    });
  }
  return results;
}

interface IAuditDetailsRow {
  action: string;
  details: Record<string, unknown>;
}

/**
 * Цели отката операции — из её же аудита: договор должен быть в той версии и с той датой, что
 * оставила операция, а текущие снимки — ровно её ревизиями. Откат отката и повторный откат —
 * отказ.
 */
export async function buildRevertTargets(
  client: PoolClient,
  operationId: string,
): Promise<IZosCorrectionTarget[]> {
  const result = await client.query<IAuditDetailsRow>(
    `SELECT action, details FROM audit_logs
      WHERE action = ANY($1::text[])
        AND (details->>'operation_id' = $2 OR details->>'reverts_operation_id' = $2)
      ORDER BY created_at`,
    [[AUDIT_ACTIONS.OBJECT_KPI_CONTRACT_SAVED, AUDIT_ACTIONS.OBJECT_KPI_PLAN_REVISED], operationId],
  );
  const own = result.rows.filter(row => row.details.operation_id === operationId);
  if (own.length === 0) fail(`Операция ${operationId} не найдена`);
  if (own.some(row => row.details.kind !== ZOS_CORRECTION_KIND)) fail(`Операция ${operationId} — не исправление ЗОС`);
  if (result.rows.some(row => row.details.reverts_operation_id === operationId)) {
    fail(`Операция ${operationId} уже откатывалась`);
  }

  const contracts = own.filter(row => row.action === AUDIT_ACTIONS.OBJECT_KPI_CONTRACT_SAVED);
  const targets: IZosCorrectionTarget[] = [];
  for (const row of contracts) {
    const details = row.details as {
      object_id: string; from_date: string; to_date: string; version_after: number;
    };
    const contract = await client.query<{ id: string; contract_number: string; name: string }>(
      `SELECT c.id, c.contract_number, o.name
         FROM object_contracts c JOIN skud_objects o ON o.id = c.skud_object_id
        WHERE c.skud_object_id = $1 AND c.is_active`,
      [details.object_id],
    );
    const found = contract.rows[0];
    if (!found) fail(`Договор объекта ${details.object_id} не найден`);
    const months = own
      .filter(item => item.action === AUDIT_ACTIONS.OBJECT_KPI_PLAN_REVISED && item.details.object_id === details.object_id)
      .map(item => ({
        month: String(item.details.period_month),
        planId: String(item.details.plan_id_after),
        revision: Number(item.details.revision_after),
      }));
    targets.push({
      objectId: details.object_id,
      objectName: found.name,
      contractId: found.id,
      contractNumber: found.contract_number,
      contractVersion: details.version_after,
      fromDate: details.to_date,
      toDate: details.from_date,
      fixedMonths: months,
      reason: `Откат исправления плановой ЗОС ${details.from_date} → ${details.to_date}`,
    });
  }
  return targets;
}

export interface ICorrectionActorRow {
  id: string;
  full_name: string | null;
  is_disabled: boolean | null;
  banned_until: string | null;
  is_approved: boolean | null;
  is_admin: boolean | null;
}

/** Ответственный (п. 2.8): ровно одна активная учётная запись администратора с этой почтой. */
export async function resolveCorrectionActor(client: PoolClient, email: string): Promise<ObjectKpiActor> {
  const normalized = email.trim();
  if (!normalized) fail('Не указана почта ответственного');
  const result = await client.query<ICorrectionActorRow>(
    `SELECT u.id, up.full_name, u.is_disabled, u.banned_until::text, up.is_approved, sr.is_admin
       FROM app_auth.users u
       JOIN user_profiles up ON up.id = u.id
       LEFT JOIN system_roles sr ON sr.id = up.system_role_id
      WHERE lower(u.email) = lower($1)`,
    [normalized],
  );
  if (result.rows.length !== 1) fail(`Учётная запись ${normalized} не найдена или не одна`);
  const row = result.rows[0];
  if (row.is_disabled) fail(`Учётная запись ${normalized} отключена`);
  if (row.banned_until && new Date(row.banned_until) > new Date()) fail(`Учётная запись ${normalized} заблокирована`);
  if (row.is_approved === false) fail(`Учётная запись ${normalized} не одобрена`);
  if (!row.is_admin) fail(`У ${normalized} нет роли администратора`);
  return { userId: row.id, userName: row.full_name };
}
