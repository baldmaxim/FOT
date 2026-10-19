/**
 * «Доплата» — таблица окна «Справочник» на «Расчётах» (миграция 315): плановые и разовые доплаты.
 *
 * Плановая — прежний журнал payroll_planned_supplements (миграция 293), тот же, что в окне сотрудника:
 * текущая — ПОСЛЕДНЯЯ строка журнала по id; если у неё amount NULL, доплата снята. Пишется только
 * через setPlannedSupplement под блокировкой сотрудника — как из окна сотрудника.
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
  /** id разовой доплаты; у плановой — null (она одна на сотрудника). */
  id: number | null;
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

/** Плановые (текущие, не снятые) и разовые доплаты «штата зарплаты». */
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
       SELECT 'planned'::text AS kind, NULL::int AS id, s.id AS employee_id, s.full_name, s.department, s.position,
              ps.amount::text AS amount,
              to_char(ps.date_from, 'YYYY-MM-DD') AS date_from,
              to_char(ps.date_to, 'YYYY-MM-DD') AS date_to,
              NULL::text AS month, NULL::text AS reason
         FROM staff s
         -- Сначала последняя версия журнала, потом отсев снятых: снятая не «оживает» прежней.
         JOIN LATERAL (
           SELECT x.amount, x.date_from, x.date_to
             FROM payroll_planned_supplements x
            WHERE x.employee_id = s.id
            ORDER BY x.id DESC
            LIMIT 1
         ) ps ON ps.amount IS NOT NULL
       UNION ALL
       SELECT 'one_time'::text, o.id, s.id, s.full_name, s.department, s.position,
              o.amount::text, NULL, NULL, to_char(o.month, 'YYYY-MM'), o.reason
         FROM staff s
         JOIN payroll_one_time_supplements o ON o.employee_id = s.id
     ) rows
     ORDER BY full_name, employee_id, kind DESC, month DESC NULLS FIRST, id`,
    [scope.contractorRootId, scope.departmentIds],
  );
};

/** Текущая плановая доплата сотрудника (последняя версия журнала; снята — null). */
const readPlanned = async (client: PoolClient, employeeId: number): Promise<IPlannedSupplementValue | null> => {
  const row = (await client.query<{ amount: string | null; date_from: string | null; date_to: string | null }>(
    `SELECT amount::text AS amount,
            to_char(date_from, 'YYYY-MM-DD') AS date_from,
            to_char(date_to, 'YYYY-MM-DD') AS date_to
       FROM payroll_planned_supplements
      WHERE employee_id = $1
      ORDER BY id DESC
      LIMIT 1`,
    [employeeId],
  )).rows[0];
  if (!row || row.amount === null || row.date_from === null || row.date_to === null) return null;
  return { amount: Number(row.amount), dateFrom: row.date_from, dateTo: row.date_to };
};

export type PlannedSetResult =
  | { status: 'exists' }
  | { status: 'unchanged' }
  | { status: 'saved'; previous: IPlannedSupplementValue | null };

/**
 * Записать плановую доплату (null — снять). onlyIfNone — добавление из таблицы: текущая есть — 'exists'
 * (не затираем молча чужую). Новая версия журнала — только при отличии (setPlannedSupplement).
 */
export const savePlannedSupplement = async (input: {
  employeeId: number;
  value: IPlannedSupplementValue | null;
  createdBy: string;
  onlyIfNone?: boolean;
}): Promise<PlannedSetResult> => withTransaction(async client => {
  await lockPayrollEmployee(client, input.employeeId);
  const previous = await readPlanned(client, input.employeeId);
  if (input.onlyIfNone && previous) return { status: 'exists' };
  const changed = await setPlannedSupplement(client, {
    employeeId: input.employeeId,
    value: input.value,
    createdBy: input.createdBy,
  });
  return changed ? { status: 'saved', previous } : { status: 'unchanged' };
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
