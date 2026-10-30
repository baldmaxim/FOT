/**
 * Список оснований разовой доплаты (миграция 340): выпадающий список «Основание» в окне «Разовая доплата» и окно
 * «Основания доплаты» (добавить, переименовать, удалить).
 *
 * У доплаты основание — текст (payroll_one_time_supplements.reason), не FK: импорт из 1С и старые основания вне списка
 * остаются как есть. Переименование меняет и основание у доплат с прежним названием (без учёта регистра и лишних
 * пробелов) — у всех сотрудников: справочник общий, как виды удержаний. Удаление убирает только строку списка.
 */
import { query, queryOne, withTransaction } from '../../config/postgres.js';
import { hasPgCode, PG_UNIQUE_VIOLATION } from './payroll-pg-errors.js';

export interface IPayrollSupplementReason {
  id: number;
  name: string;
}

/** Все основания по алфавиту. */
export const listSupplementReasons = (): Promise<IPayrollSupplementReason[]> =>
  query<IPayrollSupplementReason>('SELECT id, name FROM payroll_supplement_reasons ORDER BY name, id');

/** Добавить основание. Такое уже есть (без учёта регистра и пробелов по краям) — null. */
export const addSupplementReason = async (name: string): Promise<IPayrollSupplementReason | null> => {
  try {
    return await queryOne<IPayrollSupplementReason>(
      'INSERT INTO payroll_supplement_reasons (name) VALUES ($1) RETURNING id, name',
      [name],
    );
  } catch (err) {
    if (hasPgCode(err, PG_UNIQUE_VIOLATION)) return null;
    throw err;
  }
};

/**
 * Переименовать основание и его же у разовых доплат (одной транзакцией). Основания нет — null; название занято
 * другим — 'duplicate'. Прежнее название и число изменённых доплат — для аудита.
 */
export const renameSupplementReason = async (
  id: number,
  name: string,
): Promise<{ reason: IPayrollSupplementReason; previousName: string; supplements: number } | 'duplicate' | null> => {
  try {
    return await withTransaction(async client => {
      const renamed = (await client.query<IPayrollSupplementReason & { previous_name: string }>(
        `UPDATE payroll_supplement_reasons r
            SET name = $2
           FROM (SELECT id, name FROM payroll_supplement_reasons WHERE id = $1 FOR UPDATE) prev
          WHERE r.id = prev.id
          RETURNING r.id, r.name, prev.name AS previous_name`,
        [id, name],
      )).rows[0];
      if (!renamed) return null;
      const supplements = renamed.name === renamed.previous_name ? 0 : (await client.query(
        `UPDATE payroll_one_time_supplements
            SET reason = $2, updated_at = now()
          WHERE lower(btrim(regexp_replace(reason, '\\s+', ' ', 'g'))) = lower($1)`,
        [renamed.previous_name, renamed.name],
      )).rowCount ?? 0;
      return { reason: { id: renamed.id, name: renamed.name }, previousName: renamed.previous_name, supplements };
    });
  } catch (err) {
    if (hasPgCode(err, PG_UNIQUE_VIOLATION)) return 'duplicate';
    throw err;
  }
};

/** Удалить основание из списка; доплаты с ним не меняются. Основания нет — null. */
export const removeSupplementReason = (id: number): Promise<IPayrollSupplementReason | null> =>
  queryOne<IPayrollSupplementReason>('DELETE FROM payroll_supplement_reasons WHERE id = $1 RETURNING id, name', [id]);
