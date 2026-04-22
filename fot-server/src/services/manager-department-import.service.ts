import { readExcelRows } from '../utils/excel-reader.js';
import { supabase } from '../config/database.js';

const IMPORT_SOURCE_TYPE = 'manager_excel_admin_ui';

let missingEmployeeAliasTableWarned = false;
let missingBrigadeAliasTableWarned = false;

export interface IManagerDepartmentImportCandidate {
  id: string;
  name: string | null;
}

export type IBrigadeWorkerStatus =
  | 'already_in_brigade'
  | 'in_other_department'
  | 'archived_match'
  | 'not_found'
  | 'ambiguous';

export interface IBrigadeWorkerCandidate {
  employee_id: number;
  full_name: string;
  department_id: string | null;
  department_name: string | null;
  is_archived: boolean;
}

export interface IBrigadeWorkerPreview {
  original_name: string;
  normalized_name: string;
  status: IBrigadeWorkerStatus;
  employee_id?: number;
  current_department_id?: string | null;
  current_department_name?: string | null;
  is_archived?: boolean;
  candidates?: IBrigadeWorkerCandidate[];
}

export interface IBrigadeWorkerMissing {
  employee_id: number;
  full_name: string;
  is_archived: boolean;
}

export interface IBrigadeWorkerAnalysis {
  excel_workers: IBrigadeWorkerPreview[];
  missing_from_excel: IBrigadeWorkerMissing[];
}

export interface IManagerDepartmentImportBrigadePreview {
  brigade_name: string;
  row_number: number;
  status: 'matched' | 'unmatched' | 'ambiguous';
  department_id: string | null;
  department_name: string | null;
  candidates?: IManagerDepartmentImportCandidate[];
  worker_analysis?: IBrigadeWorkerAnalysis;
}

export interface IManagerDepartmentImportGroupPreview {
  group_key: string;
  manager_name: string;
  section_name: string | null;
  saved_employee_id: number | null;
  brigade_count: number;
  resolved_department_ids: string[];
  brigades: IManagerDepartmentImportBrigadePreview[];
}

export interface IManagerDepartmentImportPreview {
  stats: {
    total_groups: number;
    total_links: number;
    resolved_links: number;
    unresolved_links: number;
  };
  groups: IManagerDepartmentImportGroupPreview[];
}

interface IParsedLink {
  manager_name: string;
  brigade_name: string;
  row_number: number;
  section_name: string | null;
  worker_names: string[];
}

interface IDepartmentRow {
  id: string;
  name: string | null;
}

interface IEmployeeAliasRow {
  section_name_normalized: string;
  manager_name_normalized: string;
  employee_id: number;
}

interface IBrigadeAliasRow {
  section_name_normalized: string;
  brigade_name_normalized: string;
  department_id: string;
}

interface IEmployeeRow {
  id: number;
  full_name: string;
  org_department_id: string | null;
  is_archived: boolean;
}

export interface IManagerDepartmentImportEmployeeAliasInput {
  section_name: string | null;
  manager_name: string;
  employee_id: number;
}

export interface IManagerDepartmentImportBrigadeAliasInput {
  section_name: string | null;
  brigade_name: string;
  department_id: string;
}

function isMissingTableError(error: unknown, tableName: string): boolean {
  if (!error || typeof error !== 'object') return false;

  const code = 'code' in error ? String((error as { code?: unknown }).code || '') : '';
  const message = 'message' in error ? String((error as { message?: unknown }).message || '') : '';

  return code === 'PGRST205'
    || message.includes(`Could not find the table 'public.${tableName}'`);
}

function warnMissingEmployeeAliasTable(): void {
  if (missingEmployeeAliasTableWarned) return;
  missingEmployeeAliasTableWarned = true;
  console.warn(
    '[manager-department-import] table public.manager_department_import_employee_aliases not found; saved employee mappings are disabled until docs/migrations/033_manager_department_import_aliases.sql is applied.',
  );
}

function warnMissingBrigadeAliasTable(): void {
  if (missingBrigadeAliasTableWarned) return;
  missingBrigadeAliasTableWarned = true;
  console.warn(
    '[manager-department-import] table public.manager_department_import_brigade_aliases not found; saved brigade mappings are disabled until docs/migrations/033_manager_department_import_aliases.sql is applied.',
  );
}

