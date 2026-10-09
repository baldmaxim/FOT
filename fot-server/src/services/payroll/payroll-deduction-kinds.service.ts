/**
 * Удержания «Зарплаты»: справочник видов (миграция 299) и виды сотрудника (миграция 300).
 *
 * Справочник — пункты выпадающего списка «Удержание» на «Расчётах» и в карточке «Подробно»;
 * пополняется там же, правки и удаления нет (вид, отмеченный у сотрудника, держит FK RESTRICT).
 * У сотрудника видов может быть несколько; это не версия условий оплаты.
 */
import { query, queryOne, type DbExecutor } from '../../config/postgres.js';

export interface IPayrollDeductionKind {
  id: number;
  name: string;
}

/** Новый вид — в конец списка, после стартовых. */
const NEW_KIND_SORT_ORDER = 1000;

const UNIQUE_VIOLATION = '23505';

export const listDeductionKinds = async (): Promise<IPayrollDeductionKind[]> =>
  query<IPayrollDeductionKind>(
    `SELECT id, name FROM payroll_deduction_kinds ORDER BY sort_order, id`,
  );

/** Все ли виды есть в справочнике (повторы не в счёт). Виды не удаляются — проверка надёжна. */
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
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === UNIQUE_VIOLATION) return null;
    throw err;
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
