import { query } from '../config/postgres.js';
import type { DbExecutor } from '../config/postgres.js';
import type { QueryResultRow } from 'pg';
import type { IApprovalLockInfo } from './timesheet-department-assignments.service.js';

/**
 * Единый замок закрытого табеля: «этому сотруднику на эту дату период закрыт».
 *
 * Ключевое отличие от findApprovalLockForDate — замок НЕ зависит от того, как
 * правящий добрался до сотрудника (managed-отдел, прямые подчинённые, бригада
 * табельщицы). Раньше проверка шла по отделам правящего, и любой путь доступа
 * мимо managed-отделов открывал закрытый период.
 *
 * Сотрудник считается входящим в подачу, если:
 *  - он есть в снимке состава timesheet_approval_employees (основной источник —
 *    членство снимочное, переживает переводы после submit), ЛИБО
 *  - department_id подачи совпадает с отделом сотрудника на дату или с любым его
 *    предком (нужно для легаси-подач без снимка и для тех, кого добавили в отдел
 *    уже после submit).
 */

/** SELECT через клиент транзакции, если он передан, иначе через пул (см. DbExecutor). */
async function queryWith<T extends QueryResultRow = QueryResultRow>(
  exec: DbExecutor | undefined, sql: string, params?: readonly unknown[],
): Promise<T[]> {
  if (exec) return (await exec.query<T>(sql, params as unknown[] | undefined)).rows;
  return query<T>(sql, params);
}

export interface ITimesheetLockPair {
  employeeId: number;
  workDate: string;
}

/** Ключ карты замков: `${employeeId}|${workDate}`. */
export const lockKey = (employeeId: number, workDate: string): string => `${employeeId}|${workDate}`;

/** Защита от циклов в org_departments.parent_id: глубина обхода вверх. */
const MAX_DEPARTMENT_DEPTH = 32;

const normalizePairs = (pairs: readonly ITimesheetLockPair[]): ITimesheetLockPair[] => {
  const seen = new Set<string>();
  const result: ITimesheetLockPair[] = [];
  for (const pair of pairs) {
    const employeeId = Number(pair.employeeId);
    const workDate = String(pair.workDate || '').slice(0, 10);
    if (!Number.isInteger(employeeId) || employeeId <= 0) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) continue;
    const key = lockKey(employeeId, workDate);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ employeeId, workDate });
  }
  return result;
};

interface ILockRow extends QueryResultRow {
  employee_id: number | string;
  work_date: string;
  id: number | string;
  start_date: string;
  end_date: string;
  status: IApprovalLockInfo['status'];
}

/**
 * Батч-проверка замка. Один SQL на весь набор пар — вызывается в том числе из
 * bulk-путей, где раньше был Promise.all с запросом на каждый элемент.
 */
export async function findApprovalLocksForEmployeeDates(
  pairs: readonly ITimesheetLockPair[],
  exec?: DbExecutor,
): Promise<Map<string, IApprovalLockInfo>> {
  const locks = new Map<string, IApprovalLockInfo>();
  const normalized = normalizePairs(pairs);
  if (normalized.length === 0) return locks;

  const rows = await queryWith<ILockRow>(
    exec,
    `WITH RECURSIVE pairs AS (
       SELECT p.employee_id::int AS employee_id, p.work_date::date AS work_date
         FROM unnest($1::int[], $2::date[]) AS p(employee_id, work_date)
     ),
     base AS (
       SELECT pr.employee_id, pr.work_date,
              COALESCE(
                (SELECT a.org_department_id
                   FROM employee_assignments a
                  WHERE a.employee_id = pr.employee_id
                    AND a.org_department_id IS NOT NULL
                    AND a.effective_from <= pr.work_date
                    AND (a.effective_to IS NULL OR a.effective_to >= pr.work_date)
                  ORDER BY a.effective_from DESC
                  LIMIT 1),
                (SELECT e.org_department_id FROM employees e WHERE e.id = pr.employee_id),
                (SELECT de.from_department_id
                   FROM employee_dismissal_events de
                  WHERE de.employee_id = pr.employee_id
                    AND de.cancelled = false
                    AND de.dismissal_date IS NOT NULL
                    AND de.dismissal_date >= pr.work_date
                  ORDER BY de.dismissal_date ASC
                  LIMIT 1)
              ) AS dept_id
         FROM pairs pr
     ),
     chain AS (
       SELECT b.employee_id, b.work_date, d.id AS dept_id, d.parent_id, 1 AS depth
         FROM base b
         JOIN org_departments d ON d.id = b.dept_id
       UNION
       SELECT c.employee_id, c.work_date, d.id, d.parent_id, c.depth + 1
         FROM chain c
         JOIN org_departments d ON d.id = c.parent_id
        WHERE c.depth < ${MAX_DEPARTMENT_DEPTH}
     )
     SELECT DISTINCT ON (pr.employee_id, pr.work_date)
            pr.employee_id,
            pr.work_date::text AS work_date,
            a.id,
            a.start_date::text AS start_date,
            a.end_date::text AS end_date,
            a.status
       FROM pairs pr
       JOIN timesheet_approvals a
         ON a.status IN ('submitted', 'approved')
        AND a.start_date <= pr.work_date
        AND a.end_date >= pr.work_date
      WHERE EXISTS (
              SELECT 1 FROM timesheet_approval_employees s
               WHERE s.approval_id = a.id AND s.employee_id = pr.employee_id
            )
         OR EXISTS (
              SELECT 1 FROM chain c
               WHERE c.employee_id = pr.employee_id
                 AND c.work_date = pr.work_date
                 AND c.dept_id = a.department_id
            )
      ORDER BY pr.employee_id, pr.work_date,
               (a.status = 'approved') DESC, a.start_date DESC, a.id DESC`,
    [normalized.map(p => p.employeeId), normalized.map(p => p.workDate)],
  );

  for (const row of rows) {
    locks.set(lockKey(Number(row.employee_id), row.work_date), {
      id: Number(row.id),
      start_date: row.start_date,
      end_date: row.end_date,
      status: row.status,
    });
  }
  return locks;
}

