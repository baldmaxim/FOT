/**
 * Удержания «Зарплаты»: справочник видов (миграция 299) и удержания сотрудника по месяцам (миграция 303).
 *
 * Справочник — пункты фильтра «Удержания» на «Расчётах» и «Вида» в удержаниях карточки;
 * пополняется в фильтре, правки и удаления нет (вид в удержании сотрудника держит FK RESTRICT).
 * Удержание — месяц · вид · сумма, один вид за месяц — одна строка; это не версия условий оплаты.
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

/** Удержание сотрудника за месяц: месяц YYYY-MM, сумма — текстом NUMERIC (без потери копеек). */
export interface IPayrollDeductionEntry {
  month: string;
  kind_id: number;
  amount: string;
}

/** Удержания сотрудника: месяцы от новых к старым, виды — в порядке справочника. */
export const getEmployeeDeductionEntries = async (employeeId: number): Promise<IPayrollDeductionEntry[]> =>
  query<IPayrollDeductionEntry>(
    `SELECT to_char(e.month, 'YYYY-MM') AS month, e.kind_id, e.amount::text AS amount
       FROM payroll_deduction_entries e
       JOIN payroll_deduction_kinds k ON k.id = e.kind_id
      WHERE e.employee_id = $1
      ORDER BY e.month DESC, k.sort_order, k.id`,
    [employeeId],
  );

/** Ключ записи: месяц + вид (одна строка на вид за месяц). */
const entryKey = (entry: { month: string; kind_id: number }): string => `${entry.month}|${entry.kind_id}`;

/**
 * Заменить удержания сотрудника набором entries: лишние удаляются, новые добавляются, у прежних
 * меняется сумма. Пары месяц+вид в entries уникальны (проверяет контроллер). Вызывать в транзакции.
 * Возвращает реально добавленные, удалённые и изменённые записи (для аудита).
 */
export const setEmployeeDeductionEntries = async (
  exec: DbExecutor,
  employeeId: number,
  entries: ReadonlyArray<{ month: string; kind_id: number; amount: number }>,
): Promise<{
  added: IPayrollDeductionEntry[];
  removed: IPayrollDeductionEntry[];
  changed: Array<IPayrollDeductionEntry & { prev_amount: string }>;
}> => {
  // Блокировка строк сотрудника: два одновременных сохранения не перемешают наборы.
  const before = await exec.query<IPayrollDeductionEntry>(
    `SELECT to_char(month, 'YYYY-MM') AS month, kind_id, amount::text AS amount
       FROM payroll_deduction_entries
      WHERE employee_id = $1
      FOR UPDATE`,
    [employeeId],
  );
  const prev = new Map(before.rows.map(row => [entryKey(row), row]));
  const next = new Set(entries.map(entryKey));

  const removed = before.rows.filter(row => !next.has(entryKey(row)));
  if (removed.length > 0) {
    await exec.query(
      `DELETE FROM payroll_deduction_entries d
        USING unnest($2::date[], $3::int[]) AS r(month, kind_id)
        WHERE d.employee_id = $1 AND d.month = r.month AND d.kind_id = r.kind_id`,
      [employeeId, removed.map(row => `${row.month}-01`), removed.map(row => row.kind_id)],
    );
  }

  // Неизменные суммы UPSERT не трогает и не возвращает: вернулись только добавленные и изменённые.
  const saved = entries.length === 0 ? [] : (await exec.query<IPayrollDeductionEntry>(
    `INSERT INTO payroll_deduction_entries AS d (employee_id, month, kind_id, amount)
     SELECT $1, r.month, r.kind_id, r.amount
       FROM unnest($2::date[], $3::int[], $4::numeric[]) AS r(month, kind_id, amount)
     ON CONFLICT (employee_id, month, kind_id) DO UPDATE
        SET amount = EXCLUDED.amount, updated_at = now()
      WHERE d.amount IS DISTINCT FROM EXCLUDED.amount
     RETURNING to_char(d.month, 'YYYY-MM') AS month, d.kind_id, d.amount::text AS amount`,
    [employeeId, entries.map(entry => `${entry.month}-01`), entries.map(entry => entry.kind_id), entries.map(entry => entry.amount)],
  )).rows;

  const added: IPayrollDeductionEntry[] = [];
  const changed: Array<IPayrollDeductionEntry & { prev_amount: string }> = [];
  for (const row of saved) {
    const was = prev.get(entryKey(row));
    if (was) changed.push({ ...row, prev_amount: was.amount });
    else added.push(row);
  }
  return { added, removed, changed };
};
