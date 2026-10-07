/**
 * Причина блокировки сотрудника Sigur — из audit_logs.
 *
 * Берётся последняя запись блокировки/разблокировки через FOT. Если последняя —
 * разблокировка или записей нет, причины нет: сотрудника могли заблокировать
 * увольнение, чёрный список, сценарии подрядчиков или Sigur Manager напрямую,
 * а они пишут журнал по-своему или не пишут вовсе.
 */
import { queryOne } from '../config/postgres.js';

export interface ISigurEmployeeBlockInfo {
  blockedAt: string;
  blockedByName: string | null;
  /** null — старая блокировка, сделанная до обязательной причины. */
  reason: string | null;
}

interface ISigurEmployeeBlockRow {
  action: string;
  created_at: Date | string;
  reason: string | null;
  actor_name: string | null;
}

const SIGUR_EMPLOYEE_BLOCK_SQL = `
  SELECT a.details->>'action' AS action,
         a.created_at,
         NULLIF(btrim(a.details->>'reason'), '') AS reason,
         up.full_name AS actor_name
    FROM audit_logs a
    LEFT JOIN user_profiles up ON up.id = a.user_id
   WHERE a.entity_type = 'sigur_employee'
     AND a.entity_id = $1::text
     AND a.details->>'action' IN ('block', 'unblock')
   ORDER BY a.created_at DESC, a.id DESC
   LIMIT 1
`;

export async function getSigurEmployeeBlockInfo(
  sigurEmployeeId: number,
): Promise<ISigurEmployeeBlockInfo | null> {
  const row = await queryOne<ISigurEmployeeBlockRow>(SIGUR_EMPLOYEE_BLOCK_SQL, [String(sigurEmployeeId)]);
  if (!row || row.action !== 'block') return null;

  return {
    blockedAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
    blockedByName: row.actor_name,
    reason: row.reason,
  };
}
