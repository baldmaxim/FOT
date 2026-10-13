/**
 * Удержания «Зарплаты»: справочник видов (миграция 299) и виды сотрудника (миграция 300).
 *
 * Справочник — пункты списка «Вид» в «Удержании» окна сотрудника; пополняется там же, правится
 * и чистится в окне «Справочник» на «Расчётах». Вид, отмеченный у сотрудника, не удалить — FK RESTRICT.
 * У сотрудника видов может быть несколько; это не версия условий оплаты.
 */
import { query, queryOne, type DbExecutor } from '../../config/postgres.js';
import { hasPgCode, isPgReferencedRow, PG_UNIQUE_VIOLATION } from './payroll-pg-errors.js';

export interface IPayrollDeductionKind {
  id: number;
  name: string;
}

/** Новый вид — в конец списка, после стартовых. */
const NEW_KIND_SORT_ORDER = 1000;

export const listDeductionKinds = async (): Promise<IPayrollDeductionKind[]> =>
  query<IPayrollDeductionKind>(
    `SELECT id, name FROM payroll_deduction_kinds ORDER BY sort_order, id`,
  );

/** Все ли виды есть в справочнике (повторы не в счёт). Вид, удалённый следом, остановит FK при записи. */
export const allDeductionKindsExist = async (ids: readonly number[]): Promise<boolean> => {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return true;
  const rows = await query<{ id: number }>(
    `SELECT id FROM payroll_deduction_kinds WHERE id = ANY($1::int[])`,
    [unique],
  );
  return rows.length === unique.length;
};

/** Добавить вид. Такой уже есть (без учёта регистра и пробелов по краям) — null. */
export const addDeductionKind = async (name: string): Promise<IPayrollDeductionKind | null> => {
  try {
    return await queryOne<IPayrollDeductionKind>(
      `INSERT INTO payroll_deduction_kinds (name, sort_order) VALUES ($1, $2) RETURNING id, name`,
      [name, NEW_KIND_SORT_ORDER],
    );
  } catch (err) {
    if (hasPgCode(err, PG_UNIQUE_VIOLATION)) return null;
    throw err;
  }
};

/**
 * Переименовать вид. Вида нет — null; название занято другим видом — 'duplicate'.
 * Прежнее название возвращается для аудита («было → стало»).
 */
export const renameDeductionKind = async (
  id: number,
  name: string,
): Promise<{ kind: IPayrollDeductionKind; previousName: string } | 'duplicate' | null> => {
  try {
    const row = await queryOne<IPayrollDeductionKind & { previous_name: string }>(
      `UPDATE payroll_deduction_kinds k
          SET name = $2
         FROM (SELECT id, name FROM payroll_deduction_kinds WHERE id = $1 FOR UPDATE) prev
        WHERE k.id = prev.id
        RETURNING k.id, k.name, prev.name AS previous_name`,
      [id, name],
    );
    return row ? { kind: { id: row.id, name: row.name }, previousName: row.previous_name } : null;
  } catch (err) {
    if (hasPgCode(err, PG_UNIQUE_VIOLATION)) return 'duplicate';
    throw err;
  }
};

/**
 * Удалить вид. Вида нет — null; отмечен у сотрудников — { inUse: сколько их } (FK RESTRICT:
 * отдельной проверки перед удалением нет, гонку с отметкой решает сама БД).
 */
export const deleteDeductionKind = async (
  id: number,
): Promise<IPayrollDeductionKind | { inUse: number } | null> => {
  try {
    return await queryOne<IPayrollDeductionKind>(
      `DELETE FROM payroll_deduction_kinds WHERE id = $1 RETURNING id, name`,
      [id],
    );
  } catch (err) {
    if (!isPgReferencedRow(err)) throw err;
    const used = await queryOne<{ total: number }>(
      `SELECT count(*)::int AS total FROM payroll_employee_deductions WHERE kind_id = $1`,
      [id],
    );
    return { inUse: used?.total ?? 0 };
  }
};

/** Виды удержаний сотрудника — в порядке справочника. */
export const getEmployeeDeductionKindIds = async (employeeId: number): Promise<number[]> => (
  await query<{ kind_id: number }>(
    `SELECT d.kind_id
       FROM payroll_employee_deductions d
       JOIN payroll_deduction_kinds k ON k.id = d.kind_id
      WHERE d.employee_id = $1
      ORDER BY k.sort_order, k.id`,
    [employeeId],
  )
).map(row => row.kind_id);

/**
 * Заменить виды сотрудника набором kindIds: лишние снимаются, новые добавляются, прежние
 * не трогаются. Вызывать в транзакции. Возвращает реально добавленные и снятые виды.
 */
export const setEmployeeDeductionKinds = async (
  exec: DbExecutor,
  employeeId: number,
  kindIds: readonly number[],
): Promise<{ added: number[]; removed: number[] }> => {
  const ids = [...new Set(kindIds)];
  const removed = await exec.query<{ kind_id: number }>(
    `DELETE FROM payroll_employee_deductions
      WHERE employee_id = $1 AND NOT (kind_id = ANY($2::int[]))
      RETURNING kind_id`,
    [employeeId, ids],
  );
  const added = await exec.query<{ kind_id: number }>(
    `INSERT INTO payroll_employee_deductions (employee_id, kind_id)
     SELECT $1, unnest($2::int[])
     ON CONFLICT DO NOTHING
     RETURNING kind_id`,
    [employeeId, ids],
  );
  return { added: added.rows.map(row => row.kind_id), removed: removed.rows.map(row => row.kind_id) };
};
