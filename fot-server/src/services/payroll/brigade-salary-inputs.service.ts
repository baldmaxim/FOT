/**
 * Ввод вкладок «Табель → Зарплата по объектам» и «Бригады»: «Выработка» бригады на объектах (миграция 336) ИЛИ
 * одной суммой на бригаду (341, не обе сразу — следит триггер БД) и КТУ рабочих за месяц (330). Нет строки
 * выработки — «не внесена» (это не 0,00); нет строки КТУ — 1,0: КТУ 1,0 не хранится, чтобы отпечаток ввода не
 * менялся от «поставили 1,0 обратно».
 */
import crypto from 'node:crypto';

import type { PoolClient } from 'pg';

import type { DbExecutor } from '../../config/postgres.js';
import { execute, query, queryOne, withTransaction } from '../../config/postgres.js';
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
  /** Выработка одной суммой на бригаду (341) — NUMERIC(12,2) строкой; null — не внесена. С outputs не бывает. */
  brigadeOutput: string | null;
  /** КТУ в десятых, только отличные от 1,0. */
  ktu: Map<number, number>;
}

/** Σ внесённых выработок по объектам строкой; ничего не внесено — null. */
export const totalObjectOutputs = (outputs: ReadonlyMap<string, IBrigadeObjectOutput>): string | null => {
  if (outputs.size === 0) return null;
  const cents = [...outputs.values()].reduce((sum, output) => sum + moneyToCents(output.amount), 0n);
  return centsToMoney(cents);
};

/** Выработка, по которой делятся доли: сумма бригаде или Σ по объектам; ничего не внесено — null. */
export const totalBrigadeOutput = (inputs: Pick<IBrigadeSalaryInputs, 'outputs' | 'brigadeOutput'>): string | null => (
  inputs.brigadeOutput !== null
    ? centsToMoney(moneyToCents(inputs.brigadeOutput))
    : totalObjectOutputs(inputs.outputs)
);

/** По какой выработке делится бригада: одной суммой (brigade) или по объектам. */
export type BrigadeOutputMode = 'objects' | 'brigade';

export const brigadeOutputMode = (inputs: Pick<IBrigadeSalaryInputs, 'brigadeOutput'>): BrigadeOutputMode => (
  inputs.brigadeOutput !== null ? 'brigade' : 'objects'
);

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
  const brigadeRows = await rows<{ amount: string }>(
    exec,
    'SELECT amount::text AS amount FROM brigade_salary_brigade_outputs WHERE department_id = $1 AND month = $2::date',
    [departmentId, monthStart],
  );
  const ktu = new Map<number, number>();
  for (const row of ktuRows) {
    const tenths = Math.round(Number(row.ktu) * 10);
    if (tenths !== DEFAULT_KTU_TENTHS) ktu.set(Number(row.employee_id), tenths);
  }
  const outputs = new Map<string, IBrigadeObjectOutput>();
  for (const row of outputRows) outputs.set(row.object_key, { amount: row.amount, object_name: row.object_name });
  return { outputs, brigadeOutput: brigadeRows[0]?.amount ?? null, ktu };
}

/** Версия отпечатка: 'v2:' — выработка по объектам (336). Расчёт с другим отпечатком пересчитывается. */
export const BRIGADE_INPUTS_HASH_PREFIX = 'v2:';

/**
 * Отпечаток ввода: меняется только от реальной смены выработки или КТУ. Порядок строк SQL и Map не важен — пары
 * сортируются; имя объекта не входит (переименование расчёт не меняет). Сумма бригаде (341) входит, только когда
 * она есть: у расчётов без неё отпечаток байт-в-байт прежний, и закрытые месяцы не пересчитываются.
 */