/** Точечная проверка замка (обёртка над батчем). */
export async function findApprovalLockForEmployeeDate(
  employeeId: number,
  workDate: string,
  exec?: DbExecutor,
): Promise<IApprovalLockInfo | null> {
  const locks = await findApprovalLocksForEmployeeDates([{ employeeId, workDate }], exec);
  return locks.get(lockKey(employeeId, workDate)) ?? null;
}

/**
 * Транзакционные advisory-локи по (сотрудник, месяц) на УЖЕ ОТКРЫТОМ клиенте.
 * Без них pre-check не защищает: между проверкой и записью параллельный запрос
 * успевает перевести период в submitted. Пространство ключей общее с квотой
 * субботних выходов (lockQuotaMonthsOnClient) — лишняя сериализация безвредна.
 *
 * Порядок захвата детерминированный (сотрудник, затем месяц) — исключает
 * взаимную блокировку встречных многомесячных запросов.
 */
export async function lockTimesheetMonthsOnClient(
  client: DbExecutor,
  pairs: readonly ITimesheetLockPair[],
): Promise<void> {
  const keys = new Map<string, { employeeId: number; month: number }>();
  for (const pair of normalizePairs(pairs)) {
    const month = Number(pair.workDate.slice(0, 4)) * 100 + Number(pair.workDate.slice(5, 7));
    keys.set(`${pair.employeeId}|${month}`, { employeeId: pair.employeeId, month });
  }
  const sorted = [...keys.values()].sort(
    (a, b) => (a.employeeId - b.employeeId) || (a.month - b.month),
  );
  for (const key of sorted) {
    await client.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [key.employeeId, key.month]);
  }
}

export interface IEmployeeApprovalLock {
  employee_id: number;
  start_date: string;
  end_date: string;
  status: IApprovalLockInfo['status'];
}

/**
 * Замки за период по набору сотрудников — для подсветки в гриде. Интервальная
 * форма вместо плоского списка дат: в смешанной выборке (табельщица, прямые
 * подчинённые) плоский массив пере-блокировал бы чужих сотрудников.
 *
 * Отдел сотрудника здесь резолвится на период целиком, а не на каждую дату:
 * это подсказка для UI, точное решение принимает per-date гард на записи.
 */
