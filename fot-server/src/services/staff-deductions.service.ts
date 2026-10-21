/**
 * «Удержания» (миграция 318): кадры назначают сотруднику удержание — вид, месяц удержания, сумма.
 *
 * Строка — одно удержание; повторное того же вида в том же месяце — новая строка. Вид — из общего
 * с «Зарплатой» справочника payroll_deduction_kinds. Отдел и должность — текущие, как в списке кадров.
 */
import type { PoolClient } from 'pg';

import { query, queryOne, withTransaction } from '../config/postgres.js';
import { hasPgCode, PG_FOREIGN_KEY_VIOLATION } from './payroll/payroll-pg-errors.js';

export interface IStaffDeduction {
  id: number;
  employee_id: number;
  full_name: string;
  department: string | null;
  position: string | null;
  kind_id: number;
  kind_name: string;
  /** YYYY-MM. */
  month: string;
  /** NUMERIC как строка: «5000.00». */
  amount: string;
}

export interface IStaffDeductionInput {
  kind_id: number;
  /** YYYY-MM. */
  month: string;
  amount: number;
}

/** Вида уже нет в справочнике (удалили в соседнем окне) — FK при записи. */
export type StaffDeductionKindMissing = 'kind_missing';

const DEDUCTION_SELECT = `
  SELECT s.id, s.employee_id, e.full_name, d.name AS department, p.name AS position,
         s.kind_id, k.name AS kind_name,
         to_char(s.month, 'YYYY-MM') AS month,
         s.amount::text AS amount
    FROM staff_deductions s
    JOIN employees e ON e.id = s.employee_id
    JOIN payroll_deduction_kinds k ON k.id = s.kind_id
    LEFT JOIN org_departments d ON d.id = e.org_department_id
    LEFT JOIN positions p ON p.id = e.position_id`;

/** Удержания в порядке ФИО и месяца. employeeIds — охват (null — без ограничения); пустой — пустой ответ. */
export const listDeductions = async (scope: { employeeIds: number[] | null }): Promise<IStaffDeduction[]> => {
  if (scope.employeeIds?.length === 0) return [];
  return query<IStaffDeduction>(
    `${DEDUCTION_SELECT}
      WHERE ($1::int[] IS NULL OR s.employee_id = ANY($1::int[]))
      ORDER BY e.full_name, s.month, s.id`,
    [scope.employeeIds],
  );
};

export const getDeduction = async (id: number): Promise<IStaffDeduction | null> =>
  queryOne<IStaffDeduction>(`${DEDUCTION_SELECT} WHERE s.id = $1`, [id]);

/** Строка внутри транзакции; lock — FOR UPDATE: правка и удаление видят одно «было». */
const readDeduction = async (client: PoolClient, id: number, lock: boolean): Promise<IStaffDeduction | null> =>
  (await client.query<IStaffDeduction>(`${DEDUCTION_SELECT} WHERE s.id = $1${lock ? ' FOR UPDATE OF s' : ''}`, [id]))
    .rows[0] ?? null;

/** Добавить удержание; вида нет — 'kind_missing'. */
export const addDeduction = async (
  employeeId: number,
  input: IStaffDeductionInput,
): Promise<IStaffDeduction | StaffDeductionKindMissing> => {
  try {
    const row = await queryOne<{ id: number }>(
      `INSERT INTO staff_deductions (employee_id, kind_id, month, amount)
       VALUES ($1, $2, $3::date, $4) RETURNING id`,
      [employeeId, input.kind_id, `${input.month}-01`, input.amount],
    );
    const deduction = row ? await getDeduction(row.id) : null;
    if (!deduction) throw new Error('Удержание не найдено после добавления');
    return deduction;
  } catch (err) {
    if (hasPgCode(err, PG_FOREIGN_KEY_VIOLATION)) return 'kind_missing';
    throw err;
  }
};

/**
 * Изменить вид, месяц и сумму. Удержания нет — null; вида нет — 'kind_missing'.
 * Возвращает прежнюю и новую строки: аудит пишет «было → стало».
 */
export const updateDeduction = async (
  id: number,
  input: IStaffDeductionInput,
): Promise<{ before: IStaffDeduction; after: IStaffDeduction } | StaffDeductionKindMissing | null> => {
  try {
    return await withTransaction(async client => {
      const before = await readDeduction(client, id, true);
      if (!before) return null;
      await client.query(
        `UPDATE staff_deductions
            SET kind_id = $2, month = $3::date, amount = $4, updated_at = now()
          WHERE id = $1`,
        [id, input.kind_id, `${input.month}-01`, input.amount],
      );
      const after = await readDeduction(client, id, false);
      return after ? { before, after } : null;
    });
  } catch (err) {
    if (hasPgCode(err, PG_FOREIGN_KEY_VIOLATION)) return 'kind_missing';
    throw err;
  }
};

/** Удалить удержание; его нет — null. */
export const deleteDeduction = async (id: number): Promise<IStaffDeduction | null> =>
  withTransaction(async client => {
    const before = await readDeduction(client, id, true);
    if (!before) return null;
    await client.query(`DELETE FROM staff_deductions WHERE id = $1`, [id]);
    return before;
  });
