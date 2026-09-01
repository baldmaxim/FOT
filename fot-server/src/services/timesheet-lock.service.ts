import { query } from '../config/postgres.js';
import type { DbExecutor } from '../config/postgres.js';
import type { QueryResultRow } from 'pg';
import type { IApprovalLockInfo } from './timesheet-department-assignments.service.js';
import {
  enumerateDatesInclusive,
  ownershipKey,
  ownsDay,
  resolveDayOwnership,
  type IOwnershipRequest,
} from './timesheet-day-ownership.service.js';

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
  department_id: string | null;
  start_date: string;
  end_date: string;
  status: IApprovalLockInfo['status'];
}

/**
 * Группирует строки-кандидаты в запросы владения: по подаче — её сотрудники и даты.
 * Одна карта на весь набор, чтобы резолвер сходил в БД ровно один раз.
 */
function buildOwnershipRequests(
  rows: readonly { id: number | string; department_id: string | null; employee_id: number | string; work_date: string }[],
): IOwnershipRequest[] {
  const byApproval = new Map<number, { departmentId: string | null; employees: Set<number>; dates: Set<string> }>();
  for (const row of rows) {
    const approvalId = Number(row.id);
    const employeeId = Number(row.employee_id);
    if (!Number.isFinite(approvalId) || !Number.isFinite(employeeId)) continue;
    const bucket = byApproval.get(approvalId)
      ?? { departmentId: row.department_id ?? null, employees: new Set<number>(), dates: new Set<string>() };
    bucket.employees.add(employeeId);
    bucket.dates.add(String(row.work_date).slice(0, 10));
    byApproval.set(approvalId, bucket);
  }
  return [...byApproval.entries()].map(([approvalId, bucket]) => ({
    approvalId,
    departmentId: bucket.departmentId,
    employeeIds: [...bucket.employees],
    dates: [...bucket.dates],
  }));
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
     SELECT pr.employee_id,
            pr.work_date::text AS work_date,
            a.id,
            a.department_id,
            a.start_date::text AS start_date,
            a.end_date::text AS end_date,
            a.status
       FROM pairs pr
       JOIN timesheet_approvals a
         ON a.status IN ('submitted', 'approved')
        AND a.unlocked_at IS NULL
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

  // Владение считаем ПОСЛЕ отбора кандидатов и ДО выбора приоритетной подачи:
  // иначе approved-подача, которая днём не владеет, вытеснила бы владеющую и день
  // остался бы закрытым. Строки уже отсортированы по приоритету (approved первым),
  // поэтому первая владеющая на пару и есть искомый замок.
  const ownership = await resolveDayOwnership(buildOwnershipRequests(rows), exec);

  for (const row of rows) {
    const employeeId = Number(row.employee_id);
    const key = lockKey(employeeId, row.work_date);
    if (locks.has(key)) continue;
    if (!ownsDay(ownership.get(ownershipKey(Number(row.id), employeeId, row.work_date)))) continue;
    locks.set(key, {
      id: Number(row.id),
      start_date: row.start_date,
      end_date: row.end_date,
      status: row.status,
    });
  }
  return locks;
}

/**
 * ВСЕ закрытые утверждённые подачи, покрывающие переданные (сотрудник, дата).
 *
 * Отличие от findApprovalLocksForEmployeeDates принципиальное: та возвращает ОДНУ
 * подачу на пару (DISTINCT ON с приоритетом approved) — этого хватает, чтобы отказать
 * в правке, но не хватает, чтобы пометить версии. Сотрудник может одновременно
 * входить и в подачу отдела, и в персональную подачу руководителя, и в пересекающиеся
 * закрытые периоды: правка его часов меняет содержимое ВСЕХ этих версий, а метку
 * получила бы только одна.
 *
 * Состав берём строго из timesheet_approval_employees — именно снимок определяет
 * содержимое версии. Ветка динамического состава отдела (chain) здесь не нужна:
 * подачи без снимка версии не имеют вовсе (VERSION_NOT_AVAILABLE), пересобирать нечего.
 *
 * Статус только 'approved': 'submitted' блокирует правку неадмину, но официальной
 * версии для 1С у него ещё нет.
 */
export async function listClosedApprovalIdsForPairs(
  pairs: readonly ITimesheetLockPair[],
  exec?: DbExecutor,
): Promise<number[]> {
  const normalized = normalizePairs(pairs);
  if (normalized.length === 0) return [];

  const rows = await queryWith<{ id: number | string }>(
    exec,
    `SELECT DISTINCT a.id
       FROM unnest($1::int[], $2::date[]) AS p(employee_id, work_date)
       JOIN timesheet_approval_employees s ON s.employee_id = p.employee_id
       JOIN timesheet_approvals a
         ON a.id = s.approval_id
        AND a.status = 'approved'
        AND a.unlocked_at IS NULL
        AND a.start_date <= p.work_date
        AND a.end_date   >= p.work_date`,
    [normalized.map(pair => pair.employeeId), normalized.map(pair => pair.workDate)],
  );

  return rows.map(row => Number(row.id)).filter(Number.isFinite);
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
  for (const key of buildTimesheetLockKeys(pairs)) {
    await client.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [key.employeeId, key.month]);
  }
}

/**
 * Ключи advisory-локов (сотрудник, месяц) — общая нормализация для транзакционного
 * и session-level вариантов. Порядок детерминированный, иначе встречные
 * многомесячные запросы получают взаимную блокировку.
 */
