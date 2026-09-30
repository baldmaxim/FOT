/**
 * Окно «Режим табелирования» (миграция 291) — чтение: состояние окна, поиск сотрудника
 * по ФИО и список сотрудников выбранного отдела. Запись — timesheet-office.service.ts.
 */
import type { AuthenticatedRequest } from '../types/index.js';
import { query, queryOne } from '../config/postgres.js';
import { escapeLike } from '../utils/search.utils.js';
import {
  canWriteDepartmentInScope,
  canWriteEmployeeInScope,
  resolveAccessibleDepartmentIds,
  resolveWritableScopedDepartmentIds,
} from './data-scope.service.js';
import { loadContractorDepartmentIds, loadTimesheetObjectLabels } from './employee-timesheet-object.service.js';
import { personalOfficeSql } from './timesheet-office-rule.js';
import { TimesheetOfficeError } from './timesheet-office.service.js';

const SEARCH_LIMIT = 20;
const SEARCH_MIN_LENGTH = 2;

export interface ITimesheetOfficeDepartment {
  id: string;
  name: string;
  employees_count: number;
}

export interface ITimesheetOfficeEmployee {
  id: number;
  full_name: string;
  department: string | null;
}

export interface ITimesheetOfficeState {
  /** Отделы, которые можно выбрать: активные, не подрядные, в скоупе записи. */
  allowed_department_ids: string[];
  /** Отделы с «Офисом». */
  departments: ITimesheetOfficeDepartment[];
  /** Сотрудники с личным «Офисом». */
  employees: ITimesheetOfficeEmployee[];
}

export interface ITimesheetOfficeMember {
  id: number;
  full_name: string;
  /** Объект табелирования сейчас: «Офис», имя объекта или null. */
  label: string | null;
  /** Личный «Офис» из окна. */
  personal_office: boolean;
}

export interface ITimesheetOfficeEmployeeRow extends ITimesheetOfficeMember {
  department: string | null;
  /** У отдела сотрудника «Офис»: личный не ставится, отдел главнее. */
  department_office: boolean;
}

export interface ITimesheetOfficeDepartmentMembers {
  /** У отдела «Офис». */
  office: boolean;
  employees: ITimesheetOfficeMember[];
}

/** Скоуп чтения как предикат по отделу. */
async function readScopePredicate(req: AuthenticatedRequest): Promise<(departmentId: string | null) => boolean> {
  const accessible = await resolveAccessibleDepartmentIds(req);
  if (accessible === 'all') return () => true;
  const allowed = new Set(accessible);
  return departmentId => departmentId !== null && allowed.has(departmentId);
}

/** GET /api/admin/timesheet-office */
export async function getTimesheetOfficeState(req: AuthenticatedRequest): Promise<ITimesheetOfficeState> {
  const [contractorIds, inReadScope] = await Promise.all([
    loadContractorDepartmentIds(),
    readScopePredicate(req),
  ]);

  const candidates = await query<{ id: string }>(
    `SELECT id::text AS id
       FROM org_departments
      WHERE is_active = true
        AND kind IS DISTINCT FROM 'object'
        AND NOT (id = ANY($1::uuid[]))`,
    [contractorIds],
  );
  // С id: без них при скоупе «все» функция возвращает пустой список.
  const allowed = candidates.length > 0
    ? await resolveWritableScopedDepartmentIds(req, candidates.map(row => row.id))
    : [];

  // Отделы с «Офисом» — и неактивные: снять правило должно быть можно всегда.
  const departments = (await query<ITimesheetOfficeDepartment>(
    `SELECT d.id::text AS id,
            d.name,
            (SELECT count(*)::int
               FROM employees e
              WHERE e.org_department_id = d.id
                AND e.is_archived = false
                AND e.employment_status = 'active') AS employees_count
       FROM timesheet_office_departments tod
       JOIN org_departments d ON d.id = tod.org_department_id
      ORDER BY d.name, d.id`,
  )).filter(row => inReadScope(row.id));

  const employees = (await query<ITimesheetOfficeEmployee & { department_id: string | null }>(
    `SELECT e.id,
            e.full_name,
            e.org_department_id::text AS department_id,
            d.name AS department
       FROM employees e
       LEFT JOIN org_departments d ON d.id = e.org_department_id
      WHERE e.is_archived = false
        AND ${personalOfficeSql('e')}
      ORDER BY e.full_name, e.id`,
  ))
    .filter(row => inReadScope(row.department_id))
    .map(row => ({ id: Number(row.id), full_name: row.full_name, department: row.department }));

  return { allowed_department_ids: allowed, departments, employees };
}

