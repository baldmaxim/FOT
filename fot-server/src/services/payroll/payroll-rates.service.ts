/**
 * Справочник ставок «Зарплаты» (миграции 306, 324): название и значения по месяцам.
 *
 * Ведётся в окне «Справочник» на «Расчётах». Значение за месяц M — последняя запись payroll_rate_values
 * с effective_from <= M (в SQL — функция payroll_rate_value): смена ставки не переписывает прошлые месяцы.
 * Первое значение действует «с начала» (RATE_START_MONTH), следующие — с выбранного месяца, не раньше
 * текущего (диапазон стережёт контроллер). payroll_rates.amount — копия значения на текущий месяц для
 * прежнего бэкенда (откат), сервер её не читает.
 *
 * Ставка с кодом (миграции 313/315/317/324) не удаляется и не переименовывается:
 * - housing — «Доплата за проживание»: сумма по умолчанию при добавлении в одноимённую таблицу;
 * - dormitory_allowance — «Доплата за общежитие»: сумма всем из таблицы «Общежитие» без проживания;
 * - travel — «Проезд»: сумма за месяц всем, кроме рабочих и «Без проезда».
 */
import type { PoolClient } from 'pg';

import { query, queryOne, withTransaction } from '../../config/postgres.js';
import { moscowTodayIso } from '../../utils/date.utils.js';
import { hasPgCode, PG_UNIQUE_VIOLATION } from './payroll-pg-errors.js';

/** Значение ставки с месяца effective_from (YYYY-MM) до следующей записи; null — ставку отключили. */
export interface IPayrollRateValue {
  effective_from: string;
  amount: string | null;
}

export interface IPayrollRate {
  id: number;
  name: string;
  /** Значение на текущий месяц МСК — NUMERIC текстом, как остальные суммы «Зарплаты»; не задано — null. */
  amount: string | null;
  /** Машинный код ставки, к которой привязан функционал; обычная ставка — null. */
  code: string | null;
  /** История значений по возрастанию месяца. */
  values: IPayrollRateValue[];
}

/** Строка ставки без истории: ответ удаления. amount — копия значения на текущий месяц. */
export type IPayrollRateRow = Omit<IPayrollRate, 'values'>;

/** Изменённая точка истории: с какого месяца, что действовало в нём до правки и что стало. */
export interface IPayrollRateValueChange {
  /** YYYY-MM; у первого значения ставки — RATE_START_MONTH. */
  effective_month: string;
  /** Значение месяца до правки — своё или унаследованное от прежней записи; не было — null. */
  from: string | null;
  to: string | null;
}

export interface IPayrollRateUpdate {
  before: IPayrollRate;
  after: IPayrollRate;
  nameChanged: boolean;
  /** null — значение не менялось (то же, что уже действует в этом месяце). */
  value: IPayrollRateValueChange | null;
}

/**
 * Код ставки «Доплата за проживание» (миграция 315): у неё кнопка с таблицей доплат, значение — сумма
 * по умолчанию при добавлении сотрудника в эту таблицу.
 */
export const HOUSING_RATE_CODE = 'housing';

/** Код ставки «Доплата за общежитие» (миграция 317): её значение за месяц — сумма всем из одноимённой таблицы. */
export const DORMITORY_ALLOWANCE_RATE_CODE = 'dormitory_allowance';

/** Код ставки «Проезд» (миграция 324): сумма за месяц всем, кроме рабочих и «Без проезда» в этом месяце. */
export const TRAVEL_RATE_CODE = 'travel';

/** Первое значение ставки действует «с начала» — на все прошлые месяцы. */
export const RATE_START_MONTH = '2000-01';

/** Значение меняют с текущего месяца МСК и не дальше, чем на столько месяцев вперёд. */
export const RATE_MONTHS_AHEAD = 12;

/** Текущий месяц МСК, YYYY-MM. */
export const currentRateMonth = (now: Date = new Date()): string => moscowTodayIso(now).slice(0, 7);

