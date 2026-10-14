import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { withTransaction } from '../config/postgres.js';
import type { IUnifiedRow } from './timesheet-1c-unified.service.js';
import type { IScopedMembershipCandidate, ScopedMembershipSource } from './timesheet-department-assignments.service.js';
import {
  ONE_C_DATA_START_ROW,
  oneCFullNameCell,
  oneCPositiveOrNull,
  oneCRowDayCells,
} from './timesheet-excel.service.js';
import type { IExportRosterTrace } from './timesheet-export.service.js';
import type { IObjectsExportTrace, ObjectsExportCandidateSource } from './timesheet-objects-export.service.js';

// Журнал выгрузок «Единый файл для 1С» из «Табели HR» (миграция 308): что ушло в файл и на
// каком этапе отбора отсеян каждый кандидат. Нужен для разбора «в 1С пропал сотрудник / часы».

export type Unified1CExportSource = 'hr_departments' | 'hr_objects';

/** 'membership' — был в составе выгрузки, но не в диагностическом снимке (данные сменились между запросами). */
export type Unified1CCandidateSource = ScopedMembershipSource | 'membership' | ObjectsExportCandidateSource;

/** Порядок этапов — в миграции 308. NULL — сотрудник в файле. */
export type Unified1CDropStage =
  | 'archived'
  | 'fired'
  | 'excluded_from_timesheet'
  | 'not_in_membership'
  | 'transfer_out_of_scope'
  | 'archived_or_excluded'
  | 'department_filter'
  | 'fired_or_archived'
  | 'zero_activity'
  | 'no_row';

export interface IUnified1CLogRow {
  excel_row: number;
  employee_id: number;
  full_name: string;
  department_id: string | null;
  department_name: string;
  object_id: string | null;
  object_address: string;
  manager_name: string;
  position: string;
  days: Record<string, string | number>;
  total_hours: number | null;
  worked_days: number | null;
}

