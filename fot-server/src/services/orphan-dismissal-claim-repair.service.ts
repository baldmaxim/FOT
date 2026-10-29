/**
 * Ремонт «осиротевших» claim увольнения — наследие отката увольнений синком Sigur (07–08.2026, до e92dd877):
 * синк возвращал уволенного в `active` и обнулял `dismissal_date`, но оставлял `dismissal_apply_started_at`.
 * С таким claim отложенное увольнение («сегодня» до 23:00 МСК и будущей датой) отвечает 409, а синк считает
 * сотрудника занятым lifecycle и не трогает его.
 *
 * Два исхода, решение — кадровое, по списку:
 *  - `legitimate_rehire` — человек работает: claim снимается, версия +1, аудит; событие `rehired` не пишется
 *    (фиктивная дата дала бы «увольнение» в читателях employee_dismissal_events);
 *  - `confirmed_fired` — уволен по факту: штатная durable-операция увольнения с исходной датой D (CAS по версии,
 *    архив и блок в Sigur с повтором, снимок полномочий, отзыв сессий). Назначение «Уволенные» с D+1 у них уже есть —
 *    changeDepartment его пропускает.
 *
 * Оба исхода требуют полную сигнатуру инцидента: `active`, без даты, claim старше ORPHAN_CLAIM_CUTOFF, версия 0,
 * нет незавершённой операции. Не совпало — сотрудник пропускается с причиной, ничего не пишется.
 */
import type { PoolClient } from 'pg';

import { query, queryOne, withTransaction } from '../config/postgres.js';
import { auditService } from './audit.service.js';
import {
  DismissalSigurError,
  executeOperation,
  openDismissOperation,
} from './employee-lifecycle-operations.service.js';

/** Последний claim инцидента — 12.08.2026; всё новее создано уже исправленным кодом. */
export const ORPHAN_CLAIM_CUTOFF = '2026-08-13T00:00:00Z';

const AUDIT_SOURCE = 'repair-orphan-dismissal-claims';

export type TOrphanClaimOutcome = 'legitimate_rehire' | 'confirmed_fired';

export interface IOrphanClaimTarget {
  employeeId: number;
  /** ФИО, как в списке: сверяется с employees.full_name (без учёта регистра и ё/е). */
  fullName: string;
  outcome: TOrphanClaimOutcome;
  /** confirmed_fired: последний рабочий день по кадрам — обязан совпасть с последним событием увольнения. */
  dismissalDate?: string;
}

export type TOrphanClaimResult =
  | { status: 'skipped'; reason: string }
  | { status: 'planned'; dismissalDate?: string }
  | { status: 'claim_cleared' }
  | { status: 'dismissed'; dismissalDate: string; operationId: string }
  /** Sigur не ответил: операция осталась pending, её доведёт dismissal-scheduler бэкенда после lease. */
  | { status: 'sigur_pending'; dismissalDate: string; operationId: string; error: string }
  | { status: 'failed'; error: string };

export interface IOrphanClaimItem {
  employeeId: number;
  fullName: string;
  outcome: TOrphanClaimOutcome;
  result: TOrphanClaimResult;
}

export interface IOpenAssignment {
  org_department_id: string | null;
  effective_from: string;
}

/** Состояние сотрудника для проверок; даты — YYYY-MM-DD, claim — timestamptz текстом. */
export interface IOrphanClaimState {
  full_name: string | null;
  employment_status: string;
  dismissal_date: string | null;
  claim_at: string | null;
  claim_before_cutoff: boolean | null;
  lifecycle_revision: number;
  org_department_id: string | null;
  pending_operations: number;
  event_dismissal_date: string | null;
  event_from_department_id: string | null;
  event_cancelled: boolean | null;
  event_rehired: boolean | null;
  skud_after_dismissal: number;
  open_assignments: IOpenAssignment[];
}

export class OrphanClaimRepairError extends Error {}

/** Сухой прогон: откатить транзакцию, сохранив результат. */
class DryRunRollback extends Error {}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const normalizeName = (name: string): string => name.trim().replace(/\s+/g, ' ').toLowerCase().replace(/ё/g, 'е');