function normalizeText(value: string | null | undefined): string {
  return String(value || '')
    .replace(/ /g, ' ')
    .replace(/ё/giu, 'е')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function createGroupKey(sectionName: string | null, managerName: string): string {
  return `${normalizeText(sectionName)}::${normalizeText(managerName)}`;
}

function createBrigadeAliasKey(sectionName: string | null, brigadeName: string): string {
  return `${normalizeText(sectionName)}::${normalizeText(brigadeName)}`;
}

function uniqueDepartmentIds(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))];
}

function parseSectionFromManagerRow(raw: string): { manager_name: string; section_name: string | null } {
  const match = /^(.+?)\s*\(\d+\.\s*(.+?)\)\s*$/.exec(raw.trim());
  if (!match) {
    return { manager_name: raw.trim(), section_name: null };
  }
  return { manager_name: match[1].trim(), section_name: match[2].trim() };
}

function isMultiColumnFormat(rows: string[][]): boolean {
  const headerCell = rows?.[2]?.[1];
  return normalizeText(headerCell) === 'тип';
}

function parseOldFormatWorkbook(rows: string[][]): IParsedLink[] {
  const links: IParsedLink[] = [];
  let currentManager: string | null = null;
  let currentSection: string | null = null;

  for (let i = 8; i < rows.length; i++) {
    const cell = String(rows[i][0] ?? '').trim();
    if (!cell) continue;

    if (cell.startsWith('бр.')) {
      if (currentManager) {
        links.push({
          manager_name: currentManager,
          brigade_name: cell,
          row_number: i + 1,
          section_name: currentSection,
          worker_names: [],
        });
      }
    } else if (cell.includes('(')) {
      const parsed = parseSectionFromManagerRow(cell);
      currentManager = parsed.manager_name;
      currentSection = parsed.section_name;
    }
  }

  return links;
}

function parseMultiColumnWorkbook(rows: string[][]): IParsedLink[] {
  const links: IParsedLink[] = [];
  let currentManager: string | null = null;
  let currentSection: string | null = null;
  let currentBrigade: IParsedLink | null = null;

  for (let i = 3; i < rows.length; i++) {
    const typeCell = String(rows[i]?.[1] ?? '').trim();
    const nameCell = String(rows[i]?.[2] ?? '').trim();
    if (!typeCell || !nameCell) continue;

    const typeNormalized = normalizeText(typeCell);

    if (typeNormalized === 'нач.уч.' || typeNormalized === 'начальник' || typeNormalized === 'руководитель') {
      const parsed = parseSectionFromManagerRow(nameCell);
      currentManager = parsed.manager_name;
      currentSection = parsed.section_name;
      currentBrigade = null;
      continue;
    }

    if (typeNormalized === 'прораб' || typeNormalized === 'мастер') {
      continue;
    }

    if (typeNormalized === 'бригада') {
      if (!currentManager) continue;
      currentBrigade = {
        manager_name: currentManager,
        brigade_name: nameCell,
        row_number: i + 1,
        section_name: currentSection,
        worker_names: [],
      };
      links.push(currentBrigade);
      continue;
    }

    if (typeNormalized === 'рабочий') {
      if (!currentBrigade) continue;
      currentBrigade.worker_names.push(nameCell);
    }
  }

  return links;
}

async function parseWorkbookBuffer(buffer: Buffer): Promise<IParsedLink[]> {
  const rows = await readExcelRows(buffer);
  return isMultiColumnFormat(rows)
    ? parseMultiColumnWorkbook(rows)
    : parseOldFormatWorkbook(rows);
}

async function loadActiveDepartments(): Promise<IDepartmentRow[]> {
  const { data, error } = await supabase
    .from('org_departments')
    .select('id, name')
    .eq('is_active', true);

  if (error) {
    throw error;
  }

  return (data || []) as IDepartmentRow[];
}

async function loadAllEmployees(): Promise<IEmployeeRow[]> {
  const { data, error } = await supabase
    .from('employees')
    .select('id, full_name, org_department_id, is_archived');

  if (error) {
    throw error;
  }

  return (data || []) as IEmployeeRow[];
}

