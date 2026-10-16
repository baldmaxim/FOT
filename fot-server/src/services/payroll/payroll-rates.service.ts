/**
 * Справочник ставок «Зарплаты» (миграция 306): название и значение.
 *
 * Ведётся в окне «Справочник» на «Расчётах». Ставка только хранится: в окно сотрудника и в расчёты
 * не подставляется, с видами удержаний не связана. Значение можно не задавать.
 * Ставка с кодом (миграция 313: dormitory — «Проживание общежития») не удаляется и не переименовывается.
 */
import { query, queryOne } from '../../config/postgres.js';
import { hasPgCode, PG_UNIQUE_VIOLATION } from './payroll-pg-errors.js';

export interface IPayrollRate {
  id: number;
  name: string;
  /** NUMERIC текстом, как остальные суммы «Зарплаты»; не задано — null. */
  amount: string | null;
  /** Машинный код ставки, к которой привязан функционал; обычная ставка — null. */
  code: string | null;
}

/** Код ставки «Проживание общежития» — у неё кнопка с таблицей проживающих. */
export const DORMITORY_RATE_CODE = 'dormitory';

const RATE_COLUMNS = `id, name, amount::text AS amount, code`;

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
 * Изменить название и значение ставки. Ставки нет — null; название занято другой — 'duplicate';
 * у ставки с кодом сменили название — 'system_name' (значение у неё меняется).
 * Возвращает прежнюю и новую строки: аудит пишет «было → стало».
 */
export const updateRate = async (
  id: number,
  name: string,
  amount: number | null,
): Promise<{ before: IPayrollRate; after: IPayrollRate } | 'duplicate' | 'system_name' | null> => {
  try {
    // Строка prev есть, а upd пуст — ставку с кодом пытались переименовать. Названия сравниваются
    // без лишних пробелов (как схлопывает их контроллер), а у ставки с кодом остаётся прежнее.
    const row = await queryOne<{
      id: number | null; name: string | null; amount: string | null; code: string | null;
      prev_name: string; prev_amount: string | null; prev_code: string | null;
    }>(
      `WITH prev AS (SELECT id, name, amount, code FROM payroll_rates WHERE id = $1 FOR UPDATE),
       upd AS (
         UPDATE payroll_rates r
            SET name = CASE WHEN prev.code IS NULL THEN $2 ELSE prev.name END, amount = $3, updated_at = now()
           FROM prev
          WHERE r.id = prev.id
            AND (prev.code IS NULL
                 OR regexp_replace(btrim(prev.name), '\s+', ' ', 'g') = regexp_replace(btrim($2), '\s+', ' ', 'g'))
          RETURNING r.id, r.name, r.amount::text AS amount, r.code
       )
       SELECT upd.id, upd.name, upd.amount, upd.code,
              prev.name AS prev_name, prev.amount::text AS prev_amount, prev.code AS prev_code
         FROM prev LEFT JOIN upd ON true`,
      [id, name, amount],
    );
    if (!row) return null;
    if (row.id === null || row.name === null) return 'system_name';
    return {
      before: { id: row.id, name: row.prev_name, amount: row.prev_amount, code: row.prev_code ?? null },
      after: { id: row.id, name: row.name, amount: row.amount, code: row.code ?? null },
    };
  } catch (err) {
    if (hasPgCode(err, PG_UNIQUE_VIOLATION)) return 'duplicate';
    throw err;
  }
};

/** Удалить ставку; её нет — null; у ставки есть код — 'system' (такую не удаляем). */
export const deleteRate = async (id: number): Promise<IPayrollRate | 'system' | null> => {
  const row = await queryOne<{
    id: number | null; name: string | null; amount: string | null; code: string | null; target_code: string | null;
  }>(
    `WITH target AS (SELECT id, code FROM payroll_rates WHERE id = $1 FOR UPDATE),
     del AS (
       DELETE FROM payroll_rates r
        USING target
        WHERE r.id = target.id AND target.code IS NULL
        RETURNING r.id, r.name, r.amount::text AS amount, r.code
     )
     SELECT del.id, del.name, del.amount, del.code, target.code AS target_code
       FROM target LEFT JOIN del ON true`,
    [id],
  );
  if (!row) return null;
  if (row.id === null || row.name === null) return 'system';
  return { id: row.id, name: row.name, amount: row.amount, code: row.code ?? null };
};
