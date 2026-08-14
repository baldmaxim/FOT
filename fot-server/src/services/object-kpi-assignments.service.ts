import type { PoolClient } from 'pg';

import { query } from '../config/postgres.js';
import { moscowTodayIso } from '../utils/date.utils.js';
import { failNotFound, failStaleVersion, failWith } from './object-kpi-errors.js';
import { recordObjectKpiHistory, type ObjectKpiActor } from './object-kpi-history.service.js';
import { invalidateObjectKpiRolesCache } from './object-kpi-roles-cache.service.js';

/**
 * Закрепление объектов за людьми (object_kpi_assignments) и внесистемные роли KPI
 * (object_kpi_global_roles).
 *
 * Обе сущности ведутся одной модалкой «Назначения», но права на них разные:
 * закрепление — право edit на вкладку «KPI объектов», глобальная роль — только админ
 * (иначе экономист выдал бы сам себе право пересматривать закрытые месяцы).
 * Разграничение делают гарды роутов; сервис обе операции просто выполняет.
 */

export type AssignmentRoleKind = 'construction_manager' | 'object_economist';

export interface ObjectKpiAssignmentRow {
  id: string;
  skud_object_id: string;
  object_name: string | null;
  employee_id: number;
  employee_name: string | null;
  role_kind: AssignmentRoleKind;
  valid_from: string;
  valid_to: string | null;
  source: 'manual' | 'skud_import';
  notes: string | null;
  version: number;
}

export interface ObjectKpiGlobalRoleRow {
  id: string;
  employee_id: number;
  employee_name: string | null;
  role_kind: 'economics_head';
  valid_from: string;
  valid_to: string | null;
  notes: string | null;
  version: number;
}

const ASSIGNMENT_COLUMNS = `
  a.id, a.skud_object_id, o.name AS object_name, a.employee_id, e.full_name AS employee_name,
  a.role_kind,
  to_char(a.valid_from, 'YYYY-MM-DD') AS valid_from,
  to_char(a.valid_to,   'YYYY-MM-DD') AS valid_to,
  a.source, a.notes, a.version`;

const GLOBAL_ROLE_COLUMNS = `
  g.id, g.employee_id, e.full_name AS employee_name, g.role_kind,
  to_char(g.valid_from, 'YYYY-MM-DD') AS valid_from,
  to_char(g.valid_to,   'YYYY-MM-DD') AS valid_to,
  g.notes, g.version`;

/** 23P01 — нарушение EXCLUDE: пересечение периодов. */
const EXCLUSION_VIOLATION = '23P01';

const rethrowOverlap = (error: unknown, message: string): never => {
  if ((error as { code?: string }).code === EXCLUSION_VIOLATION) {
    failWith({ http: 409, code: 'period_overlap', message });
  }
  throw error;
};

// ─── Закрепления ────────────────────────────────────────────────────────────

export async function listAssignments(filters: {
  objectId?: string;
  employeeId?: number;
  roleKind?: AssignmentRoleKind;
  activeOnly?: boolean;
}): Promise<ObjectKpiAssignmentRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.objectId) {
    params.push(filters.objectId);
    conditions.push(`a.skud_object_id = $${params.length}`);
  }
  if (filters.employeeId) {
    params.push(filters.employeeId);
    conditions.push(`a.employee_id = $${params.length}`);
  }
  if (filters.roleKind) {
    params.push(filters.roleKind);
    conditions.push(`a.role_kind = $${params.length}`);
  }
  if (filters.activeOnly) {
    params.push(moscowTodayIso());
    conditions.push(`a.valid_from <= $${params.length}::date AND (a.valid_to IS NULL OR a.valid_to >= $${params.length}::date)`);
  }

  return query<ObjectKpiAssignmentRow>(
    `SELECT ${ASSIGNMENT_COLUMNS}
       FROM object_kpi_assignments a
       JOIN skud_objects o ON o.id = a.skud_object_id
       LEFT JOIN employees e ON e.id = a.employee_id
      ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY o.name, a.role_kind, a.valid_from DESC`,
    params,
  );
}

