import { query } from '../config/postgres.js';
import type { DbExecutor } from '../config/postgres.js';
import type { QueryResultRow } from 'pg';

/**
 * Владение днём: «этот день сотрудника принадлежит этой подаче табеля».
 *
 * Зачем отдельное понятие. Раньше принадлежность считалась «сотрудник целиком ∈
 * подача» (снимок timesheet_approval_employees), из-за чего перевод в середине
 * периода отдавал старой подаче и дни, отработанные уже в новой бригаде: замок
 * закрывал их для правки, а сборщик версии клал их в выгрузку для 1С — одна пара
 * (сотрудник, дата) попадала сразу в две версии.
 *
 * Три состояния вместо булева ответа — принципиально:
 *  - owned     — на эту дату есть назначение в отдел подачи или его потомок;
 *  - not_owned — на эту дату есть назначение, и оно ведёт в другой отдел
 *                (достоверная история доказывает отсутствие в отделе подачи);
 *  - unknown   — назначений, покрывающих дату, нет вообще.
 *
 * unknown НЕ означает «не владеет»: у ~70% активных сотрудников истории
 * назначений нет и отдел известен только по снапшоту employees.org_department_id,
 * а freeze-режим переписывает открытую запись, оставляя ранние даты непокрытыми.
 * Поэтому потребители трактуют unknown как владение по снимку — иначе замок
 * снялся бы с закрытых периодов у большинства людей.
 *
 * Персональные подачи руководителей (department_id IS NULL) отдела не имеют:
 * для них всегда unknown, то есть владение остаётся строго снимочным.
 */

export type TDayOwnership = 'owned' | 'not_owned' | 'unknown';

/** Защита от циклов в org_departments.parent_id — та же глубина, что в замке. */
const MAX_DEPARTMENT_DEPTH = 32;

export interface IOwnershipRequest {
  approvalId: number;
  /** null — персональная подача: отдела нет, владение снимочное. */
  departmentId: string | null;
  employeeIds: readonly number[];
  dates: readonly string[];
}

/** Интервал назначения сотрудника + подачи, чей отдел покрывает отдел назначения. */
export interface IOwnershipInterval {
  effectiveFrom: string;
  /** null — открытое назначение. */
  effectiveTo: string | null;
  owningApprovalIds: readonly number[];
}

export type TOwnershipIntervals = Map<number, IOwnershipInterval[]>;

/** Ключ карты владения. */
export const ownershipKey = (approvalId: number, employeeId: number, date: string): string =>
  `${approvalId}|${employeeId}|${date}`;

const isIsoDate = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