function buildDepartmentMatchIndex(rows: IDepartmentRow[]): Map<string, IDepartmentRow[]> {
  const index = new Map<string, IDepartmentRow[]>();
  for (const row of rows) {
    const key = normalizeText(row.name);
    if (!key) continue;
    const current = index.get(key) || [];
    current.push(row);
    index.set(key, current);
  }

  return index;
}

function buildEmployeesByNormalizedName(rows: IEmployeeRow[]): Map<string, IEmployeeRow[]> {
  const index = new Map<string, IEmployeeRow[]>();
  for (const row of rows) {
    const key = normalizeText(row.full_name);
    if (!key) continue;
    const current = index.get(key) || [];
    current.push(row);
    index.set(key, current);
  }

  return index;
}

function buildEmployeesByDepartmentId(rows: IEmployeeRow[]): Map<string, IEmployeeRow[]> {
  const index = new Map<string, IEmployeeRow[]>();
  for (const row of rows) {
    if (!row.org_department_id) continue;
    const current = index.get(row.org_department_id) || [];
    current.push(row);
    index.set(row.org_department_id, current);
  }

  return index;
}

function toWorkerCandidate(
  employee: IEmployeeRow,
  departmentById: Map<string, IDepartmentRow>,
): IBrigadeWorkerCandidate {
  const department = employee.org_department_id ? departmentById.get(employee.org_department_id) || null : null;
  return {
    employee_id: employee.id,
    full_name: employee.full_name,
    department_id: employee.org_department_id,
    department_name: department?.name ?? null,
    is_archived: Boolean(employee.is_archived),
  };
}

export function classifyBrigadeWorkers(params: {
  worker_names: string[];
  brigade_department_id: string;
  employeesByNormalizedName: Map<string, IEmployeeRow[]>;
  employeesByDepartmentId: Map<string, IEmployeeRow[]>;
  departmentById: Map<string, IDepartmentRow>;
}): IBrigadeWorkerAnalysis {
  const excel_workers: IBrigadeWorkerPreview[] = [];
  const matchedEmployeeIds = new Set<number>();

  for (const rawName of params.worker_names) {
    const normalized = normalizeText(rawName);
    const matches = params.employeesByNormalizedName.get(normalized) || [];

    if (matches.length === 0) {
      excel_workers.push({
        original_name: rawName,
        normalized_name: normalized,
        status: 'not_found',
      });
      continue;
    }

    if (matches.length === 1) {
      const [only] = matches;
      matchedEmployeeIds.add(only.id);

      if (only.org_department_id === params.brigade_department_id) {
        excel_workers.push({
          original_name: rawName,
          normalized_name: normalized,
          status: 'already_in_brigade',
          employee_id: only.id,
          current_department_id: only.org_department_id,
          current_department_name: params.departmentById.get(params.brigade_department_id)?.name ?? null,
          is_archived: Boolean(only.is_archived),
        });
        continue;
      }

      const currentDept = only.org_department_id
        ? params.departmentById.get(only.org_department_id) || null
        : null;
      excel_workers.push({
        original_name: rawName,
        normalized_name: normalized,
        status: only.is_archived ? 'archived_match' : 'in_other_department',
        employee_id: only.id,
        current_department_id: only.org_department_id,
        current_department_name: currentDept?.name ?? null,
        is_archived: Boolean(only.is_archived),
      });
      continue;
    }

    // ambiguous: multiple employees with same ФИО
    const candidates = matches.map(match => toWorkerCandidate(match, params.departmentById));
    const sameDeptCandidate = matches.find(match => match.org_department_id === params.brigade_department_id);
    if (sameDeptCandidate) matchedEmployeeIds.add(sameDeptCandidate.id);
    excel_workers.push({
      original_name: rawName,
      normalized_name: normalized,
      status: 'ambiguous',
      candidates,
    });
  }

  const brigadeEmployees = params.employeesByDepartmentId.get(params.brigade_department_id) || [];
  const missing_from_excel: IBrigadeWorkerMissing[] = brigadeEmployees
    .filter(employee => !matchedEmployeeIds.has(employee.id))
    .map(employee => ({
      employee_id: employee.id,
      full_name: employee.full_name,
      is_archived: Boolean(employee.is_archived),
    }));

  return { excel_workers, missing_from_excel };
}