export async function loadApprovalLocksForEmployeesInPeriod(
  employeeIds: readonly number[],
  startDate: string,
  endDate: string,
  exec?: DbExecutor,
): Promise<IEmployeeApprovalLock[]> {
  const ids = [...new Set(employeeIds.map(Number).filter(id => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return [];

  const rows = await queryWith<{
    employee_id: number | string; start_date: string; end_date: string; status: IApprovalLockInfo['status'];
  }>(
    exec,
    `WITH RECURSIVE emps AS (
       SELECT unnest($1::int[]) AS employee_id
     ),
     base AS (
       SELECT e.employee_id,
              COALESCE(
                (SELECT a.org_department_id
                   FROM employee_assignments a
                  WHERE a.employee_id = e.employee_id
                    AND a.org_department_id IS NOT NULL
                    AND a.effective_from <= $3::date
                    AND (a.effective_to IS NULL OR a.effective_to >= $2::date)
                  ORDER BY a.effective_from DESC
                  LIMIT 1),
                (SELECT emp.org_department_id FROM employees emp WHERE emp.id = e.employee_id),
                (SELECT de.from_department_id
                   FROM employee_dismissal_events de
                  WHERE de.employee_id = e.employee_id
                    AND de.cancelled = false
                    AND de.dismissal_date IS NOT NULL
                    AND de.dismissal_date >= $2::date
                  ORDER BY de.dismissal_date ASC
                  LIMIT 1)
              ) AS dept_id
         FROM emps e
     ),
     chain AS (
       SELECT b.employee_id, d.id AS dept_id, d.parent_id, 1 AS depth
         FROM base b
         JOIN org_departments d ON d.id = b.dept_id
       UNION
       SELECT c.employee_id, d.id, d.parent_id, c.depth + 1
         FROM chain c
         JOIN org_departments d ON d.id = c.parent_id
        WHERE c.depth < ${MAX_DEPARTMENT_DEPTH}
     )
     SELECT e.employee_id,
            GREATEST(a.start_date, $2::date)::text AS start_date,
            LEAST(a.end_date, $3::date)::text AS end_date,
            a.status
       FROM emps e
       JOIN timesheet_approvals a
         ON a.status IN ('submitted', 'approved')
        AND a.start_date <= $3::date
        AND a.end_date >= $2::date
      WHERE EXISTS (
              SELECT 1 FROM timesheet_approval_employees s
               WHERE s.approval_id = a.id AND s.employee_id = e.employee_id
            )
         OR EXISTS (
              SELECT 1 FROM chain c
               WHERE c.employee_id = e.employee_id AND c.dept_id = a.department_id
            )
      ORDER BY e.employee_id, a.start_date`,
    [ids, startDate, endDate],
  );

  return rows.map(row => ({
    employee_id: Number(row.employee_id),
    start_date: row.start_date,
    end_date: row.end_date,
    status: row.status,
  }));
}

/** Разворачивает интервалы замков в плоский список ISO-дат (легаси-поле approval_locked_dates). */
export function flattenApprovalLockDates(locks: readonly IEmployeeApprovalLock[]): string[] {
  const dates = new Set<string>();
  for (const lock of locks) {
    const cursor = new Date(`${lock.start_date}T00:00:00Z`);
    const stop = new Date(`${lock.end_date}T00:00:00Z`);
    while (cursor <= stop) {
      dates.add(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }
  return [...dates].sort();
}

/**
 * Замок для изменения СОСТАВА отдела задним числом (перевод/исключение в табеле).
 *
 * Проверять по одной дате нельзя: правка меняет членство на всём интервале от даты
 * и дальше. И по одному отделу нельзя: при переводе закрытым может быть табель как
 * исходного отдела, так и целевого — а per-date гард до записи видит только старый.
 */
export async function findApprovalLockForMembershipChange(
  params: {
    employeeId: number;
    departmentIds: ReadonlyArray<string | null | undefined>;
    fromDate: string;
    toDate?: string | null;
  },
  exec?: DbExecutor,
): Promise<IApprovalLockInfo | null> {
  const employeeId = Number(params.employeeId);
  if (!Number.isInteger(employeeId) || employeeId <= 0) return null;
  const departmentIds = [...new Set(params.departmentIds.filter((id): id is string => Boolean(id)))];

  const rows = await queryWith<{
    id: number | string; start_date: string; end_date: string; status: IApprovalLockInfo['status'];
  }>(
    exec,
    `WITH RECURSIVE roots AS (
       SELECT unnest($2::uuid[]) AS dept_id
     ),
     chain AS (
       SELECT d.id AS dept_id, d.parent_id, 1 AS depth
         FROM roots r
         JOIN org_departments d ON d.id = r.dept_id
       UNION
       SELECT d.id, d.parent_id, c.depth + 1
         FROM chain c
         JOIN org_departments d ON d.id = c.parent_id
        WHERE c.depth < ${MAX_DEPARTMENT_DEPTH}
     )
     SELECT a.id, a.start_date::text AS start_date, a.end_date::text AS end_date, a.status
       FROM timesheet_approvals a
      WHERE a.status IN ('submitted', 'approved')
        AND a.end_date >= $3::date
        AND ($4::date IS NULL OR a.start_date <= $4::date)
        AND (
          EXISTS (
            SELECT 1 FROM timesheet_approval_employees s
             WHERE s.approval_id = a.id AND s.employee_id = $1
          )
          OR a.department_id IN (SELECT dept_id FROM chain)
        )
      ORDER BY (a.status = 'approved') DESC, a.start_date DESC, a.id DESC
      LIMIT 1`,
    [employeeId, departmentIds, params.fromDate, params.toDate ?? null],
  );

  const row = rows[0];
  return row
    ? { id: Number(row.id), start_date: row.start_date, end_date: row.end_date, status: row.status }
    : null;
}
