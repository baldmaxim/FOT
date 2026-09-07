import type { QueryResultRow } from 'pg';
import { query, type DbExecutor } from '../config/postgres.js';
import { listEffectiveDepartmentManagers } from './department-managers.service.js';

/**
 * «Покрытие отделом»: у сотрудника на конкретную дату есть действующий руководитель
 * отдела, а значит табель за этот день ведёт и подаёт он, а не личный руководитель
 * (employee_direct_reports).
 *
 * Почему по дням, а не «покрыт на весь период». Подача отдела забирает у сотрудника
 * только те даты, на которые он числился в её отделе (см. resolveDayOwnership и
 * buildTimesheetPayload). Если считать покрытие булевым на весь период, переведённый
 * внутри полупериода сотрудник потерял бы дни: личный руководитель исключил бы его
 * целиком, а отдел забрал бы лишь часть дат. Инвариант, который держим: каждая пара
 * (employee_id, work_date) принадлежит ровно одной подаче.
 *
 * Источник отделов — те же, что у состава подачи отдела:
 *  - интервалы employee_assignments, пересекающие диапазон;
 *  - snapshot employees.org_department_id — для дат, не покрытых ни одним интервалом
 *    (у ~70% активных истории назначений нет вовсе, и отдел известен только так);
 *  - папка «Уволенные» доказательством не является: freeze-режим переписывает
 *    открытую строку назначения, и весь прошлый период уволенного «числится» в
 *    архиве. Такие назначения отбрасываем — дата уходит в snapshot-фолбэк.
 *
 * Наследование от родительских отделов НЕ выполняется — как в listDepartmentManagers.
 */

/** Защита от циклов в org_departments.parent_id — та же глубина, что в day-ownership. */
const MAX_DEPARTMENT_DEPTH = 32;

export interface ICoverageInterval {
  effectiveFrom: string;
  /** null — открытое назначение. */
  effectiveTo: string | null;
  covered: boolean;
}

export interface IEmployeeCoverage {
  intervals: ICoverageInterval[];
  /** Покрытие по snapshot-отделу — ответ для дат вне всех интервалов. */
  snapshotCovered: boolean;
}

export type TCoverageMap = Map<number, IEmployeeCoverage>;

const isIsoDate = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

/** SELECT через клиент транзакции, если он передан, иначе через пул. */
async function queryWith<T extends QueryResultRow = QueryResultRow>(
  exec: DbExecutor | undefined, sql: string, params?: readonly unknown[],
): Promise<T[]> {
  if (exec) return (await exec.query<T>(sql, params as unknown[] | undefined)).rows;
  return query<T>(sql, params);
}

/**
 * Чистое правило: покрыт ли сотрудник на дату.
 *
 * Несколько интервалов могут накрывать одну дату (пересекающиеся назначения) —
 * достаточно одного покрытого: сотрудник числился в отделе с руководителем.
 * Дата вне всех интервалов — ответ по snapshot: ровно так же её трактует подача
 * отдела (см. snapshot-ветку listEmployeeMembershipsForDepartmentPeriod).
 */
export function isCoveredOn(coverage: IEmployeeCoverage | undefined, date: string): boolean {
  if (!coverage) return false;
  let matched = false;
  for (const interval of coverage.intervals) {
    if (interval.effectiveFrom > date) continue;
    if (interval.effectiveTo != null && interval.effectiveTo < date) continue;
    matched = true;
    if (interval.covered) return true;
  }
  return matched ? false : coverage.snapshotCovered;
}

interface IAssignmentRow extends QueryResultRow {
  employee_id: number | string;
  dept_id: string;
  effective_from: string;
  effective_to: string | null;
}

interface ISnapshotRow extends QueryResultRow {
  id: number | string;
  org_department_id: string | null;
}

/**
 * Интервалы покрытия сотрудников на [minDate, maxDate].
 *
 * Три запроса на весь набор (назначения, snapshot, руководители отделов), а не серия
 * на каждого сотрудника: функция вызывается в том числе из-под advisory-локов.
 */
