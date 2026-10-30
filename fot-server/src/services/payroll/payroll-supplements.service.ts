/**
 * «Доплата» — таблица окна «Справочник» на «Расчётах» (миграция 315): плановые и разовые доплаты.
 *
 * Плановая — прежний журнал payroll_planned_supplements (миграция 293), тот же, что в окне сотрудника:
 * текущая — ПОСЛЕДНЯЯ неархивная строка журнала по id; если у неё amount NULL, доплата снята. Окно
 * сотрудника и добавление пишут через setPlannedSupplement под блокировкой сотрудника; добавили новый
 * период — прежние остаются в таблице. Правка или снятие любого периода из таблицы (миграция 337) —
 * rewritePlannedPeriod: расписание сотрудника переписывается, прежние строки — архив (archived_at).
 * Разовая — payroll_one_time_supplements: месяц, сумма, основание; за месяц — сколько угодно.
 */
import type { PoolClient } from 'pg';

import { query, queryOne, withTransaction } from '../../config/postgres.js';
import {
  lockPayrollEmployee,
  setPlannedSupplement,
  type IPlannedSupplementValue,
} from './payroll-terms.service.js';
import { payrollContractorDeptsCte, payrollStaffWhereSql } from './payroll-registry-scope.service.js';

export type PayrollSupplementKind = 'planned' | 'one_time';

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
  /** Плановая: последняя версия журнала (false — прошлый период, только история); у разовой — null. */
  is_current: boolean | null;
}

export interface IOneTimeSupplement {
  id: number;
  employee_id: number;
  full_name: string;
  /** YYYY-MM. */
  month: string;
  amount: string;
  reason: string;
}

export interface IOneTimeSupplementInput {
  /** YYYY-MM. */
  month: string;
  amount: number;
  reason: string;
}

/**
 * Действующие периоды плановой доплаты по журналу всех сотрудников: текущая (не снятая) версия и прошлые
 * периоды — версия, после которой доплату не сняли и чей период не пересекается ни с одной более поздней
 * ненулевой версией. Пересекается — это правка (сумма, даты), прежняя версия не действует. Окна — по всему
 * журналу сотрудника, отсев — после: снятая не «оживает» прежней версией; фильтровать месяц — снаружи.
 * Архивные строки (миграция 337, переписанное расписание) не участвуют вовсе.
 */
