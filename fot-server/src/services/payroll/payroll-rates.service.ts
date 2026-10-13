/**
 * Справочник ставок «Зарплаты» (миграция 306): название и значение.
 *
 * Ведётся в окне «Справочник» на «Расчётах». Ставка только хранится: в окно сотрудника и в расчёты
 * не подставляется, с видами удержаний не связана. Значение можно не задавать.
 */
import { query, queryOne } from '../../config/postgres.js';
import { hasPgCode, PG_UNIQUE_VIOLATION } from './payroll-pg-errors.js';

export interface IPayrollRate {
  id: number;
  name: string;
  /** NUMERIC текстом, как остальные суммы «Зарплаты»; не задано — null. */
  amount: string | null;
}

const RATE_COLUMNS = `id, name, amount::text AS amount`;

/** В порядке добавления. */
export const listRates = async (): Promise<IPayrollRate[]> =>
  query<IPayrollRate>(`SELECT ${RATE_COLUMNS} FROM payroll_rates ORDER BY id`);

/** Добавить ставку. Такое название уже есть (без учёта регистра и пробелов по краям) — null. */
export const addRate = async (name: string, amount: number | null): Promise<IPayrollRate | null> => {
  try {
    return await queryOne<IPayrollRate>(
      `INSERT INTO payroll_rates (name, amount) VALUES ($1, $2) RETURNING ${RATE_COLUMNS}`,
      [name, amount],
    );
  } catch (err) {
    if (hasPgCode(err, PG_UNIQUE_VIOLATION)) return null;
    throw err;
  }
};

/**
 * Изменить название и значение ставки. Ставки нет — null; название занято другой — 'duplicate'.
 * Возвращает прежнюю и новую строки: аудит пишет «было → стало».
 */
export const updateRate = async (
  id: number,
  name: string,
  amount: number | null,
): Promise<{ before: IPayrollRate; after: IPayrollRate } | 'duplicate' | null> => {
  try {
    const row = await queryOne<IPayrollRate & { prev_name: string; prev_amount: string | null }>(
      `UPDATE payroll_rates r
          SET name = $2, amount = $3, updated_at = now()
         FROM (SELECT id, name, amount FROM payroll_rates WHERE id = $1 FOR UPDATE) prev
        WHERE r.id = prev.id
        RETURNING r.id, r.name, r.amount::text AS amount, prev.name AS prev_name, prev.amount::text AS prev_amount`,
      [id, name, amount],
    );
    if (!row) return null;
    return {
      before: { id: row.id, name: row.prev_name, amount: row.prev_amount },
      after: { id: row.id, name: row.name, amount: row.amount },
    };
  } catch (err) {
    if (hasPgCode(err, PG_UNIQUE_VIOLATION)) return 'duplicate';
    throw err;
  }
};

/** Удалить ставку; её нет — null. */
export const deleteRate = async (id: number): Promise<IPayrollRate | null> =>
  queryOne<IPayrollRate>(`DELETE FROM payroll_rates WHERE id = $1 RETURNING ${RATE_COLUMNS}`, [id]);
