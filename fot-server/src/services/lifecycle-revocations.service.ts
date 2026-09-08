import type { PoolClient } from 'pg';

/**
 * Снимок полномочий, снятых увольнением, и их возврат при восстановлении.
 *
 * Зачем: до появления снимка увольнение было необратимым — гасились доступы к
 * отделам и связи «личный руководитель», а восстановление возвращало только один
 * технический доступ. Ошибочное автоувольнение из Sigur стоило человеку всех
 * полномочий, и вернуть их можно было лишь руками по памяти.
 *
 * Всё пишется тем же клиентом, что и смена статуса, то есть в CAS-транзакции:
 * не применилось увольнение — нет и снимка. Строки доступов и связей не удаляются,
 * снимок лишь помнит, какие из них погасило конкретное увольнение.
 */

type Client = Pick<PoolClient, 'query'>;

export interface IRestoreConflict {
  kind: 'direct_report';
  subordinateEmployeeId: number;
  /** Кто ведёт подчинённого сейчас — его назначили, пока сотрудник был уволен. */
  currentManagerEmployeeId: number;
}

export interface IRestoreResult {
  departmentAccessRestored: number;
  directReportsRestored: number;
  conflicts: IRestoreConflict[];
}

/**
 * Гасит доступы сотрудника к отделам, сохранив снимок. Раньше это делалось вне
 * транзакции: при конфликте CAS увольнение не применялось, а доступы уже исчезали.
 */
export async function revokeDepartmentAccessWithSnapshot(
  client: Client,
  operationId: string,
  employeeId: number,
): Promise<number> {
  const revoked = await client.query<{ id: string; department_id: string; source: string | null }>(
    `UPDATE employee_department_access
        SET is_active = false, updated_at = now()
      WHERE employee_id = $1 AND is_active = true
      RETURNING id, department_id, source`,
    [employeeId],
  );
  for (const row of revoked.rows) {
    await client.query(
      `INSERT INTO employee_lifecycle_revocations (operation_id, employee_id, kind, row_id, payload)
       VALUES ($1, $2, 'department_access', $3, $4::jsonb)
       ON CONFLICT (operation_id, kind, row_id) DO NOTHING`,
      [operationId, employeeId, String(row.id), JSON.stringify({
        department_id: row.department_id,
        source: row.source,
      })],
    );
  }
  return revoked.rowCount ?? 0;
}

/**
 * Снимает подчинённых, для которых увольняемый был личным руководителем.
 *
 * Только сторона руководителя: уволенный подчинённый должен остаться в списке
 * своего живого начальника до конца периода — его и так обрезает
 * excluded_from_timesheet_date.
 *
 * Возвращает id подчинённых, оставшихся без личного руководителя, — вызывающий
 * решает, нужно ли предупредить.
 */
export async function revokeDirectReportsWithSnapshot(
  client: Client,
  operationId: string,
  managerEmployeeId: number,
): Promise<number[]> {
  const revoked = await client.query<{ id: string; subordinate_employee_id: number; note: string | null }>(
    `UPDATE employee_direct_reports
        SET is_active = false, unassigned_at = now(), updated_at = now()
      WHERE manager_employee_id = $1 AND is_active = true
      RETURNING id, subordinate_employee_id, note`,
    [managerEmployeeId],
  );
  for (const row of revoked.rows) {
    await client.query(
      `INSERT INTO employee_lifecycle_revocations (operation_id, employee_id, kind, row_id, payload)
       VALUES ($1, $2, 'direct_report', $3, $4::jsonb)
       ON CONFLICT (operation_id, kind, row_id) DO NOTHING`,
      [operationId, managerEmployeeId, String(row.id), JSON.stringify({
        subordinate_employee_id: row.subordinate_employee_id,
        manager_employee_id: managerEmployeeId,
        note: row.note,
      })],
    );
  }
  return revoked.rows.map(r => Number(r.subordinate_employee_id));
}

/** Последнее применённое увольнение сотрудника — источник снимка для восстановления. */
export async function findLastAppliedDismissOperationId(
  client: Client,
  employeeId: number,
): Promise<string | null> {
  const row = await client.query<{ id: string }>(
    `SELECT id FROM employee_lifecycle_operations
      WHERE employee_id = $1 AND kind = 'dismiss' AND status = 'applied'
      ORDER BY created_at DESC
      LIMIT 1`,
    [employeeId],
  );
  return row.rows[0]?.id ?? null;
}

/**
 * Возвращает полномочия из снимка увольнения.
 *
 * Правило разрешения конфликтов: ручное назначение имеет приоритет. Если за время
 * увольнения подчинённого отдали другому руководителю, связь не перетирается —
 * уникальный индекс всё равно не дал бы двух активных руководителей, а тихо
 * отобрать человека у нового начальника хуже, чем показать конфликт админу.
 */
export async function restoreFromSnapshot(
  client: Client,
  operationId: string,
  employeeId: number,
): Promise<IRestoreResult> {
  const snapshot = await client.query<{ kind: string; row_id: string; payload: Record<string, unknown> }>(
    `SELECT kind, row_id, payload
       FROM employee_lifecycle_revocations
      WHERE operation_id = $1
      ORDER BY created_at`,
    [operationId],
  );

  const conflicts: IRestoreConflict[] = [];
  let departmentAccessRestored = 0;
  let directReportsRestored = 0;

  for (const row of snapshot.rows) {
    if (row.kind === 'department_access') {
      // Строку, которую после увольнения кто-то снова включил или переписал,
      // не трогаем: is_active = false в условии делает возврат идемпотентным.
      const res = await client.query(
        `UPDATE employee_department_access
            SET is_active = true, updated_at = now()
          WHERE id = $1 AND employee_id = $2 AND is_active = false`,
        [row.row_id, employeeId],
      );
      departmentAccessRestored += res.rowCount ?? 0;
      continue;
    }

    if (row.kind === 'direct_report') {
      const subordinateId = Number(row.payload?.subordinate_employee_id);
      if (!Number.isInteger(subordinateId)) continue;

      const current = await client.query<{ manager_employee_id: number }>(
        `SELECT manager_employee_id FROM employee_direct_reports
          WHERE subordinate_employee_id = $1 AND is_active = true
          LIMIT 1`,
        [subordinateId],
      );
      const currentManager = current.rows[0]?.manager_employee_id;
      if (currentManager != null) {
        if (Number(currentManager) !== employeeId) {
          conflicts.push({
            kind: 'direct_report',
            subordinateEmployeeId: subordinateId,
            currentManagerEmployeeId: Number(currentManager),
          });
        }
        continue;
      }

      const res = await client.query(
        `UPDATE employee_direct_reports
            SET is_active = true, unassigned_at = NULL, updated_at = now()
          WHERE id = $1 AND manager_employee_id = $2 AND is_active = false`,
        [row.row_id, employeeId],
      );
      directReportsRestored += res.rowCount ?? 0;
    }
  }

  return { departmentAccessRestored, directReportsRestored, conflicts };
}
