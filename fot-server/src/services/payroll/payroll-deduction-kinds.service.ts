/**
 * Справочник видов удержаний (миграция 299): столбцы вкладки «Расчёты» и список «Вид»
 * в «Удержании» карточки. Пополняется на «Расчётах»; правки и удаления нет —
 * вид, раз выбранный в условиях оплаты, держит FK (ON DELETE RESTRICT).
 */
import { query, queryOne } from '../../config/postgres.js';

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

export const deductionKindExists = async (id: number): Promise<boolean> =>
  Boolean(await queryOne<{ id: number }>(`SELECT id FROM payroll_deduction_kinds WHERE id = $1`, [id]));

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
