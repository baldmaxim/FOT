/**
 * Подвиды видов удержаний (миграция 321): «Спецодежда» → «Каска», «Штрафы» → «Курение».
 *
 * Справочник общий для кадров («Управление кадрами» → «Удержания» → «Виды удержаний») и «Зарплаты»
 * («Справочник» → «Удержания»): «+» у вида раскрывает его подвиды. У подвида своя сумма по умолчанию —
 * окно удержания подставляет её вместо суммы вида. Подвид, назначенный удержанию (staff_deductions), не удалить —
 * FK RESTRICT; удаление неиспользуемого вида уносит его подвиды (CASCADE).
 */
import { query, queryOne } from '../../config/postgres.js';
import type { IDeductionKindWithDefault } from './payroll-deduction-kinds.service.js';
import { hasPgCode, isPgReferencedRow, PG_FOREIGN_KEY_VIOLATION, PG_UNIQUE_VIOLATION } from './payroll-pg-errors.js';

export interface IDeductionSubkind {
  id: number;
  kind_id: number;
  name: string;
  /** NUMERIC как строка: «800.00»; не задана — null (берётся сумма вида). */
  default_amount: string | null;
}

/** Вид со своими подвидами — справочник обоих окон «Виды удержаний» и список «Вид» / «Подвид» окна удержания. */
export interface IDeductionKindTreeNode extends IDeductionKindWithDefault {
  /** В порядке добавления. */
  subkinds: IDeductionSubkind[];
}

const SUBKIND_COLUMNS = `id, kind_id, name, default_amount::text AS default_amount`;

/** Виды в порядке справочника, у каждого — подвиды в порядке добавления. */
export const listDeductionKindTree = async (): Promise<IDeductionKindTreeNode[]> =>
  query<IDeductionKindTreeNode>(
    `SELECT k.id, k.name, k.default_amount::text AS default_amount,
            COALESCE((
              SELECT json_agg(json_build_object(
                       'id', s.id, 'kind_id', s.kind_id, 'name', s.name, 'default_amount', s.default_amount::text
                     ) ORDER BY s.id)
                FROM payroll_deduction_subkinds s
               WHERE s.kind_id = k.id
            ), '[]'::json) AS subkinds
       FROM payroll_deduction_kinds k
      ORDER BY k.sort_order, k.id`,
  );

/** Добавить подвид виду. Такой у вида уже есть (без учёта регистра) — 'duplicate'; вида нет — 'kind_missing'. */
export const addSubkind = async (
  kindId: number,
  name: string,
  defaultAmount: number | null,
): Promise<IDeductionSubkind | 'duplicate' | 'kind_missing'> => {
  try {
    const row = await queryOne<IDeductionSubkind>(
      `INSERT INTO payroll_deduction_subkinds (kind_id, name, default_amount) VALUES ($1, $2, $3)
       RETURNING ${SUBKIND_COLUMNS}`,
      [kindId, name, defaultAmount],
    );
    if (!row) throw new Error('Подвид не вернулся после добавления');
    return row;
  } catch (err) {
    if (hasPgCode(err, PG_UNIQUE_VIOLATION)) return 'duplicate';
    if (hasPgCode(err, PG_FOREIGN_KEY_VIOLATION)) return 'kind_missing';
    throw err;
  }
};

/**
 * Название и сумма по умолчанию подвида. Подвида нет — null; название занято другим подвидом того же вида —
 * 'duplicate'. Прежние значения возвращаются для аудита («было → стало»).
 */
export const updateSubkind = async (
  id: number,
  name: string,
  defaultAmount: number | null,
): Promise<{ before: IDeductionSubkind; after: IDeductionSubkind } | 'duplicate' | null> => {
  try {
    const row = await queryOne<IDeductionSubkind & { previous_name: string; previous_amount: string | null }>(
      `UPDATE payroll_deduction_subkinds s
          SET name = $2, default_amount = $3
         FROM (SELECT id, name, default_amount FROM payroll_deduction_subkinds WHERE id = $1 FOR UPDATE) prev
        WHERE s.id = prev.id
        RETURNING s.id, s.kind_id, s.name, s.default_amount::text AS default_amount,
                  prev.name AS previous_name, prev.default_amount::text AS previous_amount`,
      [id, name, defaultAmount],
    );
    if (!row) return null;
    return {
      before: { id: row.id, kind_id: row.kind_id, name: row.previous_name, default_amount: row.previous_amount },
      after: { id: row.id, kind_id: row.kind_id, name: row.name, default_amount: row.default_amount },
    };
  } catch (err) {
    if (hasPgCode(err, PG_UNIQUE_VIOLATION)) return 'duplicate';
    throw err;
  }
};

/**
 * Удалить подвид. Подвида нет — null; назначен удержаниям — { inUse: сколько сотрудников } (FK RESTRICT:
 * отдельной проверки перед удалением нет, гонку решает сама БД).
 */
export const deleteSubkind = async (id: number): Promise<IDeductionSubkind | { inUse: number } | null> => {
  try {
    return await queryOne<IDeductionSubkind>(
      `DELETE FROM payroll_deduction_subkinds WHERE id = $1 RETURNING ${SUBKIND_COLUMNS}`,
      [id],
    );
  } catch (err) {
    if (!isPgReferencedRow(err)) throw err;
    const used = await queryOne<{ total: number }>(
      `SELECT count(DISTINCT employee_id)::int AS total FROM staff_deductions WHERE subkind_id = $1`,
      [id],
    );
    return { inUse: used?.total ?? 0 };
  }
};
