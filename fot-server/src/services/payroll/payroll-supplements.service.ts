/**
 * «Доплата» — таблица окна «Справочник» на «Расчётах» (миграция 315): плановые и разовые доплаты.
 *
 * Плановая — payroll_planned_supplements (миграция 293). С миграции 369 каждая неархивная строка с суммой —
 * самостоятельная действующая доплата: у сотрудника их может быть несколько на одни даты (у каждой свой комментарий,
 * миграция 364). Добавление — новая строка (отказ — только полный дубль: сумма, даты и комментарий); правка или снятие
 * строки из таблицы — rewritePlannedPeriod: строка в архив, новая с replaces_id (payroll-planned-supplement-rows.ts).
 * Все записи — под блокировкой сотрудника (lockPayrollEmployee).
 * Разовая — payroll_one_time_supplements: месяц, сумма, основание, комментарий (миграция 385); за месяц — сколько
 * угодно. Файлы разовой (миграция 354) — payroll_one_time_supplement_files: строка — объект R2; объекты грузит и
 * удаляет контроллер.
 */
import type { PoolClient } from 'pg';

import { query, queryOne, withTransaction } from '../../config/postgres.js';
import {
  lockPayrollEmployee,
  setPlannedSupplement,
  type IPlannedSupplementValue,
} from './payroll-terms.service.js';
import {
  insertPlannedPeriod,
  PLANNED_SUPPLEMENT_PERIODS_SQL,
  plannedValueOf,
  readPlannedPeriods,
  replacePlannedPeriod,
  resolvePlannedValue,
  samePlannedValue,
} from './payroll-planned-supplement-rows.js';
import { payrollContractorDeptsCte, payrollStaffWhereSql } from './payroll-registry-scope.service.js';

export { PLANNED_SUPPLEMENT_PERIODS_SQL };

export type PayrollSupplementKind = 'planned' | 'one_time';

/** Не больше 10 файлов у разовой доплаты (миграция 354). */
export const ONE_TIME_SUPPLEMENT_FILES_MAX = 10;

/** Файл разовой доплаты в списке: без ключа R2 — ссылку выдают по клику. */
export interface IOneTimeSupplementFile {
  id: number;
  file_name: string;
  file_size: number;
  mime_type: string;
}

/** Файл, уже загруженный в R2, — строка для payroll_one_time_supplement_files. */
export interface INewOneTimeSupplementFile {
  r2Key: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
}

export interface IPayrollSupplementRow {
  kind: PayrollSupplementKind;
  /** id разовой доплаты; у плановой — id версии журнала. */
  id: number;
  employee_id: number;
  full_name: string;
  department: string | null;
  position: string | null;
  /** Плановая — ₽/мес, разовая — ₽; numeric строкой. */
  amount: string;
  /** Плановая: YYYY-MM-DD. */
  date_from: string | null;
  date_to: string | null;
  /** Разовая: YYYY-MM. */
  month: string | null;
  reason: string | null;
  /** Плановая — комментарий периода (миграция 364), разовая — комментарий доплаты (миграция 385). */
  comment: string | null;
  /** Файлы разовой (по порядку прикрепления); у плановой — пусто. */
  files: IOneTimeSupplementFile[];
}

export interface IOneTimeSupplement {
  id: number;
  employee_id: number;
  full_name: string;
  /** YYYY-MM. */
  month: string;
  amount: string;
  reason: string;
  comment: string | null;
  files: IOneTimeSupplementFile[];
}

export interface IOneTimeSupplementInput {
  /** YYYY-MM. */
  month: string;
  amount: number;
  reason: string;
  /** null — без комментария; undefined (прежний клиент) — при добавлении null, при правке прежний. */
  comment?: string | null;
}

/** Файлы разовой доплаты `alias` JSON-массивом по порядку прикрепления. */
const oneTimeFilesSql = (alias: string): string => `COALESCE((
  SELECT json_agg(json_build_object(
           'id', f.id, 'file_name', f.file_name, 'file_size', f.file_size, 'mime_type', f.mime_type
         ) ORDER BY f.created_at, f.id)
    FROM payroll_one_time_supplement_files f
   WHERE f.supplement_id = ${alias}.id), '[]'::json)`;