export interface AssignmentInput {
  skud_object_id: string;
  employee_id: number;
  role_kind: AssignmentRoleKind;
  valid_from: string;
  valid_to?: string | null;
  notes?: string | null;
}

export async function createAssignment(
  client: PoolClient,
  actor: ObjectKpiActor,
  input: AssignmentInput,
): Promise<ObjectKpiAssignmentRow> {
  let id: string;
  try {
    const result = await client.query<{ id: string }>(
      `INSERT INTO object_kpi_assignments (
         skud_object_id, employee_id, role_kind, valid_from, valid_to, source, notes,
         created_by, updated_by
       ) VALUES ($1,$2,$3,$4,$5,'manual',$6,$7,$7)
       RETURNING id`,
      [
        input.skud_object_id,
        input.employee_id,
        input.role_kind,
        input.valid_from,
        input.valid_to ?? null,
        input.notes ?? null,
        actor.userId,
      ],
    );
    id = result.rows[0].id;
  } catch (error) {
    return rethrowOverlap(
      error,
      'На объекте уже есть руководитель строительства в этот период — закройте прежнее закрепление датой «по»',
    );
  }

  const row = (await loadAssignment(client, id))!;
  await recordObjectKpiHistory(client, {
    skudObjectId: row.skud_object_id,
    entityKind: 'assignment',
    entityId: row.id,
    action: 'create',
    after: { ...row },
    actor,
  });
  return row;
}