async function loadSavedEmployeeAliasIndex(): Promise<Map<string, number>> {
  const { data, error } = await supabase
    .from('manager_department_import_employee_aliases')
    .select('section_name_normalized, manager_name_normalized, employee_id')
    .eq('source_type', IMPORT_SOURCE_TYPE)
    .eq('is_active', true);

  if (error) {
    if (isMissingTableError(error, 'manager_department_import_employee_aliases')) {
      warnMissingEmployeeAliasTable();
      return new Map();
    }
    throw error;
  }

  const result = new Map<string, number>();
  for (const row of (data || []) as IEmployeeAliasRow[]) {
    result.set(`${row.section_name_normalized}::${row.manager_name_normalized}`, row.employee_id);
  }

  return result;
}

async function loadSavedBrigadeAliasIndex(
  departmentById: Map<string, IDepartmentRow>,
): Promise<Map<string, IDepartmentRow>> {
  const { data, error } = await supabase
    .from('manager_department_import_brigade_aliases')
    .select('section_name_normalized, brigade_name_normalized, department_id')
    .eq('source_type', IMPORT_SOURCE_TYPE)
    .eq('is_active', true);

  if (error) {
    if (isMissingTableError(error, 'manager_department_import_brigade_aliases')) {
      warnMissingBrigadeAliasTable();
      return new Map();
    }
    throw error;
  }

  const result = new Map<string, IDepartmentRow>();
  for (const row of (data || []) as IBrigadeAliasRow[]) {
    const department = departmentById.get(row.department_id);
    if (!department) continue;
    result.set(`${row.section_name_normalized}::${row.brigade_name_normalized}`, department);
  }

  return result;
}

export async function buildManagerDepartmentImportPreviewFromBuffer(
  buffer: Buffer,
): Promise<IManagerDepartmentImportPreview> {
  const links = await parseWorkbookBuffer(buffer);
  const hasWorkerData = links.some(link => link.worker_names.length > 0);
  const departments = await loadActiveDepartments();
  const departmentById = new Map(departments.map(row => [row.id, row]));
  const [departmentIndex, employeeAliasIndex, brigadeAliasIndex, employees] = await Promise.all([
    Promise.resolve(buildDepartmentMatchIndex(departments)),
    loadSavedEmployeeAliasIndex(),
    loadSavedBrigadeAliasIndex(departmentById),
    hasWorkerData ? loadAllEmployees() : Promise.resolve([] as IEmployeeRow[]),
  ]);
  const employeesByNormalizedName = hasWorkerData ? buildEmployeesByNormalizedName(employees) : new Map();
  const employeesByDepartmentId = hasWorkerData ? buildEmployeesByDepartmentId(employees) : new Map();
  const groupMap = new Map<string, IManagerDepartmentImportGroupPreview>();
  let resolvedLinks = 0;
  let unresolvedLinks = 0;

  for (const link of links) {
    const groupKey = createGroupKey(link.section_name, link.manager_name);
    const existingGroup = groupMap.get(groupKey) || {
      group_key: groupKey,
      manager_name: link.manager_name,
      section_name: link.section_name,
      saved_employee_id: employeeAliasIndex.get(groupKey) || null,
      brigade_count: 0,
      resolved_department_ids: [],
      brigades: [],
    };

    const aliasDepartment = brigadeAliasIndex.get(createBrigadeAliasKey(link.section_name, link.brigade_name)) || null;
    const matches = aliasDepartment
      ? [aliasDepartment]
      : (departmentIndex.get(normalizeText(link.brigade_name)) || []);
    let brigadePreview: IManagerDepartmentImportBrigadePreview;

    if (matches.length === 1) {
      resolvedLinks += 1;
      brigadePreview = {
        brigade_name: link.brigade_name,
        row_number: link.row_number,
        status: 'matched',
        department_id: matches[0].id,
        department_name: matches[0].name,
      };
      existingGroup.resolved_department_ids = uniqueDepartmentIds([
        ...existingGroup.resolved_department_ids,
        matches[0].id,
      ]);
    } else {
      unresolvedLinks += 1;
      brigadePreview = {
        brigade_name: link.brigade_name,
        row_number: link.row_number,
        status: matches.length === 0 ? 'unmatched' : 'ambiguous',
        department_id: null,
        department_name: null,
        candidates: matches.length > 1
          ? matches.map(match => ({ id: match.id, name: match.name }))
          : undefined,
      };
    }

    if (hasWorkerData && brigadePreview.department_id) {
      brigadePreview.worker_analysis = classifyBrigadeWorkers({
        worker_names: link.worker_names,
        brigade_department_id: brigadePreview.department_id,
        employeesByNormalizedName,
        employeesByDepartmentId,
        departmentById,
      });
    } else if (hasWorkerData && link.worker_names.length > 0) {
      brigadePreview.worker_analysis = {
        excel_workers: link.worker_names.map(name => ({
          original_name: name,
          normalized_name: normalizeText(name),
          status: 'not_found' as const,
        })),
        missing_from_excel: [],
      };
    }

    existingGroup.brigades.push(brigadePreview);
    existingGroup.brigade_count = existingGroup.brigades.length;
    groupMap.set(groupKey, existingGroup);
  }

  return {
    stats: {
      total_groups: groupMap.size,
      total_links: links.length,
      resolved_links: resolvedLinks,
      unresolved_links: unresolvedLinks,
    },
    groups: [...groupMap.values()].sort((left, right) => left.manager_name.localeCompare(right.manager_name, 'ru')),
  };
}