/** Плановые (PLANNED_SUPPLEMENT_PERIODS_SQL) и разовые доплаты «штата зарплаты». */
export const listSupplements = async (scope: {
  contractorRootId: string | null;
  departmentIds: string[] | null;
}): Promise<IPayrollSupplementRow[]> => {
  if (scope.departmentIds?.length === 0) return [];
  return query<IPayrollSupplementRow>(
    `WITH ${payrollContractorDeptsCte('$1')},
     staff AS (
       SELECT e.id, e.full_name, d.name AS department, p.name AS position
         FROM employees e
         LEFT JOIN org_departments d ON d.id = e.org_department_id
         LEFT JOIN positions p ON p.id = e.position_id
        WHERE ${payrollStaffWhereSql('e', '$2')}
     )
     SELECT * FROM (
       SELECT 'planned'::text AS kind, v.id::int AS id, s.id AS employee_id, s.full_name, s.department, s.position,
              v.amount::text AS amount,
              to_char(v.date_from, 'YYYY-MM-DD') AS date_from,
              to_char(v.date_to, 'YYYY-MM-DD') AS date_to,
              NULL::text AS month, NULL::text AS reason, c.comment, '[]'::json AS files
         FROM staff s
         JOIN (${PLANNED_SUPPLEMENT_PERIODS_SQL}) v ON v.employee_id = s.id
         -- Комментарий — из строки журнала: PLANNED_SUPPLEMENT_PERIODS_SQL читает и расчёт ФОТ, его не расширяем.
         JOIN payroll_planned_supplements c ON c.id = v.id
       UNION ALL
       SELECT 'one_time'::text, o.id, s.id, s.full_name, s.department, s.position,
              o.amount::text, NULL, NULL, to_char(o.month, 'YYYY-MM'), o.reason, o.comment, ${oneTimeFilesSql('o')}
         FROM staff s
         JOIN payroll_one_time_supplements o ON o.employee_id = s.id
     ) rows
     -- Плановые сотрудника — по дате начала (правка строки меняет её id, порядок по id «прыгал» бы).
     ORDER BY full_name, employee_id, kind DESC, month DESC NULLS FIRST, date_from, id`,
    [scope.contractorRootId, scope.departmentIds],
  );
};

export type PlannedSetResult =
  | { status: 'exists' }
  | { status: 'unchanged' }
  | { status: 'saved'; previous: IPlannedSupplementValue | null };

/**
 * Записать плановую доплату. onlyIfNone — добавление из таблицы: новая доплата рядом с прежними (даты могут
 * совпадать — разные доплаты); полный дубль действующей (сумма, даты, комментарий) — 'exists'; комментарий undefined —
 * без комментария. Без onlyIfNone — прежний контракт «одна доплата» по сотруднику (PUT/DELETE …/employee/:empId,
 * прежний клиент): правка или снятие последней по дате (setPlannedSupplement), previous — её значение.
 */
export const savePlannedSupplement = async (input: {
  employeeId: number;
  value: IPlannedSupplementValue | null;
  createdBy: string;
  onlyIfNone?: boolean;
}): Promise<PlannedSetResult> => withTransaction(async client => {
  await lockPayrollEmployee(client, input.employeeId);
  if (!input.onlyIfNone || input.value === null) {
    return setPlannedSupplement(client, input);
  }
  const value = resolvePlannedValue(input.value, null);
  const periods = await readPlannedPeriods(client, input.employeeId);
  if (periods.some(period => samePlannedValue(period, value))) return { status: 'exists' };
  await insertPlannedPeriod(client, { employeeId: input.employeeId, value, createdBy: input.createdBy });
  return { status: 'saved', previous: null };
});

/** Сотрудник строки журнала плановой доплаты; строки нет — null. */
export const getPlannedPeriodEmployeeId = async (periodId: number): Promise<number | null> => (
  (await queryOne<{ employee_id: number }>(
    'SELECT employee_id FROM payroll_planned_supplements WHERE id = $1',
    [periodId],
  ))?.employee_id ?? null
);

export type PlannedPeriodRewriteResult =
  | { status: 'stale' }
  | { status: 'exists' }
  | { status: 'unchanged' }
  /** next — записанное значение (комментарий разрешён); null — доплата снята. */
  | { status: 'saved'; previous: IPlannedSupplementValue; next: IPlannedSupplementValue | null };

/**
 * Поправить (value) или снять (null) одну действующую плановую доплату по id строки. Остальные доплаты сотрудника —
 * и на те же даты — не меняются (миграция 369): строка в архив, правка — новая строка с replaces_id, снятие — архивная
 * строка «снята». Комментарий undefined (🗑 «Убрать» закрывает доплату датой «по», прежний клиент) — комментарий строки.
 *
 * 'stale' — строки уже нет среди действующих (её поправили в другом окне); 'exists' — новое значение совпало с другой
 * действующей доплатой сотрудника (сумма, даты, комментарий).
 */