export function buildTimesheetLockKeys(
  pairs: readonly ITimesheetLockPair[],
): Array<{ employeeId: number; month: number }> {
  const keys = new Map<string, { employeeId: number; month: number }>();
  for (const pair of normalizePairs(pairs)) {
    const month = Number(pair.workDate.slice(0, 4)) * 100 + Number(pair.workDate.slice(5, 7));
    keys.set(`${pair.employeeId}|${month}`, { employeeId: pair.employeeId, month });
  }
  return [...keys.values()].sort((a, b) => (a.employeeId - b.employeeId) || (a.month - b.month));
}

/**
 * SESSION-level advisory-локи по (сотрудник, месяц).
 *
 * Зачем отдельно от lockTimesheetMonthsOnClient: материализация версии табеля читает
 * данные под REPEATABLE READ, а PostgreSQL фиксирует snapshot на ПЕРВОМ запросе
 * транзакции. Если бы первым запросом был pg_advisory_xact_lock, ожидающий чужую
 * корректировку, то после её коммита транзакция всё равно продолжила бы видеть
 * состояние ДО неё — и правка не попала бы в официальную версию. Поэтому локи
 * берутся ДО BEGIN, а значит обязаны быть session-level.
 *
 * Пространство ключей то же, что у транзакционного варианта, и session/xact локи
 * конфликтуют между собой — существующие пишущие пути табеля защищены без правок.
 *
 * ВАЖНО: снимать обязательно (см. unlockTimesheetMonthsSession) — session-лок живёт
 * до конца соединения, а не до конца транзакции.
 */
export async function lockTimesheetMonthsSession(
  client: DbExecutor,
  pairs: readonly ITimesheetLockPair[],
): Promise<Array<{ employeeId: number; month: number }>> {
  const sorted = buildTimesheetLockKeys(pairs);
  const acquired: Array<{ employeeId: number; month: number }> = [];
  for (const key of sorted) {
    await client.query('SELECT pg_advisory_lock($1::int, $2::int)', [key.employeeId, key.month]);
    acquired.push(key);
  }
  return acquired;
}

/**
 * Снимает session-level локи. Возвращает true, только если СНЯТЫ ВСЕ: вызывающий
 * обязан уничтожить соединение вместо возврата в пул, иначе лок утечёт следующему
 * потребителю этого соединения.
 */
export async function unlockTimesheetMonthsSession(
  client: DbExecutor,
  keys: ReadonlyArray<{ employeeId: number; month: number }>,
): Promise<boolean> {
  let allReleased = true;
  // Снимаем в обратном порядке — симметрично захвату.
  for (const key of [...keys].reverse()) {
    try {
      const res = await client.query<{ released: boolean }>(
        'SELECT pg_advisory_unlock($1::int, $2::int) AS released',
        [key.employeeId, key.month],
      );
      if (res.rows[0]?.released !== true) allReleased = false;
    } catch {
      allReleased = false;
    }
  }
  return allReleased;
}

export interface IEmployeeApprovalLock {
  employee_id: number;
  start_date: string;
  end_date: string;
  status: IApprovalLockInfo['status'];
}

/** Схлопывает подряд идущие даты обратно в интервалы [start, end]. */
function compressDates(dates: readonly string[]): Array<{ start: string; end: string }> {
  const sorted = [...dates].sort();
  const intervals: Array<{ start: string; end: string }> = [];
  for (const date of sorted) {
    const last = intervals[intervals.length - 1];
    if (last && enumerateDatesInclusive(last.end, date).length === 2) {
      last.end = date;
      continue;
    }
    intervals.push({ start: date, end: date });
  }
  return intervals;
}

/**
 * Замки за период по набору сотрудников — для подсветки в гриде. Интервальная
 * форма вместо плоского списка дат: в смешанной выборке (табельщица, прямые
 * подчинённые) плоский массив пере-блокировал бы чужих сотрудников.
 *
 * Владение считается по КАЖДОЙ дате тем же резолвером, что и write-guard, и
 * только потом соседние даты сжимаются обратно в интервалы: иначе грид оставался
 * бы закрытым там, где запись уже разрешена (перевод в середине периода).
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
    employee_id: number | string; id: number | string; department_id: string | null;
    start_date: string; end_date: string; status: IApprovalLockInfo['status'];
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
            a.id,
            a.department_id,
            GREATEST(a.start_date, $2::date)::text AS start_date,
            LEAST(a.end_date, $3::date)::text AS end_date,
            a.status
       FROM emps e
       JOIN timesheet_approvals a
         ON a.status IN ('submitted', 'approved')
        AND a.unlocked_at IS NULL
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

  const ownership = await resolveDayOwnership(
    buildOwnershipRequests(rows.flatMap(row => enumerateDatesInclusive(row.start_date, row.end_date).map(date => ({
      id: row.id,
      department_id: row.department_id,
      employee_id: row.employee_id,
      work_date: date,
    })))),
    exec,
  );

  const locks: IEmployeeApprovalLock[] = [];
  for (const row of rows) {
    const employeeId = Number(row.employee_id);
    const approvalId = Number(row.id);
    const ownedDates = enumerateDatesInclusive(row.start_date, row.end_date)
      .filter(date => ownsDay(ownership.get(ownershipKey(approvalId, employeeId, date))));
    for (const interval of compressDates(ownedDates)) {
      locks.push({
        employee_id: employeeId,
        start_date: interval.start,
        end_date: interval.end,
        status: row.status,
      });
    }
  }
  return locks;
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
        AND a.unlocked_at IS NULL
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