export async function saveManagerDepartmentImportAliases(params: {
  actor_user_id: string;
  employee_aliases?: IManagerDepartmentImportEmployeeAliasInput[];
  brigade_aliases?: IManagerDepartmentImportBrigadeAliasInput[];
}): Promise<void> {
  const now = new Date().toISOString();
  const employeeAliasRows = [...new Map(
    (params.employee_aliases || [])
      .filter(alias => alias.manager_name.trim().length > 0 && Number.isInteger(alias.employee_id))
      .map(alias => {
        const sectionKey = normalizeText(alias.section_name);
        const managerKey = normalizeText(alias.manager_name);
        return [`${sectionKey}::${managerKey}`, {
          source_type: IMPORT_SOURCE_TYPE,
          section_name_normalized: sectionKey,
          manager_name_normalized: managerKey,
          manager_name_original: alias.manager_name.trim(),
          employee_id: alias.employee_id,
          is_active: true,
          created_by: params.actor_user_id,
          updated_at: now,
        }];
      }),
  ).values()];

  if (employeeAliasRows.length > 0) {
    const { error } = await supabase
      .from('manager_department_import_employee_aliases')
      .upsert(employeeAliasRows, {
        onConflict: 'source_type,section_name_normalized,manager_name_normalized',
      });

    if (error) {
      if (isMissingTableError(error, 'manager_department_import_employee_aliases')) {
        warnMissingEmployeeAliasTable();
      } else {
        throw error;
      }
    }
  }

  const brigadeAliasRows = [...new Map(
    (params.brigade_aliases || [])
      .filter(alias => alias.brigade_name.trim().length > 0 && alias.department_id.trim().length > 0)
      .map(alias => {
        const sectionKey = normalizeText(alias.section_name);
        const brigadeKey = normalizeText(alias.brigade_name);
        return [`${sectionKey}::${brigadeKey}`, {
          source_type: IMPORT_SOURCE_TYPE,
          section_name_normalized: sectionKey,
          brigade_name_normalized: brigadeKey,
          brigade_name_original: alias.brigade_name.trim(),
          department_id: alias.department_id.trim(),
          is_active: true,
          created_by: params.actor_user_id,
          updated_at: now,
        }];
      }),
  ).values()];

  if (brigadeAliasRows.length > 0) {
    const { error } = await supabase
      .from('manager_department_import_brigade_aliases')
      .upsert(brigadeAliasRows, {
        onConflict: 'source_type,section_name_normalized,brigade_name_normalized',
      });

    if (error) {
      if (isMissingTableError(error, 'manager_department_import_brigade_aliases')) {
        warnMissingBrigadeAliasTable();
      } else {
        throw error;
      }
    }
  }
}