export const rewritePlannedPeriod = async (input: {
  employeeId: number;
  periodId: number;
  value: IPlannedSupplementValue | null;
  createdBy: string;
}): Promise<PlannedPeriodRewriteResult> => withTransaction(async client => {
  await lockPayrollEmployee(client, input.employeeId);
  const periods = await readPlannedPeriods(client, input.employeeId);
  const target = periods.find(period => period.id === input.periodId);
  if (!target) return { status: 'stale' };
  const value = input.value && resolvePlannedValue(input.value, target.comment);
  if (value !== null) {
    if (samePlannedValue(target, value)) return { status: 'unchanged' };
    if (periods.some(period => period !== target && samePlannedValue(period, value))) return { status: 'exists' };
  }
  await replacePlannedPeriod(client, { employeeId: input.employeeId, target, value, createdBy: input.createdBy });
  return { status: 'saved', previous: plannedValueOf(target), next: value };
});

/** Действующая плановая доплата сотрудника — для списка в окне сотрудника; суммы — NUMERIC текстом. */
export interface IEmployeePlannedSupplement {
  id: number;
  amount: string;
  /** YYYY-MM-DD. */
  date_from: string;
  /** YYYY-MM-DD; null — бессрочно. */
  date_to: string | null;
  comment: string | null;
}

/** Действующие плановые доплаты сотрудника: последняя по дате — первой (как правит прежний клиент). */
export const listEmployeePlannedSupplements = async (employeeId: number): Promise<IEmployeePlannedSupplement[]> =>
  query<IEmployeePlannedSupplement>(
    `SELECT x.id::int AS id, x.amount::text AS amount,
            to_char(x.date_from, 'YYYY-MM-DD') AS date_from,
            to_char(x.date_to, 'YYYY-MM-DD') AS date_to,
            x.comment
       FROM payroll_planned_supplements x
      WHERE x.employee_id = $1 AND x.archived_at IS NULL AND x.amount IS NOT NULL
      ORDER BY x.date_from DESC, x.id DESC`,
    [employeeId],
  );

const ONE_TIME_SELECT = `
  SELECT o.id, o.employee_id, e.full_name, to_char(o.month, 'YYYY-MM') AS month, o.amount::text AS amount, o.reason,
         o.comment, ${oneTimeFilesSql('o')} AS files
    FROM payroll_one_time_supplements o
    JOIN employees e ON e.id = o.employee_id`;

export const getOneTimeSupplement = async (id: number): Promise<IOneTimeSupplement | null> =>
  queryOne<IOneTimeSupplement>(`${ONE_TIME_SELECT} WHERE o.id = $1`, [id]);

/**
 * Разовая доплата в транзакции; lock — сначала блокировка строки доплаты, потом чтение ОТДЕЛЬНЫМ запросом:
 * у READ COMMITTED новый запрос видит файлы, записанные тем, кто держал блокировку до нас (в одном запросе с
 * FOR UPDATE подзапрос файлов читался бы по снимку до ожидания — два параллельных добавления прошли бы лимит).
 */
const readOneTime = async (client: PoolClient, id: number, lock: boolean): Promise<IOneTimeSupplement | null> => {
  if (lock) {
    const locked = await client.query('SELECT 1 FROM payroll_one_time_supplements WHERE id = $1 FOR UPDATE', [id]);
    if (locked.rowCount === 0) return null;
  }
  return (await client.query<IOneTimeSupplement>(`${ONE_TIME_SELECT} WHERE o.id = $1`, [id])).rows[0] ?? null;
};

const insertOneTimeFiles = async (
  client: PoolClient,
  supplementId: number,
  files: readonly INewOneTimeSupplementFile[],
): Promise<void> => {
  for (const file of files) {
    await client.query(
      `INSERT INTO payroll_one_time_supplement_files (supplement_id, r2_key, file_name, file_size, mime_type)
       VALUES ($1, $2, $3, $4, $5)`,
      [supplementId, file.r2Key, file.fileName, file.fileSize, file.mimeType],
    );
  }
};

/** Запись аудита в транзакции операции: не записалась — откатывается и сама операция. */
type OneTimeAuditFn<Args extends unknown[]> = (client: PoolClient, ...args: Args) => Promise<void>;

/** Добавить разовую доплату с файлами (уже в R2) и аудитом — одной транзакцией. */
export const addOneTimeSupplement = async (
  employeeId: number,
  input: IOneTimeSupplementInput,
  options: { files?: readonly INewOneTimeSupplementFile[]; audit?: OneTimeAuditFn<[IOneTimeSupplement]> } = {},
): Promise<IOneTimeSupplement> => withTransaction(async client => {
  const row = (await client.query<{ id: number }>(
    `INSERT INTO payroll_one_time_supplements (employee_id, month, amount, reason, comment)
     VALUES ($1, ($2 || '-01')::date, $3::numeric, $4, $5) RETURNING id`,
    [employeeId, input.month, input.amount, input.reason, input.comment ?? null],
  )).rows[0];
  if (!row) throw new Error('Разовая доплата не добавлена');
  await insertOneTimeFiles(client, row.id, options.files ?? []);
  const created = await readOneTime(client, row.id, false);
  if (!created) throw new Error('Разовая доплата не найдена после добавления');
  await options.audit?.(client, created);
  return created;
});