export const PLANNED_SUPPLEMENT_PERIODS_SQL = `
  SELECT v.id, v.employee_id, v.amount, v.date_from, v.date_to, v.is_current
    FROM (
      SELECT x.id, x.employee_id, x.amount, x.date_from, x.date_to,
             x.id = max(x.id) OVER (PARTITION BY x.employee_id) AS is_current,
             lead(x.amount IS NULL) OVER (PARTITION BY x.employee_id ORDER BY x.id) AS next_removed
        FROM payroll_planned_supplements x
       WHERE x.archived_at IS NULL
    ) v
   WHERE v.amount IS NOT NULL
     AND (v.is_current OR (
           v.next_removed IS NOT TRUE
           AND NOT EXISTS (
             SELECT 1 FROM payroll_planned_supplements y
              WHERE y.employee_id = v.employee_id
                AND y.archived_at IS NULL
                AND y.id > v.id
                AND y.amount IS NOT NULL
                AND daterange(y.date_from, y.date_to, '[]') && daterange(v.date_from, v.date_to, '[]'))))`;

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
              NULL::text AS month, NULL::text AS reason, v.is_current
         FROM staff s
         JOIN (${PLANNED_SUPPLEMENT_PERIODS_SQL}) v ON v.employee_id = s.id
       UNION ALL
       SELECT 'one_time'::text, o.id, s.id, s.full_name, s.department, s.position,
              o.amount::text, NULL, NULL, to_char(o.month, 'YYYY-MM'), o.reason, NULL
         FROM staff s
         JOIN payroll_one_time_supplements o ON o.employee_id = s.id
     ) rows
     ORDER BY full_name, employee_id, kind DESC, month DESC NULLS FIRST, id`,
    [scope.contractorRootId, scope.departmentIds],
  );
};

/** Текущая плановая доплата сотрудника (последняя неархивная версия журнала; снята — null). */
const readPlanned = async (client: PoolClient, employeeId: number): Promise<IPlannedSupplementValue | null> => {
  const row = (await client.query<{ amount: string | null; date_from: string | null; date_to: string | null }>(
    `SELECT amount::text AS amount,
            to_char(date_from, 'YYYY-MM-DD') AS date_from,
            to_char(date_to, 'YYYY-MM-DD') AS date_to
       FROM payroll_planned_supplements
      WHERE employee_id = $1 AND archived_at IS NULL
      ORDER BY id DESC
      LIMIT 1`,
    [employeeId],
  )).rows[0];
  if (!row || row.amount === null || row.date_from === null) return null;
  return { amount: Number(row.amount), dateFrom: row.date_from, dateTo: row.date_to };
};

export type PlannedSetResult =
  | { status: 'exists' }
  | { status: 'unchanged' }
  | { status: 'saved'; previous: IPlannedSupplementValue | null };

/** Периоды «с — по» (YYYY-MM-DD включительно; «по» null — бессрочно) пересекаются. */
const plannedOverlap = (a: IPlannedSupplementValue, b: IPlannedSupplementValue): boolean => (
  (b.dateTo === null || a.dateFrom <= b.dateTo) && (a.dateTo === null || b.dateFrom <= a.dateTo)
);

/** Действующий период плановой доплаты сотрудника (PLANNED_SUPPLEMENT_PERIODS_SQL): id строки журнала и значение. */
interface IPlannedPeriod extends IPlannedSupplementValue {
  id: number;
}

/** Действующие периоды сотрудника по дате начала — то же, что видят таблица «Доплата» и расчёт. */
const readPeriods = async (client: PoolClient, employeeId: number): Promise<IPlannedPeriod[]> => (
  (await client.query<{ id: number; amount: string; date_from: string; date_to: string | null }>(
    `SELECT p.id::int AS id, p.amount::text AS amount,
            to_char(p.date_from, 'YYYY-MM-DD') AS date_from,
            to_char(p.date_to, 'YYYY-MM-DD') AS date_to
       FROM (${PLANNED_SUPPLEMENT_PERIODS_SQL}) p
      WHERE p.employee_id = $1
      ORDER BY p.date_from, p.id`,
    [employeeId],
  )).rows.map(row => ({ id: row.id, amount: Number(row.amount), dateFrom: row.date_from, dateTo: row.date_to }))
);

/**
 * Записать плановую доплату (null — снять). onlyIfNone — добавление из таблицы: новый период пересекается
 * с любым действующим периодом сотрудника — 'exists' (новая версия перекрыла бы его целиком, а не только
 * пересечение); не пересекается — новая версия, прежние периоды остаются в таблице. Новая версия журнала —
 * только при отличии (setPlannedSupplement).
 */
export const savePlannedSupplement = async (input: {
  employeeId: number;
  value: IPlannedSupplementValue | null;
  createdBy: string;
  onlyIfNone?: boolean;
}): Promise<PlannedSetResult> => withTransaction(async client => {
  await lockPayrollEmployee(client, input.employeeId);
  const previous = await readPlanned(client, input.employeeId);
  if (input.onlyIfNone) {
    const { value } = input;
    const exists = value === null
      ? previous !== null
      : (await readPeriods(client, input.employeeId)).some(period => plannedOverlap(period, value));
    if (exists) return { status: 'exists' };
  }
  const changed = await setPlannedSupplement(client, {
    employeeId: input.employeeId,
    value: input.value,
    createdBy: input.createdBy,
  });
  return changed ? { status: 'saved', previous } : { status: 'unchanged' };
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
  | { status: 'saved'; previous: IPlannedSupplementValue };

const sameValue = (a: IPlannedSupplementValue, b: IPlannedSupplementValue): boolean => (
  a.amount === b.amount && a.dateFrom === b.dateFrom && a.dateTo === b.dateTo
);

/**
 * Поправить (value) или снять (null) один действующий период плановой доплаты — любой, не только последний
 * (миграция 337). Дописыванием строк средний период не убрать, а точечный UPDATE/DELETE «оживил» бы старые
 * версии, поэтому расписание сотрудника переписывается: все его строки — в архив, действующие периоды
 * вставляются заново по дате начала (правленый — с новыми значениями, снятый — архивной строкой «снята»).
 * replaces_id связывает новую строку с заменённой — для истории. Последняя вставленная строка — последний по
 * дате период: окно сотрудника показывает его, как и до переписывания.
 *
 * 'stale' — периода уже нет среди действующих (его поправили в другом окне); 'exists' — новый период
 * пересекается с другим периодом сотрудника.
 */
export const rewritePlannedPeriod = async (input: {
  employeeId: number;
  periodId: number;
  value: IPlannedSupplementValue | null;
  createdBy: string;
}): Promise<PlannedPeriodRewriteResult> => withTransaction(async client => {
  await lockPayrollEmployee(client, input.employeeId);
  const periods = await readPeriods(client, input.employeeId);
  const target = periods.find(period => period.id === input.periodId);
  if (!target) return { status: 'stale' };
  const { value } = input;
  const others = periods.filter(period => period !== target);
  if (value !== null) {
    if (others.some(period => plannedOverlap(period, value))) return { status: 'exists' };
    if (sameValue(target, value)) return { status: 'unchanged' };
  }

  await client.query(
    'UPDATE payroll_planned_supplements SET archived_at = now() WHERE employee_id = $1 AND archived_at IS NULL',
    [input.employeeId],
  );
  if (value === null) {
    // Снятый период — в истории: строка «снята» сразу архивная, в периоды и «последнюю» строку не попадает.
    await client.query(
      `INSERT INTO payroll_planned_supplements (employee_id, amount, date_from, date_to, created_by, replaces_id, archived_at)
       VALUES ($1, NULL, NULL, NULL, $2, $3, now())`,
      [input.employeeId, input.createdBy, target.id],
    );
  }
  const next = (value === null ? others : [...others, { ...value, id: target.id }])
    .sort((a, b) => (a.dateFrom === b.dateFrom ? a.id - b.id : a.dateFrom.localeCompare(b.dateFrom)));
  for (const period of next) {
    await client.query(
      `INSERT INTO payroll_planned_supplements (employee_id, amount, date_from, date_to, created_by, replaces_id)
       VALUES ($1, $2::numeric, $3::date, $4::date, $5, $6)`,
      [input.employeeId, period.amount, period.dateFrom, period.dateTo, input.createdBy, period.id],
    );
  }
  return { status: 'saved', previous: { amount: target.amount, dateFrom: target.dateFrom, dateTo: target.dateTo } };
});

const ONE_TIME_SELECT = `
  SELECT o.id, o.employee_id, e.full_name, to_char(o.month, 'YYYY-MM') AS month, o.amount::text AS amount, o.reason
    FROM payroll_one_time_supplements o
    JOIN employees e ON e.id = o.employee_id`;

export const getOneTimeSupplement = async (id: number): Promise<IOneTimeSupplement | null> =>
  queryOne<IOneTimeSupplement>(`${ONE_TIME_SELECT} WHERE o.id = $1`, [id]);

const readOneTime = async (client: PoolClient, id: number, lock: boolean): Promise<IOneTimeSupplement | null> =>
  (await client.query<IOneTimeSupplement>(`${ONE_TIME_SELECT} WHERE o.id = $1${lock ? ' FOR UPDATE OF o' : ''}`, [id]))
    .rows[0] ?? null;

export const addOneTimeSupplement = async (
  employeeId: number,
  input: IOneTimeSupplementInput,
): Promise<IOneTimeSupplement> => {
  const row = await queryOne<{ id: number }>(
    `INSERT INTO payroll_one_time_supplements (employee_id, month, amount, reason)
     VALUES ($1, ($2 || '-01')::date, $3::numeric, $4) RETURNING id`,
    [employeeId, input.month, input.amount, input.reason],
  );
  const created = row ? await getOneTimeSupplement(row.id) : null;
  if (!created) throw new Error('Разовая доплата не найдена после добавления');
  return created;
};

/** Изменить месяц, сумму и основание; доплаты нет — null. Возвращает «было → стало» для аудита. */
export const updateOneTimeSupplement = async (
  id: number,
  input: IOneTimeSupplementInput,
): Promise<{ before: IOneTimeSupplement; after: IOneTimeSupplement } | null> =>
  withTransaction(async client => {
    const before = await readOneTime(client, id, true);
    if (!before) return null;
    await client.query(
      `UPDATE payroll_one_time_supplements
          SET month = ($2 || '-01')::date, amount = $3::numeric, reason = $4, updated_at = now()
        WHERE id = $1`,
      [id, input.month, input.amount, input.reason],
    );
    const after = await readOneTime(client, id, false);
    return after ? { before, after } : null;
  });

/** Удалить разовую доплату; её нет — null. */
export const deleteOneTimeSupplement = async (id: number): Promise<IOneTimeSupplement | null> =>
  withTransaction(async client => {
    const before = await readOneTime(client, id, true);
    if (!before) return null;
    await client.query(`DELETE FROM payroll_one_time_supplements WHERE id = $1`, [id]);
    return before;
  });
