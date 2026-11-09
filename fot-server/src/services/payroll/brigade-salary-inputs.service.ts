/**
 * Ввод вкладок «Табель → Зарплата по объектам» и «Бригады»: «Выработка» бригады на объектах (миграция 336) ИЛИ
 * одной суммой на бригаду (341, не обе сразу — следит триггер БД), КТУ рабочих за месяц (330) и «Доли», вписанные
 * рублями (355). Нет строки выработки — «не внесена» (это не 0,00); нет строки КТУ — 1,0: КТУ 1,0 не хранится, чтобы
 * отпечаток ввода не менялся от «поставили 1,0 обратно»; нет строки доли — доля по формуле.
 *
 * Вписанная доля снимается выбором КТУ сотрудника и вместе со стёртой выработкой своего ключа — в той же транзакции и
 * аудите, под замком бригады: «ожить» при повторном вводе выработки ей нечему.
 */
import crypto from 'node:crypto';

import type { PoolClient } from 'pg';

import type { DbExecutor } from '../../config/postgres.js';
import { query, withTransaction } from '../../config/postgres.js';
import { centsToMoney, moneyToCents } from './brigade-salary.calc.js';

export const DEFAULT_KTU_TENTHS = 10;

/** Ключ вписанной доли при выработке одной суммой на бригаду (341): «объект» — вся бригада. */
export const BRIGADE_WHOLE_SHARE_KEY = '__brigade__';

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
  /**
   * «Доли», вписанные рублями (355): ключ выработки (object_key или '__brigade__') → сотрудник → NUMERIC(12,2) строкой.
   * Нет поля — не вписано ни одной (так у ввода без долей и у старых данных).
   */
  fixedShares?: Map<string, Map<number, string>>;
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

interface IOutputDbRow { department_id: string; object_key: string; object_name: string; amount: string }
interface IKtuDbRow { department_id: string; employee_id: string | number; ktu: string }
interface IBrigadeOutputDbRow { department_id: string; amount: string }
interface IShareDbRow { department_id: string; object_key: string; employee_id: string | number; amount: string }

/** Ввод бригады из строк четырёх таблиц (одной бригады): одно правило для одиночной и пакетной загрузки. */
const buildBrigadeSalaryInputs = (
  outputRows: readonly IOutputDbRow[],
  ktuRows: readonly IKtuDbRow[],
  brigadeRows: readonly IBrigadeOutputDbRow[],
  shareRows: readonly IShareDbRow[] = [],
): IBrigadeSalaryInputs => {
  const ktu = new Map<number, number>();
  for (const row of ktuRows) {
    const tenths = Math.round(Number(row.ktu) * 10);
    if (tenths !== DEFAULT_KTU_TENTHS) ktu.set(Number(row.employee_id), tenths);
  }
  const outputs = new Map<string, IBrigadeObjectOutput>();
  for (const row of outputRows) outputs.set(row.object_key, { amount: row.amount, object_name: row.object_name });
  const inputs: IBrigadeSalaryInputs = { outputs, brigadeOutput: brigadeRows[0]?.amount ?? null, ktu };
  if (shareRows.length === 0) return inputs;
  const fixedShares = new Map<string, Map<number, string>>();
  for (const row of shareRows) {
    const byEmployee = fixedShares.get(row.object_key) ?? new Map<number, string>();
    byEmployee.set(Number(row.employee_id), row.amount);
    fixedShares.set(row.object_key, byEmployee);
  }
  return { ...inputs, fixedShares };
};

/** Вписанные доли ключа в копейках: для расчёта. */
export const fixedSharesInCents = (
  inputs: Pick<IBrigadeSalaryInputs, 'fixedShares'>,
  key: string,
): Map<number, bigint> => new Map(
  [...(inputs.fixedShares?.get(key) ?? [])].map(([employeeId, amount]) => [employeeId, moneyToCents(amount)]),
);

/**
 * Строки ввода бригад месяца; выработка по объектам — по бригаде в порядке object_key. department_id — ровно та строка,
 * что передана (не текст uuid из БД): по ней ищет вызывающий.
 */