export async function loadCoverage(
  employeeIds: readonly number[],
  minDate: string,
  maxDate: string,
  exec?: DbExecutor,
): Promise<TCoverageMap> {
  const result: TCoverageMap = new Map();
  const ids = [...new Set(employeeIds.map(Number).filter(id => Number.isInteger(id) && id > 0))];
  if (ids.length === 0 || !isIsoDate(minDate) || !isIsoDate(maxDate)) return result;

  const assignments = await queryWith<IAssignmentRow>(
    exec,
    `WITH RECURSIVE archive_root AS (
       SELECT NULLIF(s.value, '')::uuid AS dept_id
         FROM system_settings s
        WHERE s.key = 'employees_archive_department_id'
          AND s.value ~ '^[0-9a-fA-F-]{8}-[0-9a-fA-F-]{4}-[0-9a-fA-F-]{4}-[0-9a-fA-F-]{4}-[0-9a-fA-F]{12}$'
        LIMIT 1
     ),
     archive_tree AS (
       SELECT ar.dept_id AS id, 1 AS depth FROM archive_root ar WHERE ar.dept_id IS NOT NULL
       UNION ALL
       SELECT d.id, t.depth + 1
         FROM archive_tree t
         JOIN org_departments d ON d.parent_id = t.id
        WHERE t.depth < ${MAX_DEPARTMENT_DEPTH}
     )
     SELECT ea.employee_id,
            ea.org_department_id::text AS dept_id,
            ea.effective_from::text    AS effective_from,
            ea.effective_to::text      AS effective_to
       FROM employee_assignments ea
      WHERE ea.employee_id = ANY($1::int[])
        AND ea.org_department_id IS NOT NULL
        AND ea.effective_from <= $3::date
        AND (ea.effective_to IS NULL OR ea.effective_to >= $2::date)
        AND NOT EXISTS (SELECT 1 FROM archive_tree t WHERE t.id = ea.org_department_id)
      ORDER BY ea.employee_id, ea.effective_from`,
    [ids, minDate, maxDate],
  );

  const snapshots = await queryWith<ISnapshotRow>(
    exec,
    `SELECT id, org_department_id::text AS org_department_id
       FROM employees
      WHERE id = ANY($1::int[])`,
    [ids],
  );

  const departmentIds = new Set<string>();
  for (const row of assignments) departmentIds.add(String(row.dept_id));
  for (const row of snapshots) {
    if (row.org_department_id) departmentIds.add(String(row.org_department_id));
  }

  const managers = await listEffectiveDepartmentManagers([...departmentIds], exec);
  const isManaged = (departmentId: string | null): boolean =>
    departmentId != null && (managers.get(departmentId)?.length ?? 0) > 0;

  const ensure = (employeeId: number): IEmployeeCoverage => {
    const existing = result.get(employeeId);
    if (existing) return existing;
    const created: IEmployeeCoverage = { intervals: [], snapshotCovered: false };
    result.set(employeeId, created);
    return created;
  };

  for (const row of snapshots) {
    const employeeId = Number(row.id);
    if (!Number.isFinite(employeeId)) continue;
    ensure(employeeId).snapshotCovered = isManaged(row.org_department_id);
  }

  for (const row of assignments) {
    const employeeId = Number(row.employee_id);
    if (!Number.isFinite(employeeId)) continue;
    ensure(employeeId).intervals.push({
      effectiveFrom: String(row.effective_from).slice(0, 10),
      effectiveTo: row.effective_to == null ? null : String(row.effective_to).slice(0, 10),
      covered: isManaged(String(row.dept_id)),
    });
  }

  return result;
}

/** Перечисляет ISO-даты интервала включительно. */
function enumerateDates(startDate: string, endDate: string): string[] {
  if (!isIsoDate(startDate) || !isIsoDate(endDate)) return [];
  const dates: string[] = [];
  const cursor = new Date(`${startDate}T00:00:00Z`);
  const stop = new Date(`${endDate}T00:00:00Z`);
  while (cursor <= stop) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

export interface ICoverageSplit {
  /** Ни одного покрытого дня в периоде — личный руководитель ведёт как раньше. */
  owned: number[];
  /** Покрыт все дни периода — read-only секция и вон из персональной подачи. */
  fullyCovered: number[];
  /** Часть дней покрыта (перевод внутри периода) — остаётся, но покрытые дни не его. */
  partiallyCovered: number[];
  /** employee_id → покрытые даты (только для fullyCovered и partiallyCovered). */
  coveredDates: Map<number, string[]>;
}

/**
 * Единственная точка входа для вызывающих: делит прямых подчинённых на тех, кого
 * личный руководитель ведёт сам, и тех, за кого отвечает руководитель отдела.
 */
export async function splitDirectReportsByCoverage(
  employeeIds: readonly number[],
  startDate: string,
  endDate: string,
  exec?: DbExecutor,
): Promise<ICoverageSplit> {
  const split: ICoverageSplit = {
    owned: [], fullyCovered: [], partiallyCovered: [], coveredDates: new Map(),
  };
  const ids = [...new Set(employeeIds.map(Number).filter(id => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return split;

  const dates = enumerateDates(startDate, endDate);
  if (dates.length === 0) {
    split.owned = ids;
    return split;
  }

  const coverage = await loadCoverage(ids, startDate, endDate, exec);

  for (const employeeId of ids) {
    const own = coverage.get(employeeId);
    const covered = dates.filter(date => isCoveredOn(own, date));
    if (covered.length === 0) {
      split.owned.push(employeeId);
      continue;
    }
    split.coveredDates.set(employeeId, covered);
    if (covered.length === dates.length) split.fullyCovered.push(employeeId);
    else split.partiallyCovered.push(employeeId);
  }
  return split;
}
