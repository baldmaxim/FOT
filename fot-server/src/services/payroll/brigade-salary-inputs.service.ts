/**
 * Ввод вкладки «Табель → Зарплата по объектам»: «Выработка» бригады на объектах (миграция 336) и КТУ рабочих за
 * месяц (миграция 330). Нет строки выработки — «не внесена» (это не 0,00); нет строки КТУ — 1,0: КТУ 1,0 не
 * хранится, чтобы отпечаток ввода не менялся от «поставили 1,0 обратно».
 */
import crypto from 'node:crypto';

import type { DbExecutor } from '../../config/postgres.js';
import { execute, query, queryOne } from '../../config/postgres.js';
import { centsToMoney, moneyToCents } from './brigade-salary.calc.js';

export const DEFAULT_KTU_TENTHS = 10;

export interface IBrigadeObjectOutput {
  /** NUMERIC(12,2) строкой. */
  amount: string;
  /** Имя объекта на момент ввода. */
  object_name: string;
}

export interface IBrigadeSalaryInputs {
  /** Выработка по объектам: object_key → сумма; нет ключа — не внесена. */
  outputs: Map<string, IBrigadeObjectOutput>;
  /** КТУ в десятых, только отличные от 1,0. */
  ktu: Map<number, number>;
}

/** Σ внесённых выработок строкой; ничего не внесено — null. */
export const totalBrigadeOutput = (outputs: ReadonlyMap<string, IBrigadeObjectOutput>): string | null => {
  if (outputs.size === 0) return null;
  const cents = [...outputs.values()].reduce((sum, output) => sum + moneyToCents(output.amount), 0n);
  return centsToMoney(cents);
};

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
  const outputRows = await rows<{ object_key: string; object_name: string; amount: string }>(
    exec,
    `SELECT object_key, object_name, amount::text AS amount
       FROM brigade_salary_object_outputs
      WHERE department_id = $1 AND month = $2::date
      ORDER BY object_key`,
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
  const outputs = new Map<string, IBrigadeObjectOutput>();
  for (const row of outputRows) outputs.set(row.object_key, { amount: row.amount, object_name: row.object_name });
  return { outputs, ktu };
}

/** Версия отпечатка: 'v2:' — выработка по объектам (336). Расчёт с другим отпечатком пересчитывается. */
export const BRIGADE_INPUTS_HASH_PREFIX = 'v2:';

/**
 * Отпечаток ввода: меняется только от реальной смены выработки или КТУ. Порядок строк SQL и Map не важен — пары
 * сортируются; имя объекта не входит (переименование расчёт не меняет).
 */
export const brigadeSalaryInputsHash = (inputs: IBrigadeSalaryInputs): string => {
  const outputs = [...inputs.outputs]
    .map(([key, output]) => [key, centsToMoney(moneyToCents(output.amount))])
    .sort(([a], [b]) => a.localeCompare(b));
  const ktu = [...inputs.ktu].filter(([, tenths]) => tenths !== DEFAULT_KTU_TENTHS).sort(([a], [b]) => a - b);
  return `${BRIGADE_INPUTS_HASH_PREFIX}${crypto.createHash('sha256').update(JSON.stringify({ outputs, ktu })).digest('hex')}`;
};

/** Выработка бригады на объекте: null — стереть. Возвращает прежнее и новое значения строками. */
export async function setBrigadeObjectOutput(
  departmentId: string,
  monthStart: string,
  objectKey: string,
  objectName: string,
  amount: string | null,
  actorUserId: string,
): Promise<{ before: string | null; after: string | null }> {
  const previous = await queryOne<{ amount: string }>(
    `SELECT amount::text AS amount FROM brigade_salary_object_outputs
      WHERE department_id = $1 AND month = $2::date AND object_key = $3`,
    [departmentId, monthStart, objectKey],
  );
  if (amount === null) {
    await execute(
      'DELETE FROM brigade_salary_object_outputs WHERE department_id = $1 AND month = $2::date AND object_key = $3',
      [departmentId, monthStart, objectKey],
    );
    return { before: previous?.amount ?? null, after: null };
  }
  const saved = await queryOne<{ amount: string }>(
    `INSERT INTO brigade_salary_object_outputs
       (department_id, month, object_key, object_name, amount, updated_by, updated_at)
     VALUES ($1, $2::date, $3, $4, $5::numeric, $6, now())
     ON CONFLICT (department_id, month, object_key)
     DO UPDATE SET object_name = EXCLUDED.object_name, amount = EXCLUDED.amount,
                   updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING amount::text AS amount`,
    [departmentId, monthStart, objectKey, objectName, amount, actorUserId],
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