const loadInputRows = async (
  departmentIds: readonly string[],
  monthStart: string,
  exec?: DbExecutor,
): Promise<{
  outputRows: IOutputDbRow[]; ktuRows: IKtuDbRow[]; brigadeRows: IBrigadeOutputDbRow[]; shareRows: IShareDbRow[];
}> => {
  const params = [[...departmentIds], monthStart];
  // Последовательно: на клиенте транзакции параллельные запросы не нужны.
  const outputRows = await rows<IOutputDbRow>(
    exec,
    `SELECT r.key AS department_id, o.object_key, o.object_name, o.amount::text AS amount
       FROM unnest($1::text[]) AS r(key)
       JOIN brigade_salary_object_outputs o ON o.department_id = r.key::uuid AND o.month = $2::date
      ORDER BY r.key, o.object_key`,
    params,
  );
  const ktuRows = await rows<IKtuDbRow>(
    exec,
    `SELECT r.key AS department_id, k.employee_id, k.ktu::text AS ktu
       FROM unnest($1::text[]) AS r(key)
       JOIN brigade_salary_ktu k ON k.department_id = r.key::uuid AND k.month = $2::date
      ORDER BY r.key, k.employee_id`,
    params,
  );
  const brigadeRows = await rows<IBrigadeOutputDbRow>(
    exec,
    `SELECT r.key AS department_id, b.amount::text AS amount
       FROM unnest($1::text[]) AS r(key)
       JOIN brigade_salary_brigade_outputs b ON b.department_id = r.key::uuid AND b.month = $2::date`,
    params,
  );
  const shareRows = await rows<IShareDbRow>(
    exec,
    `SELECT r.key AS department_id, f.object_key, f.employee_id, f.amount::text AS amount
       FROM unnest($1::text[]) AS r(key)
       JOIN brigade_salary_fixed_shares f ON f.department_id = r.key::uuid AND f.month = $2::date
      ORDER BY r.key, f.object_key, f.employee_id`,
    params,
  );
  return { outputRows, ktuRows, brigadeRows, shareRows };
};

export async function loadBrigadeSalaryInputs(
  departmentId: string,
  monthStart: string,
  exec?: DbExecutor,
): Promise<IBrigadeSalaryInputs> {
  const { outputRows, ktuRows, brigadeRows, shareRows } = await loadInputRows([departmentId], monthStart, exec);
  return buildBrigadeSalaryInputs(outputRows, ktuRows, brigadeRows, shareRows);
}

/**
 * Ввод многих бригад месяца тремя запросами («Свод», «Расчёты»): запись на каждую запрошенную бригаду, у бригады без
 * строк — ничего не внесено (как у loadBrigadeSalaryInputs).
 */
export async function loadBrigadeSalaryInputsMany(
  departmentIds: readonly string[],
  monthStart: string,
  exec?: DbExecutor,
): Promise<Map<string, IBrigadeSalaryInputs>> {
  const ids = [...new Set(departmentIds)];
  if (ids.length === 0) return new Map();
  const { outputRows, ktuRows, brigadeRows, shareRows } = await loadInputRows(ids, monthStart, exec);
  const of = <T extends { department_id: string }>(list: readonly T[], id: string): T[] => (
    list.filter(row => row.department_id === id)
  );
  return new Map(ids.map(id => [
    id,
    buildBrigadeSalaryInputs(of(outputRows, id), of(ktuRows, id), of(brigadeRows, id), of(shareRows, id)),
  ]));
}

/** Версия отпечатка: 'v2:' — выработка по объектам (336). Расчёт с другим отпечатком пересчитывается. */
export const BRIGADE_INPUTS_HASH_PREFIX = 'v2:';

/**
 * Отпечаток ввода: меняется только от реальной смены выработки, КТУ или вписанной доли. Порядок строк SQL и Map не
 * важен — пары сортируются; имя объекта не входит (переименование расчёт не меняет). Сумма бригаде (341) и вписанные
 * доли (355) входят, только когда они есть: у расчётов без них отпечаток байт-в-байт прежний, и закрытые месяцы не
 * пересчитываются.
 */