/** Месяц YYYY-MM, сдвинутый на delta месяцев. */
export const shiftRateMonth = (month: string, delta: number): string => {
  const [year, mon] = month.split('-').map(Number);
  return new Date(Date.UTC(year, mon - 1 + delta, 1)).toISOString().slice(0, 7);
};

// Ставки с кодом — в порядке строк «Ставок»: проживание, общежитие, проезд; остальные — в порядке добавления.
const RATE_ORDER_SQL = `array_position(
    ARRAY['${HOUSING_RATE_CODE}', '${DORMITORY_ALLOWANCE_RATE_CODE}', '${TRAVEL_RATE_CODE}']::text[], r.code
  ) NULLS LAST, r.id`;

/** Ставка с историей; $1 — сегодня (МСК), по нему значение на текущий месяц. */
const RATE_SELECT = `
  SELECT r.id, r.name, r.code,
         (SELECT v.amount::text FROM payroll_rate_values v
           WHERE v.rate_id = r.id AND v.effective_from <= $1::date
           ORDER BY v.effective_from DESC LIMIT 1) AS amount,
         COALESCE((
           SELECT json_agg(json_build_object(
                    'effective_from', to_char(v.effective_from, 'YYYY-MM'),
                    'amount', v.amount::text
                  ) ORDER BY v.effective_from)
             FROM payroll_rate_values v
            WHERE v.rate_id = r.id
         ), '[]'::json) AS values
    FROM payroll_rates r`;

const readRate = async (client: PoolClient, id: number, today: string): Promise<IPayrollRate | null> =>
  (await client.query<IPayrollRate>(`${RATE_SELECT} WHERE r.id = $2`, [today, id])).rows[0] ?? null;

/** Значение, действующее в месяце: последняя запись не позже него; записей нет — null. */
const valueInMonth = (values: ReadonlyArray<IPayrollRateValue>, month: string): string | null => {
  let found: string | null = null;
  for (const value of values) {
    if (value.effective_from > month) break;
    found = value.amount;
  }
  return found;
};

/** NUMERIC текстом и введённое число — одно значение («160.00» и 160). */
const sameAmount = (stored: string | null, next: number | null): boolean => (
  stored === null ? next === null : next !== null && Number(stored) === next
);

/** Копия значения на текущий месяц в payroll_rates.amount — для прежнего бэкенда. */
const syncCurrentAmount = async (client: PoolClient, id: number, today: string): Promise<void> => {
  await client.query(
    `UPDATE payroll_rates
        SET amount = (SELECT v.amount FROM payroll_rate_values v
                       WHERE v.rate_id = $1 AND v.effective_from <= $2::date
                       ORDER BY v.effective_from DESC LIMIT 1),
            updated_at = now()
      WHERE id = $1`,
    [id, today],
  );
};

/**
 * Записать значение с месяца по правилам истории. values — история до правки (под блокировкой ставки).
 * - Истории нет: первое значение — «с начала»; пустое значение строку не создаёт.
 * - Значение то же, что уже действует в месяце, — ничего не пишется.
 * - У месяца своя запись, а новое значение равно прежнему (до этого месяца), — запись удаляется:
 *   запланированную смену отменили.
 */
