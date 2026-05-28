import { query, queryOne } from '../config/postgres.js';

// Resolver-ы получателей realtime-событий по доменам.
// Цель — централизовать «кто слушатель» для emitDomainChange, не дублируя в каждом контроллере.
//
// Возвращаем массив user_profiles.id строк (для io.to('user:'+uid)).

/**
 * Получатели событий по заявке на отпуск/больничный/корректировку.
 * Включает: автора (через employee_id → user_profiles.id) + его supervisor_id.
 * Опционально reviewerUserId (тот, кто approve/reject) — чтобы у него тоже очередь обновилась.
 */
export async function getLeaveRequestRecipients(
  employeeId: number,
  reviewerUserId?: string | null,
): Promise<string[]> {
  const row = await queryOne<{ id: string | null; supervisor_id: string | null }>(
    'SELECT id, supervisor_id FROM user_profiles WHERE employee_id = $1 LIMIT 1',
    [employeeId],
  );
  const recipients = new Set<string>();
  if (row?.id) recipients.add(row.id);
  if (row?.supervisor_id) recipients.add(row.supervisor_id);
  if (reviewerUserId) recipients.add(reviewerUserId);
  return Array.from(recipients);
}

/**
 * Получатели для пользователя по employee_id (без supervisor) — только сам владелец.
 * Используется для payslip/payment/private документов.
 */
export async function getEmployeeUserId(employeeId: number): Promise<string | null> {
  const row = await queryOne<{ id: string | null }>(
    'SELECT id FROM user_profiles WHERE employee_id = $1 LIMIT 1',
    [employeeId],
  );
  return row?.id ?? null;
}

/**
 * Получатели для daily_task / приватных событий сотрудника:
 * сам владелец + его supervisor. Используется в daily-tasks, payslip, payment, patent-receipts.
 */
export async function getEmployeeOwnerAndSupervisor(employeeId: number): Promise<string[]> {
  const row = await queryOne<{ id: string | null; supervisor_id: string | null }>(
    'SELECT id, supervisor_id FROM user_profiles WHERE employee_id = $1 LIMIT 1',
    [employeeId],
  );
  const recipients = new Set<string>();
  if (row?.id) recipients.add(row.id);
  if (row?.supervisor_id) recipients.add(row.supervisor_id);
  return Array.from(recipients);
}

/**
 * Резолв массива employee_id → массив user_id (для batch-эмитов).
 * Сотрудники без user_profiles пропускаются (никому в этом случае не шлём).
 */
export async function getUserIdsByEmployeeIds(employeeIds: number[]): Promise<string[]> {
  const ids = employeeIds.filter((n) => Number.isFinite(n));
  if (ids.length === 0) return [];
  const rows = await query<{ id: string }>(
    'SELECT id FROM user_profiles WHERE employee_id = ANY($1::bigint[])',
    [ids],
  );
  return rows.map((r) => r.id);
}
