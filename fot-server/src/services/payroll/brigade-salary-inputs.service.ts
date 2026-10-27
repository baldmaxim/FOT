/**
 * Ввод вкладки «Табель → Зарплата»: «Выработка» бригады и КТУ рабочих за месяц (миграция 330).
 * Нет строки выработки — «не введена» (это не 0,00); нет строки КТУ — 1,0: КТУ 1,0 не хранится,
 * чтобы отпечаток ввода не менялся от «поставили 1,0 обратно».
 */
import crypto from 'node:crypto';

import type { DbExecutor } from '../../config/postgres.js';
import { execute, query, queryOne } from '../../config/postgres.js';

export const DEFAULT_KTU_TENTHS = 10;

export interface IBrigadeSalaryInputs {
  /** Выработка строкой NUMERIC(12,2); null — не введена. */
  output: string | null;
  /** КТУ в десятых, только отличные от 1,0. */
  ktu: Map<number, number>;
}

async function rows<T extends import('pg').QueryResultRow>(
  exec: DbExecutor | undefined, sql: string, params: readonly unknown[],
): Promise<T[]> {
  if (exec) return (await exec.query<T>(sql, params as unknown[])).rows;
  return query<T>(sql, params);
}

export async function loadBrigadeSalaryInputs(
  departmentId: string,
  monthStart: string,
  exec?: DbExecutor,
): Promise<IBrigadeSalaryInputs> {
  // Последовательно: на клиенте транзакции параллельные запросы не нужны.
  const outputRows = await rows<{ amount: string }>(
    exec,
    'SELECT amount::text AS amount FROM brigade_salary_outputs WHERE department_id = $1 AND month = $2::date',
    [departmentId, monthStart],
  );
  const ktuRows = await rows<{ employee_id: string | number; ktu: string }>(
    exec,
    'SELECT employee_id, ktu::text AS ktu FROM brigade_salary_ktu WHERE department_id = $1 AND month = $2::date',
    [departmentId, monthStart],
  );
  const ktu = new Map<number, number>();
  for (const row of ktuRows) {
    const tenths = Math.round(Number(row.ktu) * 10);
    if (tenths !== DEFAULT_KTU_TENTHS) ktu.set(Number(row.employee_id), tenths);
  }
  return { output: outputRows[0]?.amount ?? null, ktu };
}

/** Отпечаток ввода: меняется только от реальной смены выработки или КТУ. */
export const brigadeSalaryInputsHash = (inputs: IBrigadeSalaryInputs): string => {
  const ktu = [...inputs.ktu].filter(([, tenths]) => tenths !== DEFAULT_KTU_TENTHS).sort(([a], [b]) => a - b);
  return crypto.createHash('sha256').update(JSON.stringify({ output: inputs.output, ktu })).digest('hex');
};

/** Выработка: null — убрать. Возвращает прежнее и новое значения строками. */
export async function setBrigadeOutput(
  departmentId: string,
  monthStart: string,
  amount: string | null,
  actorUserId: string,
): Promise<{ before: string | null; after: string | null }> {
  const previous = await queryOne<{ amount: string }>(
    'SELECT amount::text AS amount FROM brigade_salary_outputs WHERE department_id = $1 AND month = $2::date',
    [departmentId, monthStart],
  );
  if (amount === null) {
    await execute('DELETE FROM brigade_salary_outputs WHERE department_id = $1 AND month = $2::date', [departmentId, monthStart]);
    return { before: previous?.amount ?? null, after: null };
  }
  const saved = await queryOne<{ amount: string }>(
    `INSERT INTO brigade_salary_outputs (department_id, month, amount, updated_by, updated_at)
     VALUES ($1, $2::date, $3::numeric, $4, now())
     ON CONFLICT (department_id, month)
     DO UPDATE SET amount = EXCLUDED.amount, updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING amount::text AS amount`,
    [departmentId, monthStart, amount, actorUserId],
  );
  return { before: previous?.amount ?? null, after: saved?.amount ?? amount };
}

/** КТУ в десятых; 1,0 удаляет строку. Возвращает прежнее и новое значения в десятых. */
export async function setBrigadeKtu(
  departmentId: string,
  monthStart: string,
  employeeId: number,
  ktuTenths: number,
  actorUserId: string,
): Promise<{ before: number; after: number }> {
  const previous = await queryOne<{ ktu: string }>(
    `SELECT ktu::text AS ktu FROM brigade_salary_ktu
      WHERE department_id = $1 AND month = $2::date AND employee_id = $3`,
    [departmentId, monthStart, employeeId],
  );
  const before = previous ? Math.round(Number(previous.ktu) * 10) : DEFAULT_KTU_TENTHS;
  if (ktuTenths === DEFAULT_KTU_TENTHS) {
    await execute(
      'DELETE FROM brigade_salary_ktu WHERE department_id = $1 AND month = $2::date AND employee_id = $3',
      [departmentId, monthStart, employeeId],
    );
  } else {
    await execute(
      `INSERT INTO brigade_salary_ktu (department_id, month, employee_id, ktu, updated_by, updated_at)
       VALUES ($1, $2::date, $3, $4::numeric, $5, now())
       ON CONFLICT (department_id, month, employee_id)
       DO UPDATE SET ktu = EXCLUDED.ktu, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [departmentId, monthStart, employeeId, (ktuTenths / 10).toFixed(1), actorUserId],
    );
  }
  return { before, after: ktuTenths };
}