export const brigadeSalaryInputsHash = (inputs: IBrigadeSalaryInputs): string => {
  const outputs = [...inputs.outputs]
    .map(([key, output]) => [key, centsToMoney(moneyToCents(output.amount))])
    .sort(([a], [b]) => a.localeCompare(b));
  const ktu = [...inputs.ktu].filter(([, tenths]) => tenths !== DEFAULT_KTU_TENTHS).sort(([a], [b]) => a - b);
  const shares = [...(inputs.fixedShares ?? [])]
    .filter(([, byEmployee]) => byEmployee.size > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, byEmployee]) => [
      key,
      [...byEmployee].sort(([a], [b]) => a - b).map(([employeeId, amount]) => [employeeId, centsToMoney(moneyToCents(amount))]),
    ]);
  const payload: Record<string, unknown> = { outputs, ktu };
  if (inputs.brigadeOutput !== null) payload.brigade = centsToMoney(moneyToCents(inputs.brigadeOutput));
  if (shares.length > 0) payload.shares = shares;
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

/** Вписанная доля, снятая вместе с выработкой или выбором КТУ: для аудита. */
export interface IClearedShare {
  object_key: string;
  employee_id: number;
  amount: string;
}

/** Смена выработки: прежнее и новое значения строками; null — не внесена. Равны — ничего не записано. */
export interface IBrigadeOutputChange {
  before: string | null;
  after: string | null;
  /** Стёрли выработку — вписанные доли этого ключа сняты вместе с ней. */
  cleared_shares?: IClearedShare[];
}

/** Снять вписанные доли (бригада, месяц) по условию — в транзакции записи, под её замком. */
const clearShares = async (
  client: PoolClient,
  departmentId: string,
  monthStart: string,
  where: { objectKey: string } | { employeeId: number },
): Promise<IClearedShare[]> => {
  const byKey = 'objectKey' in where;
  const removed = (await client.query<{ object_key: string; employee_id: string | number; amount: string }>(
    `DELETE FROM brigade_salary_fixed_shares
      WHERE department_id = $1 AND month = $2::date AND ${byKey ? 'object_key = $3' : 'employee_id = $3'}
      RETURNING object_key, employee_id, amount::text AS amount`,
    [departmentId, monthStart, byKey ? where.objectKey : where.employeeId],
  )).rows;
  return removed
    .map(row => ({ object_key: row.object_key, employee_id: Number(row.employee_id), amount: row.amount }))
    .sort((a, b) => a.object_key.localeCompare(b.object_key) || a.employee_id - b.employee_id);
};

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
      const cleared = await clearShares(client, departmentId, monthStart, { objectKey });
      return { before: previous?.amount ?? null, after: null, ...(cleared.length > 0 ? { cleared_shares: cleared } : {}) };
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
      const cleared = await clearShares(client, departmentId, monthStart, { objectKey: BRIGADE_WHOLE_SHARE_KEY });
      return { before: previous?.amount ?? null, after: null, ...(cleared.length > 0 ? { cleared_shares: cleared } : {}) };
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

/** Смена КТУ: прежнее и новое значения в десятых и снятые вписанные доли сотрудника за месяц. */
export interface IBrigadeKtuChange {
  before: number;
  after: number;
  cleared_shares: IClearedShare[];
}

/**
 * КТУ в десятых; 1,0 удаляет строку. Выбор КТУ снимает все вписанные доли сотрудника за месяц (доля снова по формуле).
 * Одна транзакция под замком бригады: КТУ, снятие долей и аудит — аудит только при реальной смене (КТУ другой или
 * снята хоть одна доля); тот же КТУ без долей — ни записи в аудит, ни смены отпечатка.
 */