/** Перечисляет ISO-даты интервала включительно. */
export function enumerateDatesInclusive(startDate: string, endDate: string): string[] {
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

interface IIntervalRow extends QueryResultRow {
  employee_id: number | string;
  effective_from: string;
  effective_to: string | null;
  owning_approval_ids: (number | string)[] | null;
}

/** SELECT через клиент транзакции, если он передан, иначе через пул. */
async function queryWith<T extends QueryResultRow = QueryResultRow>(
  exec: DbExecutor | undefined, sql: string, params?: readonly unknown[],
): Promise<T[]> {
  if (exec) return (await exec.query<T>(sql, params as unknown[] | undefined)).rows;
  return query<T>(sql, params);
}

/**
 * Чистое правило: состояние владения по уже загруженным интервалам.
 *
 * Интервалы НЕ схлопываются в одно окно joined→transferred_out: уход и возврат
 * в ту же бригаду внутри периода дают два отдельных интервала владения, а
 * промежуток между ними достоверно принадлежит другому отделу.
 */
export function classifyOwnership(
  intervals: readonly IOwnershipInterval[] | undefined,
  approvalId: number,
  date: string,
): TDayOwnership {
  if (!intervals || intervals.length === 0) return 'unknown';

  let covered = false;
  for (const interval of intervals) {
    if (interval.effectiveFrom > date) continue;
    if (interval.effectiveTo != null && interval.effectiveTo < date) continue;
    covered = true;
    if (interval.owningApprovalIds.includes(approvalId)) return 'owned';
  }
  return covered ? 'not_owned' : 'unknown';
}

/**
 * Интервалы назначений всех сотрудников, пересекающие [minDate, maxDate], с
 * отметкой, какие из переданных подач накрывают их отделом (сам отдел подачи или
 * любой его потомок — сравнение идёт подъёмом по parent_id от отдела назначения).
 *
 * Один SQL на весь набор: вызывается в том числе из-под advisory-локов, где серия
 * запросов на каждую подачу удерживала бы локи заметно дольше.
 */
export async function loadOwnershipIntervals(
  employeeIds: readonly number[],
  minDate: string,
  maxDate: string,
  approvals: readonly { approvalId: number; departmentId: string | null }[],
  exec: DbExecutor | undefined,
): Promise<TOwnershipIntervals> {
  const result: TOwnershipIntervals = new Map();

  const ids = [...new Set(employeeIds.map(Number).filter(id => Number.isInteger(id) && id > 0))];
  const deptApprovals = approvals.filter(a => typeof a.departmentId === 'string' && a.departmentId);
  if (ids.length === 0 || !isIsoDate(minDate) || !isIsoDate(maxDate)) return result;

  const rows = await queryWith<IIntervalRow>(
    exec,
    `WITH RECURSIVE archive AS (
       -- Папка «Уволенные» доказательством отсутствия в отделе НЕ является:
       -- при увольнении freeze-режим переписывает открытую строку назначения,
       -- сохраняя старую effective_from, поэтому весь предыдущий период у
       -- уволенного «числится» в архиве. Считать такие дни чужими нельзя —
       -- иначе реально отработанные часы вырезаются из версии для 1С.
       SELECT NULLIF(s.value, '')::uuid AS dept_id
         FROM system_settings s
        WHERE s.key = 'employees_archive_department_id'
          AND s.value ~ '^[0-9a-fA-F-]{8}-[0-9a-fA-F-]{4}-[0-9a-fA-F-]{4}-[0-9a-fA-F-]{4}-[0-9a-fA-F]{12}$'
        LIMIT 1
     ),
     asg AS (
       SELECT ea.id, ea.employee_id, ea.org_department_id,
              ea.effective_from, ea.effective_to
         FROM employee_assignments ea
        WHERE ea.employee_id = ANY($1::int[])
          AND ea.org_department_id IS NOT NULL
          AND ea.effective_from <= $3::date
          AND (ea.effective_to IS NULL OR ea.effective_to >= $2::date)
     ),
     chain AS (
       SELECT a.id AS assignment_id, d.id AS dept_id, d.parent_id, 1 AS depth
         FROM asg a
         JOIN org_departments d ON d.id = a.org_department_id
       UNION
       SELECT c.assignment_id, d.id, d.parent_id, c.depth + 1
         FROM chain c
         JOIN org_departments d ON d.id = c.parent_id
        WHERE c.depth < ${MAX_DEPARTMENT_DEPTH}
     ),
     req AS (
       SELECT r.approval_id, r.department_id
         FROM unnest($4::bigint[], $5::uuid[]) AS r(approval_id, department_id)
     )
     SELECT a.employee_id,
            a.effective_from::text AS effective_from,
            a.effective_to::text   AS effective_to,
            COALESCE((
              SELECT array_agg(DISTINCT r.approval_id)
                FROM req r
                JOIN chain c ON c.assignment_id = a.id AND c.dept_id = r.department_id
            ), ARRAY[]::bigint[]) AS owning_approval_ids
       FROM asg a
      WHERE NOT EXISTS (
              SELECT 1 FROM chain c
                JOIN archive ar ON ar.dept_id = c.dept_id
               WHERE c.assignment_id = a.id
            )
      ORDER BY a.employee_id, a.effective_from`,
    [
      ids,
      minDate,
      maxDate,
      deptApprovals.map(a => a.approvalId),
      deptApprovals.map(a => a.departmentId),
    ],
  );

  for (const row of rows) {
    const employeeId = Number(row.employee_id);
    if (!Number.isFinite(employeeId)) continue;
    const bucket = result.get(employeeId) ?? [];
    bucket.push({
      effectiveFrom: String(row.effective_from).slice(0, 10),
      effectiveTo: row.effective_to == null ? null : String(row.effective_to).slice(0, 10),
      owningApprovalIds: (row.owning_approval_ids ?? []).map(Number).filter(Number.isFinite),
    });
    result.set(employeeId, bucket);
  }

  return result;
}

/**
 * Владение по набору (подача, сотрудник, дата). Ключ карты — ownershipKey.
 *
 * Для персональных подач всегда unknown (владение снимочное), для остальных —
 * owned / not_owned / unknown по правилу classifyOwnership.
 */
export async function resolveDayOwnership(
  requests: readonly IOwnershipRequest[],
  exec: DbExecutor | undefined,
): Promise<Map<string, TDayOwnership>> {
  const ownership = new Map<string, TDayOwnership>();
  if (requests.length === 0) return ownership;

  const employeeIds = new Set<number>();
  let minDate: string | null = null;
  let maxDate: string | null = null;

  for (const request of requests) {
    for (const rawId of request.employeeIds) {
      const employeeId = Number(rawId);
      if (Number.isInteger(employeeId) && employeeId > 0) employeeIds.add(employeeId);
    }
    for (const date of request.dates) {
      if (!isIsoDate(date)) continue;
      if (minDate == null || date < minDate) minDate = date;
      if (maxDate == null || date > maxDate) maxDate = date;
    }
  }

  if (employeeIds.size === 0 || minDate == null || maxDate == null) return ownership;

  const intervals = await loadOwnershipIntervals(
    [...employeeIds],
    minDate,
    maxDate,
    requests.map(r => ({ approvalId: r.approvalId, departmentId: r.departmentId })),
    exec,
  );

  for (const request of requests) {
    const personal = !(typeof request.departmentId === 'string' && request.departmentId);
    for (const rawId of request.employeeIds) {
      const employeeId = Number(rawId);
      if (!Number.isInteger(employeeId) || employeeId <= 0) continue;
      for (const date of request.dates) {
        if (!isIsoDate(date)) continue;
        ownership.set(
          ownershipKey(request.approvalId, employeeId, date),
          personal
            ? 'unknown'
            : classifyOwnership(intervals.get(employeeId), request.approvalId, date),
        );
      }
    }
  }

  return ownership;
}

/** Владеет ли подача днём: unknown трактуется как владение (снимок). */
export const ownsDay = (state: TDayOwnership | undefined): boolean => state !== 'not_owned';