const writeRateValue = async (
  client: PoolClient,
  id: number,
  amount: number | null,
  month: string,
  values: ReadonlyArray<IPayrollRateValue>,
): Promise<IPayrollRateValueChange | null> => {
  if (values.length === 0) {
    if (amount === null) return null;
    const { rows: [row] } = await client.query<{ amount: string }>(
      `INSERT INTO payroll_rate_values (rate_id, effective_from, amount) VALUES ($1, $2::date, $3)
       RETURNING amount::text AS amount`,
      [id, `${RATE_START_MONTH}-01`, amount],
    );
    return { effective_month: RATE_START_MONTH, from: null, to: row.amount };
  }

  const own = values.find(value => value.effective_from === month);
  const from = valueInMonth(values, month);
  if (sameAmount(from, amount)) return null;

  const previous = valueInMonth(values.filter(value => value !== own), month);
  if (own && sameAmount(previous, amount)) {
    await client.query(
      `DELETE FROM payroll_rate_values WHERE rate_id = $1 AND effective_from = $2::date`,
      [id, `${month}-01`],
    );
    return { effective_month: month, from, to: previous };
  }

  const { rows: [row] } = await client.query<{ amount: string | null }>(
    `INSERT INTO payroll_rate_values (rate_id, effective_from, amount) VALUES ($1, $2::date, $3)
     ON CONFLICT (rate_id, effective_from) DO UPDATE SET amount = EXCLUDED.amount, updated_at = now()
     RETURNING amount::text AS amount`,
    [id, `${month}-01`, amount],
  );
  return { effective_month: month, from, to: row.amount };
};

/** В порядке строк «Ставок»: ставки с кодом, затем остальные в порядке добавления. */
export const listRates = async (): Promise<IPayrollRate[]> =>
  query<IPayrollRate>(`${RATE_SELECT} ORDER BY ${RATE_ORDER_SQL}`, [moscowTodayIso()]);

/**
 * Добавить ставку; заданное значение — первое, «с начала». Такое название уже есть (без учёта
 * регистра и пробелов по краям) — null.
 */
export const addRate = async (name: string, amount: number | null): Promise<IPayrollRate | null> => {
  const today = moscowTodayIso();
  try {
    return await withTransaction(async client => {
      const { rows: [row] } = await client.query<{ id: number }>(
        `INSERT INTO payroll_rates (name, amount) VALUES ($1, $2) RETURNING id`,
        [name, amount],
      );
      await writeRateValue(client, row.id, amount, currentRateMonth(), []);
      return readRate(client, row.id, today);
    });
  } catch (err) {
    if (hasPgCode(err, PG_UNIQUE_VIOLATION)) return null;
    throw err;
  }
};

/** Названия сравниваются без лишних пробелов — как схлопывает их контроллер. */
const normalizeName = (name: string): string => name.replace(/\s+/g, ' ').trim();

/**
 * Изменить название и значение ставки с месяца month (YYYY-MM). Ставки нет — null; название занято
 * другой — 'duplicate'; у ставки с кодом сменили название — 'system_name' (значение у неё меняется).
 * Возвращает ставку до и после и изменённую точку истории — аудит пишет «было → стало» в ней.
 */
export const updateRate = async (
  id: number,
  name: string,
  amount: number | null,
  month: string,
): Promise<IPayrollRateUpdate | 'duplicate' | 'system_name' | null> => {
  const today = moscowTodayIso();
  try {
    return await withTransaction(async client => {
      const { rowCount } = await client.query(`SELECT 1 FROM payroll_rates WHERE id = $1 FOR UPDATE`, [id]);
      if (!rowCount) return null;
      const before = await readRate(client, id, today);
      if (!before) return null;
      if (before.code !== null && normalizeName(before.name) !== normalizeName(name)) return 'system_name';

      const nameChanged = before.code === null && before.name !== name;
      if (nameChanged) {
        await client.query(`UPDATE payroll_rates SET name = $2, updated_at = now() WHERE id = $1`, [id, name]);
      }
      const value = await writeRateValue(client, id, amount, month, before.values);
      if (value) await syncCurrentAmount(client, id, today);
      const after = await readRate(client, id, today);
      return { before, after: after ?? before, nameChanged, value };
    });
  } catch (err) {
    if (hasPgCode(err, PG_UNIQUE_VIOLATION)) return 'duplicate';
    throw err;
  }
};

/** Удалить ставку вместе с историей; её нет — null; у ставки есть код — 'system' (такую не удаляем). */
export const deleteRate = async (id: number): Promise<IPayrollRateRow | 'system' | null> => {
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