export async function setBrigadeKtu(
  departmentId: string,
  monthStart: string,
  employeeId: number,
  ktuTenths: number,
  actorUserId: string,
  audit?: (client: PoolClient, change: IBrigadeKtuChange) => Promise<void>,
): Promise<IBrigadeKtuChange> {
  return withTransaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      brigadeSalaryLockKey(departmentId, monthStart.slice(0, 7)),
    ]);
    const previous = (await client.query<{ ktu: string }>(
      `SELECT ktu::text AS ktu FROM brigade_salary_ktu
        WHERE department_id = $1 AND month = $2::date AND employee_id = $3`,
      [departmentId, monthStart, employeeId],
    )).rows[0];
    const before = previous ? Math.round(Number(previous.ktu) * 10) : DEFAULT_KTU_TENTHS;
    if (ktuTenths === DEFAULT_KTU_TENTHS) {
      await client.query(
        'DELETE FROM brigade_salary_ktu WHERE department_id = $1 AND month = $2::date AND employee_id = $3',
        [departmentId, monthStart, employeeId],
      );
    } else if (before !== ktuTenths) {
      await client.query(
        `INSERT INTO brigade_salary_ktu (department_id, month, employee_id, ktu, updated_by, updated_at)
         VALUES ($1, $2::date, $3, $4::numeric, $5, now())
         ON CONFLICT (department_id, month, employee_id)
         DO UPDATE SET ktu = EXCLUDED.ktu, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [departmentId, monthStart, employeeId, (ktuTenths / 10).toFixed(1), actorUserId],
      );
    }
    const cleared = await clearShares(client, departmentId, monthStart, { employeeId });
    const change: IBrigadeKtuChange = { before, after: ktuTenths, cleared_shares: cleared };
    if (audit && (before !== ktuTenths || cleared.length > 0)) await audit(client, change);
    return change;
  });
}

/** Отказ записи вписанной доли: текст для 400. */
export class BrigadeShareRejectedError extends Error {
  readonly code = 'SHARE_REJECTED' as const;
}

/** Смена вписанной доли: прежнее и новое значения строками; null — не вписана (по формуле). */
export interface IBrigadeShareChange {
  before: string | null;
  after: string | null;
}

/**
 * Вписанная доля сотрудника на ключе выработки (object_key или '__brigade__'); null — стереть (по существующей строке,
 * без проверок: конфликтную и без часов тоже можно). Сумма — после check: он получает ввод бригады, прочитанный в этой
 * же транзакции под замком, и бросает BrigadeShareRejectedError, если объект с новой долей не сойдётся. Две доли
 * одновременно проверяются по очереди: вторая видит первую. Та же сумма — ни записи, ни аудита.
 */
export async function setBrigadeShare(
  departmentId: string,
  monthStart: string,
  objectKey: string,
  employeeId: number,
  amount: string | null,
  actorUserId: string,
  check: (inputs: IBrigadeSalaryInputs) => void,
  audit?: (client: PoolClient, change: IBrigadeShareChange) => Promise<void>,
): Promise<IBrigadeShareChange> {
  return withTransaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      brigadeSalaryLockKey(departmentId, monthStart.slice(0, 7)),
    ]);
    const previous = (await client.query<{ amount: string }>(
      `SELECT amount::text AS amount FROM brigade_salary_fixed_shares
        WHERE department_id = $1 AND month = $2::date AND object_key = $3 AND employee_id = $4`,
      [departmentId, monthStart, objectKey, employeeId],
    )).rows[0];
    const before = previous?.amount ?? null;
    if (amount === null) {
      if (before === null) return { before, after: null };
      await client.query(
        `DELETE FROM brigade_salary_fixed_shares
          WHERE department_id = $1 AND month = $2::date AND object_key = $3 AND employee_id = $4`,
        [departmentId, monthStart, objectKey, employeeId],
      );
      const change = { before, after: null };
      if (audit) await audit(client, change);
      return change;
    }
    if (before !== null && moneyToCents(before) === moneyToCents(amount)) return { before, after: before };
    check(await loadBrigadeSalaryInputs(departmentId, monthStart, client));
    const saved = (await client.query<{ amount: string }>(
      `INSERT INTO brigade_salary_fixed_shares (department_id, month, object_key, employee_id, amount, updated_by, updated_at)
       VALUES ($1, $2::date, $3, $4, $5::numeric, $6, now())
       ON CONFLICT (department_id, month, object_key, employee_id)
       DO UPDATE SET amount = EXCLUDED.amount, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING amount::text AS amount`,
      [departmentId, monthStart, objectKey, employeeId, amount, actorUserId],
    )).rows[0]!;
    const change = { before, after: saved.amount };
    if (audit) await audit(client, change);
    return change;
  });
}