export const addDaysIso = (iso: string, days: number): string => {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

export const validateTargets = (targets: readonly IOrphanClaimTarget[]): void => {
  const ids = targets.map(target => target.employeeId);
  if (new Set(ids).size !== ids.length) throw new OrphanClaimRepairError('Сотрудник в списке дважды');
  for (const target of targets) {
    if (!Number.isInteger(target.employeeId)) {
      throw new OrphanClaimRepairError(`Некорректный id: ${JSON.stringify(target)}`);
    }
    if (target.outcome !== 'legitimate_rehire' && target.outcome !== 'confirmed_fired') {
      throw new OrphanClaimRepairError(`${target.fullName}: неизвестный исход ${String(target.outcome)}`);
    }
    if (target.dismissalDate != null && !ISO_DATE.test(target.dismissalDate)) {
      throw new OrphanClaimRepairError(`${target.fullName}: некорректная дата ${target.dismissalDate}`);
    }
  }
};

/** Сигнатура инцидента — обязательна для обоих исходов. null — совпала. */
export const incidentSignatureViolation = (state: IOrphanClaimState): string | null => {
  if (state.employment_status !== 'active') return `статус ${state.employment_status}`;
  if (state.dismissal_date != null) return `уже назначена дата увольнения ${state.dismissal_date}`;
  if (state.claim_at == null) return 'claim не задан';
  if (state.claim_before_cutoff !== true) return `claim ${state.claim_at} не старше ${ORPHAN_CLAIM_CUTOFF}`;
  if (state.lifecycle_revision !== 0) return `версия состояния ${state.lifecycle_revision}, ожидалась 0`;
  if (state.pending_operations > 0) return 'есть незавершённая операция увольнения/восстановления';
  return null;
};

/** Доп. предусловия confirmed_fired: увольнение восстанавливается только «как было». null — выполнены. */
export const firedPreconditionViolation = (
  state: IOrphanClaimState,
  target: IOrphanClaimTarget,
  archiveDepartmentId: string,
): string | null => {
  const dismissalDate = state.event_dismissal_date;
  if (dismissalDate == null) return 'нет события увольнения';
  if (state.event_cancelled || state.event_rehired) return 'последнее событие — отмена/восстановление, а не увольнение';
  if (target.dismissalDate != null && target.dismissalDate !== dismissalDate) {
    return `дата в списке ${target.dismissalDate} ≠ дате события ${dismissalDate}`;
  }
  if (state.event_from_department_id == null || state.event_from_department_id !== state.org_department_id) {
    return 'отдел события увольнения ≠ текущему отделу сотрудника';
  }
  if (state.skud_after_dismissal > 0) return `проходы СКУД после ${dismissalDate}: ${state.skud_after_dismissal}`;
  if (state.open_assignments.length !== 1) {
    return `открытых назначений ${state.open_assignments.length}, ожидалось одно — «Уволенные»`;
  }
  const [open] = state.open_assignments;
  const archiveFrom = addDaysIso(dismissalDate, 1);
  if (open.org_department_id !== archiveDepartmentId || open.effective_from !== archiveFrom) {
    return `открытое назначение не «Уволенные» с ${archiveFrom}`;
  }
  return null;
};

const loadState = async (employeeId: number): Promise<IOrphanClaimState | null> => (
  queryOne<IOrphanClaimState>(
    `SELECT e.full_name,
            e.employment_status,
            e.dismissal_date::text AS dismissal_date,
            e.dismissal_apply_started_at::text AS claim_at,
            (e.dismissal_apply_started_at < $2::timestamptz) AS claim_before_cutoff,
            e.lifecycle_revision,
            e.org_department_id::text AS org_department_id,
            (SELECT count(*)::int FROM employee_lifecycle_operations o
              WHERE o.employee_id = e.id AND o.status = 'pending') AS pending_operations,
            ev.dismissal_date::text AS event_dismissal_date,
            ev.from_department_id::text AS event_from_department_id,
            ev.cancelled AS event_cancelled,
            ev.rehired AS event_rehired,
            (SELECT count(*)::int FROM skud_events s
              WHERE s.employee_id = e.id AND s.event_date > ev.dismissal_date) AS skud_after_dismissal,
            COALESCE((SELECT json_agg(json_build_object(
                               'org_department_id', a.org_department_id::text,
                               'effective_from', a.effective_from::text) ORDER BY a.effective_from)
                        FROM employee_assignments a
                       WHERE a.employee_id = e.id AND a.effective_to IS NULL), '[]'::json) AS open_assignments
       FROM employees e
       LEFT JOIN LATERAL (
         SELECT d.dismissal_date, d.from_department_id, d.cancelled, d.rehired
           FROM employee_dismissal_events d
          WHERE d.employee_id = e.id
          ORDER BY d.created_at DESC
          LIMIT 1
       ) ev ON true
      WHERE e.id = $1`,
    [employeeId, ORPHAN_CLAIM_CUTOFF],
  )
);

/** Снять claim: вся сигнатура — в WHERE, ровно одна строка, аудит той же транзакцией. */
const clearOrphanClaim = async (
  client: PoolClient,
  target: IOrphanClaimTarget,
  state: IOrphanClaimState,
): Promise<void> => {
  const updated = await client.query(
    `UPDATE employees e
        SET dismissal_apply_started_at = NULL,
            lifecycle_revision = lifecycle_revision + 1,
            updated_at = now()
      WHERE e.id = $1
        AND e.employment_status = 'active'
        AND e.dismissal_date IS NULL
        AND e.dismissal_apply_started_at < $2::timestamptz
        AND e.lifecycle_revision = 0
        AND NOT EXISTS (SELECT 1 FROM employee_lifecycle_operations o
                         WHERE o.employee_id = e.id AND o.status = 'pending')`,
    [target.employeeId, ORPHAN_CLAIM_CUTOFF],
  );
  if (updated.rowCount !== 1) {
    throw new OrphanClaimRepairError(`ожидалась 1 строка, обновлено ${updated.rowCount ?? 0} — состояние изменилось`);
  }
  await auditService.logWithClient(client, {
    user_id: null,
    action: 'RECONCILE_EMPLOYEE_REHIRE',
    entity_type: 'employee',
    entity_id: String(target.employeeId),
    details: { source: AUDIT_SOURCE, claim_at: state.claim_at, last_dismissal_date: state.event_dismissal_date },
  });
};

const rehireOne = async (
  target: IOrphanClaimTarget,
  state: IOrphanClaimState,
  apply: boolean,
): Promise<TOrphanClaimResult> => {
  try {
    await withTransaction(async (client) => {
      await clearOrphanClaim(client, target, state);
      if (!apply) throw new DryRunRollback();
    });
  } catch (error) {
    if (error instanceof DryRunRollback) return { status: 'planned' };
    throw error;
  }
  return { status: 'claim_cleared' };
};

const dismissOne = async (
  target: IOrphanClaimTarget,
  state: IOrphanClaimState,
  apply: boolean,
): Promise<TOrphanClaimResult> => {
  const dismissalDate = state.event_dismissal_date as string;
  if (!apply) return { status: 'planned', dismissalDate };

  // expectedRevision 0 — CAS: любое увольнение/отмена/восстановление после проверки сдвинет версию → 409.
  const operation = await openDismissOperation({
    employeeId: target.employeeId,
    dismissalDate,
    source: 'manual',
    createdBy: null,
    claimedAt: state.claim_at,
    expectedRevision: 0,
    effectiveDate: addDaysIso(dismissalDate, 1),
    sigurSteps: 'full',
  });
  await auditService.log({
    user_id: null,
    action: 'FIX_SYNC_REVERTED_DISMISSAL',
    entity_type: 'employee',
    entity_id: String(target.employeeId),
    details: { source: AUDIT_SOURCE, dismissal_date: dismissalDate, operation_id: operation.id, claim_at: state.claim_at },
  });
  try {
    await executeOperation(operation);
  } catch (error) {
    if (error instanceof DismissalSigurError) {
      return { status: 'sigur_pending', dismissalDate, operationId: operation.id, error: error.message };
    }
    throw error;
  }
  return { status: 'dismissed', dismissalDate, operationId: operation.id };
};

export const repairOrphanDismissalClaims = async (
  targets: readonly IOrphanClaimTarget[],
  options: { apply: boolean },
): Promise<IOrphanClaimItem[]> => {
  validateTargets(targets);

  const names = new Map((await query<{ id: number; full_name: string | null }>(
    'SELECT id, full_name FROM employees WHERE id = ANY($1::int[])',
    [targets.map(target => target.employeeId)],
  )).map(row => [Number(row.id), row.full_name]));
  const mismatched = targets.filter(target => normalizeName(names.get(target.employeeId) ?? '') !== normalizeName(target.fullName));
  if (mismatched.length > 0) {
    throw new OrphanClaimRepairError(`ФИО не совпадает с id: ${mismatched
      .map(target => `${target.employeeId} «${target.fullName}» ≠ «${names.get(target.employeeId) ?? 'нет такого'}»`)
      .join('; ')}`);
  }

  const archive = await queryOne<{ id: string }>(
    `SELECT value AS id FROM system_settings WHERE key = 'employees_archive_department_id'`,
  );
  if (!archive?.id) throw new OrphanClaimRepairError('Не задан employees_archive_department_id');

  // По одному: ошибка у сотрудника не откатывает уже применённых и не останавливает остальных.
  const items: IOrphanClaimItem[] = [];
  for (const target of targets) {
    const item = { employeeId: target.employeeId, fullName: target.fullName, outcome: target.outcome };
    try {
      const state = await loadState(target.employeeId);
      if (!state) {
        items.push({ ...item, result: { status: 'skipped', reason: 'сотрудник не найден' } });
        continue;
      }
      const violation = incidentSignatureViolation(state)
        ?? (target.outcome === 'confirmed_fired' ? firedPreconditionViolation(state, target, archive.id) : null);
      if (violation) {
        items.push({ ...item, result: { status: 'skipped', reason: violation } });
        continue;
      }
      const result = target.outcome === 'legitimate_rehire'
        ? await rehireOne(target, state, options.apply)
        : await dismissOne(target, state, options.apply);
      items.push({ ...item, result });
    } catch (error) {
      items.push({ ...item, result: { status: 'failed', error: error instanceof Error ? error.message : String(error) } });
    }
  }
  return items;
};