async function loadAssignment(
  client: PoolClient,
  id: string,
): Promise<ObjectKpiAssignmentRow | null> {
  const result = await client.query<ObjectKpiAssignmentRow>(
    `SELECT ${ASSIGNMENT_COLUMNS}
       FROM object_kpi_assignments a
       JOIN skud_objects o ON o.id = a.skud_object_id
       LEFT JOIN employees e ON e.id = a.employee_id
      WHERE a.id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/**
 * Правится только период и примечание. Смена объекта или человека — это другое
 * закрепление: подмена «на месте» переписала бы историю ответственности задним числом.
 */
export async function updateAssignment(
  client: PoolClient,
  actor: ObjectKpiActor,
  id: string,
  expectedVersion: number,
  patch: { valid_from?: string; valid_to?: string | null; notes?: string | null },
): Promise<ObjectKpiAssignmentRow> {
  const before = await loadAssignment(client, id);
  if (!before) failNotFound('Закрепление');

  const fields = ['valid_from', 'valid_to', 'notes'] as const;
  const entries = fields.filter((f) => patch[f] !== undefined).map((f) => [f, patch[f]] as const);
  if (entries.length === 0) return before!;

  const setSql = entries.map(([field], i) => `${field} = $${i + 4}`).join(', ');
  let changed = 0;
  try {
    const result = await client.query(
      `UPDATE object_kpi_assignments
          SET ${setSql}, version = version + 1, updated_by = $3, updated_at = now()
        WHERE id = $1 AND version = $2`,
      [id, expectedVersion, actor.userId, ...entries.map(([, value]) => value)],
    );
    changed = result.rowCount ?? 0;
  } catch (error) {
    return rethrowOverlap(error, 'Период пересекается с другим закреплением руководителя на этом объекте');
  }
  if (changed === 0) failStaleVersion();

  const after = (await loadAssignment(client, id))!;
  await recordObjectKpiHistory(client, {
    skudObjectId: after.skud_object_id,
    entityKind: 'assignment',
    entityId: id,
    action: 'update',
    before: { ...before },
    after: { ...after },
    actor,
  });
  return after;
}

/**
 * Физически удаляется только закрепление, которое ещё не началось. Начавшееся
 * закрывается датой «по»: за прошедшие месяцы человек отвечал, и удаление записи
 * оставило бы отчёт без руководителя.
 */
export async function deleteAssignment(
  client: PoolClient,
  actor: ObjectKpiActor,
  id: string,
  expectedVersion: number,
): Promise<void> {
  const before = await loadAssignment(client, id);
  if (!before) failNotFound('Закрепление');

  if (before!.valid_from <= moscowTodayIso()) {
    failWith({
      http: 409,
      code: 'assignment_started',
      message: 'Закрепление уже действовало — закройте его датой «по», удалить нельзя',
    });
  }

  const result = await client.query(
    'DELETE FROM object_kpi_assignments WHERE id = $1 AND version = $2',
    [id, expectedVersion],
  );
  if ((result.rowCount ?? 0) === 0) failStaleVersion();

  await recordObjectKpiHistory(client, {
    skudObjectId: before!.skud_object_id,
    entityKind: 'assignment',
    entityId: id,
    action: 'delete',
    before: { ...before },
    actor,
  });
}

// ─── Глобальные роли (руководитель эк. отдела) ──────────────────────────────

export async function listGlobalRoles(): Promise<ObjectKpiGlobalRoleRow[]> {
  return query<ObjectKpiGlobalRoleRow>(
    `SELECT ${GLOBAL_ROLE_COLUMNS}
       FROM object_kpi_global_roles g
       LEFT JOIN employees e ON e.id = g.employee_id
      ORDER BY g.valid_from DESC`,
  );
}

export async function createGlobalRole(
  client: PoolClient,
  actor: ObjectKpiActor,
  input: { employee_id: number; valid_from: string; valid_to?: string | null; notes?: string | null },
): Promise<ObjectKpiGlobalRoleRow> {
  let id: string;
  try {
    const result = await client.query<{ id: string }>(
      `INSERT INTO object_kpi_global_roles (
         employee_id, role_kind, valid_from, valid_to, notes, created_by, updated_by
       ) VALUES ($1,'economics_head',$2,$3,$4,$5,$5)
       RETURNING id`,
      [input.employee_id, input.valid_from, input.valid_to ?? null, input.notes ?? null, actor.userId],
    );
    id = result.rows[0].id;
  } catch (error) {
    return rethrowOverlap(error, 'У сотрудника уже есть эта роль в пересекающийся период');
  }

  const row = (await loadGlobalRole(client, id))!;
  await recordObjectKpiHistory(client, {
    skudObjectId: null,  // роль не привязана к объекту
    entityKind: 'global_role',
    entityId: id,
    action: 'create',
    after: { ...row },
    actor,
  });
  // Кэш держит Set активных employee_id и обновляется раз в 5 минут: без сброса
  // человек не увидел бы вкладку до истечения TTL.
  invalidateObjectKpiRolesCache();
  return row;
}

async function loadGlobalRole(
  client: PoolClient,
  id: string,
): Promise<ObjectKpiGlobalRoleRow | null> {
  const result = await client.query<ObjectKpiGlobalRoleRow>(
    `SELECT ${GLOBAL_ROLE_COLUMNS}
       FROM object_kpi_global_roles g
       LEFT JOIN employees e ON e.id = g.employee_id
      WHERE g.id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/**
 * Снятие роли. Начавшийся период закрывается вчерашним днём, ещё не начавшийся —
 * удаляется. Та же логика, что у закреплений: история прав не переписывается.
 */
export async function revokeGlobalRole(
  client: PoolClient,
  actor: ObjectKpiActor,
  id: string,
): Promise<void> {
  const before = await loadGlobalRole(client, id);
  if (!before) failNotFound('Роль');

  const today = moscowTodayIso();
  if (before!.valid_from > today) {
    await client.query('DELETE FROM object_kpi_global_roles WHERE id = $1', [id]);
  } else {
    await client.query(
      `UPDATE object_kpi_global_roles
          SET valid_to = LEAST(COALESCE(valid_to, $2::date), $2::date),
              version = version + 1, updated_by = $3, updated_at = now()
        WHERE id = $1`,
      [id, today, actor.userId],
    );
  }

  const after = await loadGlobalRole(client, id);
  await recordObjectKpiHistory(client, {
    skudObjectId: null,
    entityKind: 'global_role',
    entityId: id,
    action: before!.valid_from > today ? 'delete' : 'update',
    before: { ...before },
    after: after ? { ...after } : null,
    reason: 'Снятие роли',
    actor,
  });
  invalidateObjectKpiRolesCache();
}
