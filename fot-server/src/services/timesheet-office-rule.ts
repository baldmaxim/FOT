/**
 * Окно «Режим табелирования» (миграция 291) — общее правило для ночного расчёта и окна.
 *
 * Назначение конкретному сотруднику — личный «Офис» или объект — хранится в полях
 * сотрудника: current_activity или object + id, set_by = NULL и автор (289), признак —
 * personalPinSql. «Офис» отдела — строка timesheet_office_departments: всем прямым своим
 * работающим сотрудникам отдела объект «Офис» с set_by = 'auto'. Подотделы правило не
 * получают. Личное назначение главнее отдела: правило отдела его не трогает — ни при
 * постановке «Офиса» отделу, ни при переводе в такой отдел; снято — сотрудник получает
 * «Офис» отдела. Кому объект поставлен в окне — лично или через отдел, — тому ночной расчёт
 * объект по часам не ставит.
 *
 * SQL собирается функциями, а AUDIT_ACTIONS читается только внутри функций: тесты с моком
 * audit.service без новых ключей грузят этот модуль транзитивно.
 */
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { AUDIT_ACTIONS, auditService } from './audit.service.js';
import { frozenPersonalPinSql, personalPinSql, type TimesheetExportMode } from './timesheet-export-mode.service.js';
import type { TimesheetObjectSetBy } from './employee-timesheet-object.service.js';

export { frozenPersonalPinSql, personalPinSql };

/**
 * Личный «Офис» из окна — только «Офис», без объектов: для исторического скрипта
 * apply-office-window-month. Остальным путям — personalPinSql. По set_by_user_id не
 * проверяем: при удалении учётки FK его обнуляет, а дата остаётся. NULL-безопасно.
 */
export function personalOfficeSql(alias: string): string {
  return `(${alias}.timesheet_export_mode IS NOT DISTINCT FROM 'current_activity'
      AND ${alias}.timesheet_export_object_id IS NULL
      AND ${alias}.timesheet_export_set_by IS NULL
      AND ${alias}.timesheet_export_set_at IS NOT NULL)`;
}

/** «Офис» от авто — ночного расчёта или правила отдела. */
function autoOfficeSql(alias: string): string {
  return `(${alias}.timesheet_export_mode IS NOT DISTINCT FROM 'current_activity'
      AND ${alias}.timesheet_export_set_by IS NOT DISTINCT FROM 'auto')`;
}

export interface IOfficeRuleChange {
  employeeId: number;
  fullName: string | null;
  departmentId: string;
  fromMode: TimesheetExportMode | null;
  fromObjectId: string | null;
  fromSetBy: TimesheetObjectSetBy | null;
}

interface IOfficeRuleRow {
  id: number | string;
  full_name: string | null;
  department_id: string;
  mode: TimesheetExportMode | null;
  object_id: string | null;
  set_by: TimesheetObjectSetBy | null;
}

/**
 * «Офис» отдела: прямым своим работающим сотрудникам отделов с правилом — current_activity,
 * set_by = 'auto' (автора обнулит триггер 289). Уже «Офис» от авто и личное назначение из
 * окна («Офис» или объект) не трогаются; всё остальное — любой источник, в том числе
 * прежний ручной выбор, — перебивается.
 *
 * Строки — FOR UPDATE по возрастанию id, условия повторены в UPDATE. Транзакция и лок
 * режимов (TIMESHEET_MODE_LOCK_KEY) — у вызывающего.
 */
export async function enforceOfficeForDepartments(
  client: PoolClient,
  departmentIds: readonly string[] | 'all',
  contractorIds: readonly string[],
): Promise<IOfficeRuleChange[]> {
  if (departmentIds !== 'all' && departmentIds.length === 0) return [];
  const eligible = `e.is_archived = false
        AND e.employment_status = 'active'
        AND NOT (e.org_department_id = ANY($1::uuid[]))
        AND NOT ${autoOfficeSql('e')}
        AND NOT ${personalPinSql('e')}`;

  const selected = (await client.query<IOfficeRuleRow>(
    `SELECT e.id,
            e.full_name,
            e.org_department_id::text          AS department_id,
            e.timesheet_export_mode            AS mode,
            e.timesheet_export_object_id::text AS object_id,
            e.timesheet_export_set_by          AS set_by
       FROM employees e
       JOIN timesheet_office_departments tod ON tod.org_department_id = e.org_department_id
      WHERE ${eligible}
        AND ($2::boolean OR e.org_department_id = ANY($3::uuid[]))
      ORDER BY e.id
      FOR UPDATE OF e`,
    [contractorIds, departmentIds === 'all', departmentIds === 'all' ? [] : departmentIds],
  )).rows;
  if (selected.length === 0) return [];

  const updated = new Set((await client.query<{ id: number | string }>(
    `UPDATE employees e
        SET timesheet_export_mode = 'current_activity',
            timesheet_export_object_id = NULL,
            timesheet_export_set_by = 'auto',
            updated_at = now()
       FROM timesheet_office_departments tod
      WHERE e.id = ANY($2::int[])
        AND tod.org_department_id = e.org_department_id
        AND ${eligible}
      RETURNING e.id`,
    [contractorIds, selected.map(row => Number(row.id))],
  )).rows.map(row => Number(row.id)));

  return selected
    .filter(row => updated.has(Number(row.id)))
    .map(row => ({
      employeeId: Number(row.id),
      fullName: row.full_name,
      departmentId: row.department_id,
      fromMode: row.mode,
      fromObjectId: row.object_id,
      fromSetBy: row.set_by,
    }));
}

export interface IOfficeAuditEntry {
  entityType: 'employee' | 'org_department';
  entityId: string;
  details: Record<string, unknown>;
}

/** Строки аудита для изменений правила отдела — по сотруднику. */
export function officeRuleAuditEntries(
  changes: readonly IOfficeRuleChange[],
  reason: string,
): IOfficeAuditEntry[] {
  return changes.map(change => ({
    entityType: 'employee',
    entityId: String(change.employeeId),
    details: {
      employee_name: change.fullName,
      via: 'department',
      department_id: change.departmentId,
      reason,
      old_mode: change.fromMode,
      old_object_id: change.fromObjectId,
      old_set_by: change.fromSetBy,
      new_mode: 'current_activity',
      new_object_id: null,
      new_set_by: 'auto',
    },
  }));
}

/**
 * Аудит TIMESHEET_OFFICE_UPDATED — в транзакции вызывающего: не записался аудит — не
 * записалось ничего. req есть у окна, у ночного расчёта — нет.
 */
export async function writeOfficeAudit(
  client: PoolClient,
  entries: readonly IOfficeAuditEntry[],
  actor: { req: Request | null; userId: string | null },
): Promise<void> {
  for (const entry of entries) {
    if (actor.req) {
      await auditService.logFromRequestWithClient(
        client, actor.req, actor.userId, AUDIT_ACTIONS.TIMESHEET_OFFICE_UPDATED,
        { entityType: entry.entityType, entityId: entry.entityId, details: entry.details },
      );
    } else {
      await auditService.logWithClient(client, {
        user_id: actor.userId,
        action: AUDIT_ACTIONS.TIMESHEET_OFFICE_UPDATED,
        entity_type: entry.entityType,
        entity_id: entry.entityId,
        details: entry.details,
      });
    }
  }
}
