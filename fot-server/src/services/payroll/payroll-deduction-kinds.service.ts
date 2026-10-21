/**
 * Справочник видов удержаний (миграция 299) — общий для «Зарплаты» («Справочник» → «Удержания») и кадров
 * («Управление кадрами» → «Удержания» → «Виды удержаний», миграция 318: у вида там ещё сумма по умолчанию).
 * Подвиды видов и дерево «вид → подвиды» — payroll-deduction-subkinds.service.ts (миграция 321).
 *
 * Вид, назначенный удержанию (staff_deductions), не удалить — FK RESTRICT.
 */
import { queryOne } from '../../config/postgres.js';
import { hasPgCode, isPgReferencedRow, PG_UNIQUE_VIOLATION } from './payroll-pg-errors.js';

export interface IPayrollDeductionKind {
  id: number;
  name: string;
}

/** Новый вид — в конец списка, после стартовых. */
const NEW_KIND_SORT_ORDER = 1000;

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

/** Вид со суммой по умолчанию — справочник во вкладке кадров «Удержания» (миграция 318). */
export interface IDeductionKindWithDefault extends IPayrollDeductionKind {
  /** NUMERIC как строка: «5000.00»; не задана — null. */
  default_amount: string | null;
}

const KIND_WITH_DEFAULT_COLUMNS = `id, name, default_amount::text AS default_amount`;

/** Добавить вид с суммой по умолчанию. Такой уже есть — null. */
export const addDeductionKindWithDefault = async (
  name: string,
  defaultAmount: number | null,
): Promise<IDeductionKindWithDefault | null> => {
  try {
    return await queryOne<IDeductionKindWithDefault>(
      `INSERT INTO payroll_deduction_kinds (name, sort_order, default_amount) VALUES ($1, $2, $3)
       RETURNING ${KIND_WITH_DEFAULT_COLUMNS}`,
      [name, NEW_KIND_SORT_ORDER, defaultAmount],
    );
  } catch (err) {
    if (hasPgCode(err, PG_UNIQUE_VIOLATION)) return null;
    throw err;
  }
};

/**
 * Название и сумма по умолчанию вида. Вида нет — null; название занято другим видом — 'duplicate'.
 * Прежние значения возвращаются для аудита («было → стало»).
 */
export const updateDeductionKind = async (
  id: number,
  name: string,
  defaultAmount: number | null,
): Promise<{ before: IDeductionKindWithDefault; after: IDeductionKindWithDefault } | 'duplicate' | null> => {
  try {
    const row = await queryOne<IDeductionKindWithDefault & { previous_name: string; previous_amount: string | null }>(
      `UPDATE payroll_deduction_kinds k
          SET name = $2, default_amount = $3
         FROM (SELECT id, name, default_amount FROM payroll_deduction_kinds WHERE id = $1 FOR UPDATE) prev
        WHERE k.id = prev.id
        RETURNING k.id, k.name, k.default_amount::text AS default_amount,
                  prev.name AS previous_name, prev.default_amount::text AS previous_amount`,
      [id, name, defaultAmount],
    );
    if (!row) return null;
    return {
      before: { id: row.id, name: row.previous_name, default_amount: row.previous_amount },
      after: { id: row.id, name: row.name, default_amount: row.default_amount },
    };
  } catch (err) {
    if (hasPgCode(err, PG_UNIQUE_VIOLATION)) return 'duplicate';
    throw err;
  }
};

/**
 * Удалить вид (его подвиды уходят с ним). Вида нет — null; назначен удержаниям — { inUse: сколько сотрудников }
 * (FK RESTRICT: отдельной проверки перед удалением нет, гонку решает сама БД).
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
      `SELECT count(DISTINCT employee_id)::int AS total FROM staff_deductions WHERE kind_id = $1`,
      [id],
    );
    return { inUse: used?.total ?? 0 };
  }
};