export type OneTimeUpdateResult =
  | { status: 'not_found' }
  /** Снимаемого файла у доплаты уже нет (сняли в другом окне). */
  | { status: 'stale' }
  /** Файлов стало бы больше ONE_TIME_SUPPLEMENT_FILES_MAX. */
  | { status: 'too_many' }
  | {
    status: 'saved';
    before: IOneTimeSupplement;
    after: IOneTimeSupplement;
    /** Изменилось ли хоть что-то (поля или файлы) — тогда записан аудит. */
    changed: boolean;
    /** Ключи R2 снятых файлов — удалить после коммита. */
    removedKeys: string[];
  };

/**
 * Изменить месяц, сумму, основание и комментарий (undefined — прежний), снять файлы removeFileIds и добавить addFiles
 * (уже в R2) — одной транзакцией под блокировкой доплаты. Аудит (если изменилось хоть что-то) — в той же транзакции.
 */
export const updateOneTimeSupplement = async (
  id: number,
  input: IOneTimeSupplementInput,
  options: {
    addFiles?: readonly INewOneTimeSupplementFile[];
    removeFileIds?: readonly number[];
    audit?: OneTimeAuditFn<[IOneTimeSupplement, IOneTimeSupplement]>;
  } = {},
): Promise<OneTimeUpdateResult> => withTransaction(async client => {
  const addFiles = options.addFiles ?? [];
  const removeIds = options.removeFileIds ?? [];
  const before = await readOneTime(client, id, true);
  if (!before) return { status: 'not_found' };
  const own = new Set(before.files.map(file => file.id));
  if (removeIds.some(fileId => !own.has(fileId))) return { status: 'stale' };
  if (before.files.length - removeIds.length + addFiles.length > ONE_TIME_SUPPLEMENT_FILES_MAX) {
    return { status: 'too_many' };
  }
  await client.query(
    `UPDATE payroll_one_time_supplements
        SET month = ($2 || '-01')::date, amount = $3::numeric, reason = $4, comment = $5, updated_at = now()
      WHERE id = $1`,
    // before прочитан под блокировкой строки: прежний комментарий не перезапишет чужую правку.
    [id, input.month, input.amount, input.reason, input.comment === undefined ? before.comment : input.comment],
  );
  const removedKeys = removeIds.length === 0 ? [] : (await client.query<{ r2_key: string }>(
    `DELETE FROM payroll_one_time_supplement_files WHERE supplement_id = $1 AND id = ANY($2::int[]) RETURNING r2_key`,
    [id, removeIds],
  )).rows.map(row => row.r2_key);
  await insertOneTimeFiles(client, id, addFiles);
  const after = await readOneTime(client, id, false);
  if (!after) return { status: 'not_found' };
  const changed = before.month !== after.month || before.amount !== after.amount || before.reason !== after.reason
    || before.comment !== after.comment || removeIds.length > 0 || addFiles.length > 0;
  if (changed) await options.audit?.(client, before, after);
  return { status: 'saved', before, after, changed, removedKeys };
});

/** Удалить разовую доплату (файлы — каскадом) и записать аудит; её нет — null. Ключи R2 — удалить после коммита. */
export const deleteOneTimeSupplement = async (
  id: number,
  options: { audit?: OneTimeAuditFn<[IOneTimeSupplement]> } = {},
): Promise<{ deleted: IOneTimeSupplement; r2Keys: string[] } | null> => withTransaction(async client => {
  const before = await readOneTime(client, id, true);
  if (!before) return null;
  const r2Keys = (await client.query<{ r2_key: string }>(
    'SELECT r2_key FROM payroll_one_time_supplement_files WHERE supplement_id = $1 ORDER BY id',
    [id],
  )).rows.map(row => row.r2_key);
  await client.query(`DELETE FROM payroll_one_time_supplements WHERE id = $1`, [id]);
  await options.audit?.(client, before);
  return { deleted: before, r2Keys };
});

/** Файл разовой доплаты для ссылки: только если он этой доплаты. */
export const getOneTimeSupplementFile = async (
  supplementId: number,
  fileId: number,
): Promise<{ employee_id: number; r2_key: string; file_name: string; mime_type: string } | null> =>
  queryOne(
    `SELECT o.employee_id, f.r2_key, f.file_name, f.mime_type
       FROM payroll_one_time_supplement_files f
       JOIN payroll_one_time_supplements o ON o.id = f.supplement_id
      WHERE f.id = $2 AND f.supplement_id = $1`,
    [supplementId, fileId],
  );