export const brigadeSalaryInputsHash = (inputs: IBrigadeSalaryInputs): string => {
  const outputs = [...inputs.outputs]
    .map(([key, output]) => [key, centsToMoney(moneyToCents(output.amount))])
    .sort(([a], [b]) => a.localeCompare(b));
  const ktu = [...inputs.ktu].filter(([, tenths]) => tenths !== DEFAULT_KTU_TENTHS).sort(([a], [b]) => a - b);
  const payload = inputs.brigadeOutput === null
    ? { outputs, ktu }
    : { outputs, ktu, brigade: centsToMoney(moneyToCents(inputs.brigadeOutput)) };
  return `${BRIGADE_INPUTS_HASH_PREFIX}${crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
};

/** Ключ advisory-замка (бригада, месяц): тот же у фиксации, записи выработки и триггера 341. */
export const brigadeSalaryLockKey = (departmentId: string, month: string): string => (
  `brigade_salary:${departmentId}:${month}`
);

/** Выработка внесена другим способом: сумма бригаде при выработке по объектам или наоборот (409). */
export class BrigadeOutputModeConflictError extends Error {
  readonly code = 'OUTPUT_MODE_CONFLICT' as const;
}

const OBJECTS_FILLED = 'Внесена выработка по объектам — сотрите её, чтобы внести на бригаду';
const BRIGADE_FILLED = 'Внесена выработка бригаде — сотрите её, чтобы вносить по объектам';

/** Отказ триггера 341 (страховка на случай записи в обход сервиса) — тот же 409. */
export const isOutputModeConflictDbError = (err: unknown): err is { message: string } => (
  typeof err === 'object' && err !== null
  && (err as { code?: unknown }).code === 'P0001'
  && (err as { hint?: unknown }).hint === 'OUTPUT_MODE_CONFLICT'
);

/** Смена выработки: прежнее и новое значения строками; null — не внесена. Равны — ничего не записано. */
export interface IBrigadeOutputChange {
  before: string | null;
  after: string | null;
}

/** Аудит смены — в той же транзакции, что запись: нет записи без следа и следа без записи. */
export type BrigadeOutputAudit = (client: PoolClient, change: IBrigadeOutputChange) => Promise<void>;

/**
 * Транзакция записи выработки (бригада, месяц) под тем же advisory-замком, что фиксация расчёта и триггер 341:
 * проверка «или — или» и запись не разрываются чужой записью. Аудит — только при реальной смене.
 */
async function writeBrigadeOutput(
  departmentId: string,
  monthStart: string,
  write: (client: PoolClient) => Promise<IBrigadeOutputChange>,
  audit?: BrigadeOutputAudit,
): Promise<IBrigadeOutputChange> {
  return withTransaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      brigadeSalaryLockKey(departmentId, monthStart.slice(0, 7)),
    ]);
    const change = await write(client);
    if (audit && change.before !== change.after) await audit(client, change);
    return change;
  });
}

/**
 * Выработка бригады на объекте: null — стереть. Сумма при внесённой сумме бригаде — BrigadeOutputModeConflictError.
 * Та же сумма ещё раз — ни записи, ни updated_at, ни аудита (отпечаток расчёта тоже не меняется).
 */
export async function setBrigadeObjectOutput(
  departmentId: string,
  monthStart: string,
  objectKey: string,
  objectName: string,
  amount: string | null,
  actorUserId: string,
  audit?: BrigadeOutputAudit,
): Promise<IBrigadeOutputChange> {
  return writeBrigadeOutput(departmentId, monthStart, async client => {
    const previous = (await client.query<{ amount: string }>(
      `SELECT amount::text AS amount FROM brigade_salary_object_outputs
        WHERE department_id = $1 AND month = $2::date AND object_key = $3`,
      [departmentId, monthStart, objectKey],
    )).rows[0];
    if (amount === null) {
      await client.query(
        'DELETE FROM brigade_salary_object_outputs WHERE department_id = $1 AND month = $2::date AND object_key = $3',
        [departmentId, monthStart, objectKey],
      );
      return { before: previous?.amount ?? null, after: null };
    }
    const brigade = await client.query(
      'SELECT 1 FROM brigade_salary_brigade_outputs WHERE department_id = $1 AND month = $2::date',
      [departmentId, monthStart],
    );
    if ((brigade.rowCount ?? 0) > 0) throw new BrigadeOutputModeConflictError(BRIGADE_FILLED);
    const saved = (await client.query<{ amount: string }>(
      `INSERT INTO brigade_salary_object_outputs
         (department_id, month, object_key, object_name, amount, updated_by, updated_at)
       VALUES ($1, $2::date, $3, $4, $5::numeric, $6, now())
       ON CONFLICT (department_id, month, object_key)
       DO UPDATE SET object_name = EXCLUDED.object_name, amount = EXCLUDED.amount,
                     updated_by = EXCLUDED.updated_by, updated_at = now()
        WHERE brigade_salary_object_outputs.amount IS DISTINCT FROM EXCLUDED.amount
       RETURNING amount::text AS amount`,
      [departmentId, monthStart, objectKey, objectName, amount, actorUserId],
    )).rows[0];
    return { before: previous?.amount ?? null, after: saved?.amount ?? previous?.amount ?? amount };
  }, audit);
}

/**
 * Выработка одной суммой на бригаду (341): null — стереть (уже пустую — ничего не меняет). Сумма при внесённой
 * выработке по объектам — BrigadeOutputModeConflictError. Та же сумма ещё раз — ни записи, ни аудита.
 */
export async function setBrigadeOutput(
  departmentId: string,
  monthStart: string,
  amount: string | null,
  actorUserId: string,
  audit?: BrigadeOutputAudit,
): Promise<IBrigadeOutputChange> {
  return writeBrigadeOutput(departmentId, monthStart, async client => {
    const previous = (await client.query<{ amount: string }>(
      'SELECT amount::text AS amount FROM brigade_salary_brigade_outputs WHERE department_id = $1 AND month = $2::date',
      [departmentId, monthStart],
    )).rows[0];
    if (amount === null) {
      if (previous) {
        await client.query(
          'DELETE FROM brigade_salary_brigade_outputs WHERE department_id = $1 AND month = $2::date',
          [departmentId, monthStart],
        );
      }
      return { before: previous?.amount ?? null, after: null };
    }
    const objects = await client.query(
      'SELECT 1 FROM brigade_salary_object_outputs WHERE department_id = $1 AND month = $2::date LIMIT 1',
      [departmentId, monthStart],
    );
    if ((objects.rowCount ?? 0) > 0) throw new BrigadeOutputModeConflictError(OBJECTS_FILLED);
    const saved = (await client.query<{ amount: string }>(
      `INSERT INTO brigade_salary_brigade_outputs (department_id, month, amount, updated_by, updated_at)
       VALUES ($1, $2::date, $3::numeric, $4, now())
       ON CONFLICT (department_id, month)
       DO UPDATE SET amount = EXCLUDED.amount, updated_by = EXCLUDED.updated_by, updated_at = now()
        WHERE brigade_salary_brigade_outputs.amount IS DISTINCT FROM EXCLUDED.amount
       RETURNING amount::text AS amount`,
      [departmentId, monthStart, amount, actorUserId],
    )).rows[0];
    return { before: previous?.amount ?? null, after: saved?.amount ?? previous?.amount ?? amount };
  }, audit);
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
