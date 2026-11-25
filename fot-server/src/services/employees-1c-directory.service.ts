/**
 * Справочник сотрудников для 1С (GET /api/public/v1/employees): ID_FOT, код физлица 1С, ФИО, дата рождения, табельный,
 * организация, отдел, должность, даты приёма и увольнения — чтобы 1С сама проставила ID_FOT своим сотрудникам
 * (по коду физлица, без него — по ФИО и дате рождения) и передавала его в увольнениях и подтверждениях.
 *
 * Состав — как у «сотрудников месяца» (staff-month), чтобы ID_FOT совпадали: не архивные, не «уволен без даты»,
 * работающие и уволенные с STAFF_MONTH_FIRST, без подрядчиков. Подрядчик — отдел в разделе «Подрядные организации»:
 * у работающего — текущий отдел, у уволенного — отдел последнего неотменённого увольнения (уволенные сидят в
 * «Уволенных»; нет события — последний другой отдел из назначений). Организация — по тому же отделу: корень СУ-10 или
 * СМ (createDepartmentPlacer).
 */
import { query } from '../config/postgres.js';
import { createDepartmentPlacer, listSectionDepartmentIds, type IExportDepartmentRow } from './employees-export.service.js';

/** Первый месяц данных API для ЗУП3 — уволенные раньше в справочник не попадают. */
export const DIRECTORY_FIRED_SINCE = '2026-06-01';

export const DIRECTORY_MAX_LIMIT = 1000;

export type DirectoryStatus = 'active' | 'fired';

/** Организации 1С по корню компании в структуре ФОТ. */
const ORGANIZATIONS: Record<string, { inn: string; name: string }> = {
  su10: { inn: '7736255508', name: 'СУ-10' },
  sm: { inn: '7705794997', name: 'Служба механизации' },
};

export interface IDirectoryFilters {
  idAll: string | null;
  employeeId: number | null;
  status: DirectoryStatus | null;
  afterId: number | null;
  limit: number;
}

export interface IDirectoryEmployee {
  employee_id: number;
  id_all: string | null;
  full_name: string | null;
  last_name: string | null;
  first_name: string | null;
  middle_name: string | null;
  birth_date: string | null;
  tab_number: string | null;
  organization: { inn: string; name: string } | null;
  department: { id: string; name: string } | null;
  position: string | null;
  hire_date: string | null;
  dismissal_date: string | null;
  status: DirectoryStatus;
}

interface IDirectorySqlRow {
  id: number;
  id_all: string | null;
  full_name: string | null;
  last_name: string | null;
  first_name: string | null;
  middle_name: string | null;
  birth_date: string | null;
  tab_number: string | null;
  department_id: string | null;
  position: string | null;
  hire_date: string | null;
  dismissal_date: string | null;
  employment_status: string;
}

/**
 * Отдел, по которому решаются «подрядчик» и организация: у уволенного — отдел последнего неотменённого увольнения
 * (если оно есть), иначе текущий.
 */
const DIRECTORY_SQL = `
  WITH last_dismissal AS (
    SELECT DISTINCT ON (de.employee_id) de.employee_id, de.from_department_id
      FROM employee_dismissal_events de
     WHERE de.cancelled = false
     ORDER BY de.employee_id, de.created_at DESC
  ), base AS (
    SELECT e.*, CASE WHEN e.employment_status = 'fired'
                     THEN COALESCE(ld.from_department_id, la.org_department_id, e.org_department_id)
                     ELSE e.org_department_id END AS directory_department_id
      FROM employees e
      LEFT JOIN last_dismissal ld ON ld.employee_id = e.id
      -- Увольнение без события (старые записи): последний отдел из назначений, кроме текущего («Уволенные»).
      LEFT JOIN LATERAL (
        SELECT a.org_department_id FROM employee_assignments a
         WHERE a.employee_id = e.id AND a.org_department_id IS DISTINCT FROM e.org_department_id
         ORDER BY a.effective_from DESC NULLS LAST
         LIMIT 1
      ) la ON e.employment_status = 'fired'
  )
  SELECT b.id, h.passdesk_id_all::text AS id_all, b.full_name, b.last_name, b.first_name, b.middle_name,
         to_char(b.birth_date, 'YYYY-MM-DD') AS birth_date, NULLIF(btrim(b.tab_number), '') AS tab_number,
         b.directory_department_id::text AS department_id, p.name AS position,
         to_char(b.hire_date, 'YYYY-MM-DD') AS hire_date, to_char(b.dismissal_date, 'YYYY-MM-DD') AS dismissal_date,
         b.employment_status
    FROM base b
    LEFT JOIN employee_hr_profiles h ON h.employee_id = b.id
    LEFT JOIN positions p ON p.id = b.position_id
   WHERE b.is_archived = false
     AND NOT (b.employment_status = 'fired' AND b.dismissal_date IS NULL)
     AND (b.employment_status <> 'fired' OR b.dismissal_date >= $1::date)
     AND NOT COALESCE(b.directory_department_id::text = ANY($2::text[]), false)
     AND ($3::uuid IS NULL OR h.passdesk_id_all = $3::uuid)
     AND ($4::int IS NULL OR b.id = $4::int)
     AND ($5::text IS NULL OR ($5 = 'fired') = (b.employment_status = 'fired'))
     AND ($6::int IS NULL OR b.id > $6::int)
   ORDER BY b.id
   LIMIT $7`;

/** Страница справочника: строки по возрастанию ID_FOT; следующая — с after_id последней строки. */
export const listDirectoryEmployees = async (filters: IDirectoryFilters): Promise<{
  rows: IDirectoryEmployee[];
  nextAfterId: number | null;
}> => {
  const departments = await query<IExportDepartmentRow>('SELECT id::text AS id, parent_id::text AS parent_id, name, kind FROM org_departments');
  const contractorIds = listSectionDepartmentIds(departments, 'contractors');
  const placer = createDepartmentPlacer(departments);
  const found = await query<IDirectorySqlRow>(DIRECTORY_SQL, [
    DIRECTORY_FIRED_SINCE, contractorIds, filters.idAll, filters.employeeId, filters.status, filters.afterId, filters.limit + 1,
  ]);
  const page = found.slice(0, filters.limit);
  const rows = page.map((row): IDirectoryEmployee => {
    const department = row.department_id ? placer.byId.get(row.department_id) : undefined;
    const company = row.department_id ? placer.place(row.department_id).company : 'other';
    return {
      employee_id: Number(row.id),
      id_all: row.id_all,
      full_name: row.full_name,
      last_name: row.last_name,
      first_name: row.first_name,
      middle_name: row.middle_name,
      birth_date: row.birth_date,
      tab_number: row.tab_number,
      organization: ORGANIZATIONS[company] ?? null,
      department: row.department_id ? { id: row.department_id, name: department?.name ?? '' } : null,
      position: row.position,
      hire_date: row.hire_date,
      dismissal_date: row.dismissal_date,
      status: row.employment_status === 'fired' ? 'fired' : 'active',
    };
  });
  return { rows, nextAfterId: found.length > filters.limit && rows.length > 0 ? rows[rows.length - 1].employee_id : null };
};