export interface IUnified1CLogCandidate {
  employee_id: number;
  department_id: string | null;
  sources: Unified1CCandidateSource[];
  drop_stage: Unified1CDropStage | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Журнал не должен ронять выгрузку из-за формата: не-uuid пишем как NULL, а не валим каст.
const uuidOrNull = (value: string | null | undefined): string | null =>
  typeof value === 'string' && UUID_RE.test(value) ? value : null;

const uuidList = (values: readonly string[]): string[] =>
  [...new Set(values.filter(value => UUID_RE.test(value)))];

/**
 * Строки журнала ровно как ячейки файла: номер строки Excel, ФИО с защитой от формул,
 * дни без пустых ячеек, нулевой итог/«Дни» — NULL (ячейка пустая). Функции значений —
 * общие с писателем Excel (timesheet-excel.service).
 */
export function serializeUnifiedRowsForLog(rows: readonly IUnifiedRow[]): IUnified1CLogRow[] {
  return rows.map((row, index) => ({
    excel_row: ONE_C_DATA_START_ROW + index,
    employee_id: row.oneCRow.employeeId,
    full_name: oneCFullNameCell(row.oneCRow.fullName) ?? '',
    department_id: uuidOrNull(row.departmentId),
    department_name: row.departmentName ?? '',
    object_id: uuidOrNull(row.objectId),
    object_address: row.objectAddress ?? '',
    manager_name: row.managerName ?? '',
    position: row.position ?? '',
    days: oneCRowDayCells(row.oneCRow),
    total_hours: oneCPositiveOrNull(row.oneCRow.totalHours),
    worked_days: oneCPositiveOrNull(row.oneCRow.workedDays),
  }));
}

// Сотрудник в строках, которого нет среди кандидатов, — страховка инварианта
// «каждый из файла есть в снимке отбора».
const appendRowEmployeesMissingFromCandidates = (
  result: IUnified1CLogCandidate[],
  rowEmployeeIds: ReadonlySet<number>,
): IUnified1CLogCandidate[] => {
  const seen = new Set(result.map(candidate => candidate.employee_id));
  for (const employeeId of rowEmployeeIds) {
    if (!seen.has(employeeId)) {
      result.push({ employee_id: employeeId, department_id: null, sources: [], drop_stage: null });
    }
  }
  return result;
};

export interface IDepartmentCandidatesInput {
  /** Диагностический снимок членства (listScopedMembershipCandidates). */
  candidates: readonly IScopedMembershipCandidate[];
  /** Фактический состав выгрузки (listScopedMembersByDepartment). */
  memberByEmp: ReadonlyMap<number, string | null>;
  bucketedEmployeeIds: ReadonlySet<number>;
  roster: IExportRosterTrace;
  dataEmployeeIds: ReadonlySet<number>;
  rowEmployeeIds: ReadonlySet<number>;
}

/**
 * «По отделам»: первый не пройденный этап. Состав выгрузки (memberByEmp) — истина пути файла:
 * кто в нём есть, классифицируется по следующим этапам, даже если флаги снимка говорят иное.
 */
export function classifyDepartmentCandidates(input: IDepartmentCandidatesInput): IUnified1CLogCandidate[] {
  const ineligible = new Set(input.roster.ineligibleIds);
  const zeroActivity = new Set(input.roster.zeroActivityIds);

  const afterMembership = (employeeId: number): Unified1CDropStage | null => {
    if (!input.bucketedEmployeeIds.has(employeeId)) return 'transfer_out_of_scope';
    if (ineligible.has(employeeId)) return 'fired_or_archived';
    if (zeroActivity.has(employeeId)) return 'zero_activity';
    if (!input.dataEmployeeIds.has(employeeId) || !input.rowEmployeeIds.has(employeeId)) return 'no_row';
    return null;
  };
  const membershipRejection = (candidate: IScopedMembershipCandidate): Unified1CDropStage => {
    if (!candidate.notArchived) return 'archived';
    if (!candidate.firedEligible) return 'fired';
    if (!candidate.notExcluded) return 'excluded_from_timesheet';
    return 'not_in_membership';
  };

  const result: IUnified1CLogCandidate[] = [];
  const seen = new Set<number>();
  for (const candidate of input.candidates) {
    if (seen.has(candidate.employeeId)) continue;
    seen.add(candidate.employeeId);
    const inMembership = input.memberByEmp.has(candidate.employeeId);
    result.push({
      employee_id: candidate.employeeId,
      department_id: uuidOrNull(inMembership ? input.memberByEmp.get(candidate.employeeId) : candidate.departmentId),
      sources: [candidate.source],
      drop_stage: inMembership ? afterMembership(candidate.employeeId) : membershipRejection(candidate),
    });
  }
  for (const [employeeId, departmentId] of input.memberByEmp) {
    if (seen.has(employeeId)) continue;
    seen.add(employeeId);
    result.push({
      employee_id: employeeId,
      department_id: uuidOrNull(departmentId),
      sources: ['membership'],
      drop_stage: afterMembership(employeeId),
    });
  }
  return appendRowEmployeesMissingFromCandidates(result, input.rowEmployeeIds);
}

export interface IObjectCandidatesInput {
  trace: IObjectsExportTrace;
  rowEmployeeIds: ReadonlySet<number>;
}

/** «По объектам»: первый не пройденный этап. */
export function classifyObjectCandidates(input: IObjectCandidatesInput): IUnified1CLogCandidate[] {
  const { trace } = input;
  const departmentFiltered = new Set(trace.departmentFilteredIds);
  const ineligible = new Set(trace.roster.ineligibleIds);
  const zeroActivity = new Set(trace.roster.zeroActivityIds);

  const stageFor = (employeeId: number): Unified1CDropStage | null => {
    // В группы по отделам не попадают архивные и исключённые из табеля.
    if (!trace.departmentByEmployee.has(employeeId)) return 'archived_or_excluded';
    if (departmentFiltered.has(employeeId)) return 'department_filter';
    if (ineligible.has(employeeId)) return 'fired_or_archived';
    if (zeroActivity.has(employeeId)) return 'zero_activity';
    if (!input.rowEmployeeIds.has(employeeId)) return 'no_row';
    return null;
  };

  const result: IUnified1CLogCandidate[] = [];
  for (const [employeeId, sources] of trace.sourcesByEmployee) {
    result.push({
      employee_id: employeeId,
      department_id: uuidOrNull(trace.departmentByEmployee.get(employeeId) ?? null),
      sources: [...sources].sort(),
      drop_stage: stageFor(employeeId),
    });
  }
  return appendRowEmployeesMissingFromCandidates(result, input.rowEmployeeIds);
}

export interface IUnified1CExportLogEntry {
  source: Unified1CExportSource;
  /** 'YYYY-MM' — как пришло в запросе. */
  month: string;
  periodStart: string;
  periodEnd: string;
  /** «По отделам»: выбранные отделы после скоупа. */
  departmentIds?: readonly string[];
  /** «По объектам»: фильтр отделов из запроса (не фактический состав файла). */
  departmentFilterIds?: readonly string[];
  objectIds?: readonly string[];
  fileName: string;
  buffer: Buffer;
  rows: readonly IUnifiedRow[];
  candidates: readonly IUnified1CLogCandidate[];
}

const MONTH_RE = /^\d{4}-\d{2}$/;

/**
 * Пишет выгрузку в журнал одной транзакцией (шапка, строки файла, кандидаты) и возвращает id.
 * Ошибку пробрасывает: вызывающий не отдаёт файл без следа в журнале.
 */
export async function recordUnified1CExport(
  req: Request,
  userId: string,
  entry: IUnified1CExportLogEntry,
): Promise<string> {
  if (!MONTH_RE.test(entry.month)) {
    throw new Error(`Журнал выгрузок 1С: некорректный месяц «${entry.month}»`);
  }
  const monthStart = `${entry.month}-01`;
  const logRows = serializeUnifiedRowsForLog(entry.rows);
  const employeeCount = new Set(logRows.map(row => row.employee_id)).size;
  const fileSha256 = createHash('sha256').update(entry.buffer).digest('hex');

  return withTransaction(async client => {
    const header = await client.query<{ id: string }>(
      `INSERT INTO timesheet_1c_export_log (
         user_id, source, month, period_start, period_end,
         department_ids, department_filter_ids, object_ids,
         file_name, file_sha256, file_bytes, row_count, employee_count, candidate_count,
         ip_address, user_agent
       ) VALUES (
         $1::uuid, $2, $3::date, $4::date, $5::date,
         $6::uuid[], $7::uuid[], $8::uuid[],
         $9, $10, $11, $12, $13, $14,
         $15, $16
       )
       RETURNING id`,
      [
        userId,
        entry.source,
        monthStart,
        entry.periodStart,
        entry.periodEnd,
        uuidList(entry.departmentIds ?? []),
        uuidList(entry.departmentFilterIds ?? []),
        uuidList(entry.objectIds ?? []),
        entry.fileName,
        fileSha256,
        entry.buffer.length,
        logRows.length,
        employeeCount,
        entry.candidates.length,
        req.ip || req.socket?.remoteAddress || null,
        req.headers['user-agent'] ?? null,
      ],
    );
    const exportId = header.rows[0].id;

    if (logRows.length > 0) {
      await client.query(
        `INSERT INTO timesheet_1c_export_log_rows (
           export_id, excel_row, employee_id, full_name, department_id, department_name,
           object_id, object_address, manager_name, position, days, total_hours, worked_days
         )
         SELECT $1::uuid, r.excel_row, r.employee_id, r.full_name, r.department_id, r.department_name,
                r.object_id, r.object_address, r.manager_name, r.position, r.days, r.total_hours, r.worked_days
           FROM jsonb_to_recordset($2::jsonb) AS r(
             excel_row int, employee_id int, full_name text, department_id uuid, department_name text,
             object_id uuid, object_address text, manager_name text, position text, days jsonb,
             total_hours numeric, worked_days int
           )`,
        [exportId, JSON.stringify(logRows)],
      );
    }

    if (entry.candidates.length > 0) {
      await client.query(
        `INSERT INTO timesheet_1c_export_log_candidates (export_id, employee_id, department_id, sources, drop_stage)
         SELECT $1::uuid, c.employee_id, c.department_id, c.sources, c.drop_stage
           FROM jsonb_to_recordset($2::jsonb) AS c(
             employee_id int, department_id uuid, sources text[], drop_stage text
           )`,
        [exportId, JSON.stringify(entry.candidates)],
      );
    }

    return exportId;
  });
}