/** GET /api/admin/timesheet-office/employees?search= — подсказки для «Поиска по ФИО». */
export async function searchTimesheetOfficeEmployees(
  req: AuthenticatedRequest,
  search: string,
): Promise<ITimesheetOfficeEmployee[]> {
  const term = search.trim().toLowerCase().replace(/ё/g, 'е');
  if (term.length < SEARCH_MIN_LENGTH) return [];

  const [contractorIds, accessible] = await Promise.all([
    loadContractorDepartmentIds(),
    resolveAccessibleDepartmentIds(req),
  ]);
  // Скоуп записи: при «всех» фильтра нет, иначе — отделы, где пользователь может править.
  const writable = accessible === 'all' ? null : await resolveWritableScopedDepartmentIds(req, accessible);
  if (writable && writable.length === 0) return [];

  const params: unknown[] = [contractorIds, `%${escapeLike(term)}%`];
  let scopeSql = '';
  if (writable) {
    params.push(writable);
    scopeSql = 'AND e.org_department_id = ANY($3::uuid[])';
  }
  const rows = await query<ITimesheetOfficeEmployee>(
    `SELECT e.id, e.full_name, d.name AS department
       FROM employees e
       LEFT JOIN org_departments d ON d.id = e.org_department_id
      WHERE e.is_archived = false
        AND e.employment_status = 'active'
        AND e.org_department_id IS NOT NULL
        AND NOT (e.org_department_id = ANY($1::uuid[]))
        AND replace(lower(e.full_name), 'ё', 'е') LIKE $2
        ${scopeSql}
      ORDER BY e.full_name, e.id
      LIMIT ${SEARCH_LIMIT}`,
    params,
  );
  return rows.map(row => ({ id: Number(row.id), full_name: row.full_name, department: row.department }));
}

/**
 * GET /api/admin/timesheet-office/departments/:id/employees — прямые работающие сотрудники
 * отдела (без подотделов) с объектом табелирования на сейчас.
 */
export async function getTimesheetOfficeDepartmentMembers(
  req: AuthenticatedRequest,
  departmentId: string,
): Promise<ITimesheetOfficeDepartmentMembers> {
  const [department, contractorIds] = await Promise.all([
    queryOne<{ is_active: boolean; kind: string | null; office: boolean }>(
      `SELECT d.is_active,
              d.kind,
              EXISTS (SELECT 1 FROM timesheet_office_departments tod WHERE tod.org_department_id = d.id) AS office
         FROM org_departments d
        WHERE d.id = $1::uuid`,
      [departmentId],
    ),
    loadContractorDepartmentIds(),
  ]);
  if (!department || !department.is_active || department.kind === 'object' || contractorIds.includes(departmentId)) {
    throw new TimesheetOfficeError(400, 'TIMESHEET_OFFICE_INVALID', 'Отдел не найден, неактивен или подрядный', [departmentId]);
  }
  if (!(await canWriteDepartmentInScope(req, departmentId))) {
    throw new TimesheetOfficeError(403, 'TIMESHEET_OFFICE_FORBIDDEN', 'Отдел вне вашего доступа', { departments: [departmentId] });
  }

  const rows = (await query<{ id: number | string; full_name: string; personal_office: boolean }>(
    `SELECT e.id, e.full_name, ${personalOfficeSql('e')} AS personal_office
       FROM employees e
      WHERE e.org_department_id = $1::uuid
        AND e.is_archived = false
        AND e.employment_status = 'active'
      ORDER BY e.full_name, e.id`,
    [departmentId],
  )).map(row => ({ ...row, id: Number(row.id) }));
  const labels = await loadTimesheetObjectLabels(rows.map(row => row.id));

  return {
    office: department.office,
    employees: rows.map(row => ({
      id: row.id,
      full_name: row.full_name,
      label: labels.get(row.id) ?? null,
      personal_office: row.personal_office === true,
    })),
  };
}

/** GET /api/admin/timesheet-office/employees/:id — строка таблицы для вкладки «Сотрудник». */
export async function getTimesheetOfficeEmployee(
  req: AuthenticatedRequest,
  employeeId: number,
): Promise<ITimesheetOfficeEmployeeRow> {
  const [row, contractorIds] = await Promise.all([
    queryOne<{
      id: number | string;
      full_name: string;
      is_archived: boolean;
      employment_status: string | null;
      org_department_id: string | null;
      department: string | null;
      personal_office: boolean;
      department_office: boolean;
    }>(
      `SELECT e.id,
              e.full_name,
              e.is_archived,
              e.employment_status,
              e.org_department_id::text AS org_department_id,
              d.name AS department,
              ${personalOfficeSql('e')} AS personal_office,
              EXISTS (SELECT 1 FROM timesheet_office_departments tod
                       WHERE tod.org_department_id = e.org_department_id) AS department_office
         FROM employees e
         LEFT JOIN org_departments d ON d.id = e.org_department_id
        WHERE e.id = $1::int`,
      [employeeId],
    ),
    loadContractorDepartmentIds(),
  ]);
  if (!row || row.is_archived || row.employment_status !== 'active' || !row.org_department_id
    || contractorIds.includes(row.org_department_id)) {
    throw new TimesheetOfficeError(
      400, 'TIMESHEET_OFFICE_INVALID', 'Сотрудник не найден, в архиве, не работает или из подрядной организации', [employeeId],
    );
  }
  if (!(await canWriteEmployeeInScope(req, employeeId))) {
    throw new TimesheetOfficeError(403, 'TIMESHEET_OFFICE_FORBIDDEN', 'Сотрудник вне вашего доступа', { employees: [employeeId] });
  }
  const id = Number(row.id);
  const labels = await loadTimesheetObjectLabels([id]);
  return {
    id,
    full_name: row.full_name,
    department: row.department,
    label: labels.get(id) ?? null,
    personal_office: row.personal_office === true,
    department_office: row.department_office === true,
  };
}
