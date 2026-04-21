import { readExcelRows } from '../utils/excel-reader.js';
import { supabase } from '../config/database.js';

const IMPORT_SOURCE_TYPE = 'manager_excel_admin_ui';

let missingEmployeeAliasTableWarned = false;
let missingBrigadeAliasTableWarned = false;

export interface IManagerDepartmentImportCandidate {
  id: string;
  name: string | null;
}

export interface IManagerDepartmentImportBrigadePreview {
  brigade_name: string;
  row_number: number;
  status: 'matched' | 'unmatched' | 'ambiguous';
  department_id: string | null;
  department_name: string | null;
  candidates?: IManagerDepartmentImportCandidate[];
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
    .replace(/\u00A0/g, ' ')
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

async function parseWorkbookBuffer(buffer: Buffer): Promise<IParsedLink[]> {
  const rows = await readExcelRows(buffer);
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
  const departments = await loadActiveDepartments();
  const departmentById = new Map(departments.map(row => [row.id, row]));
  const [departmentIndex, employeeAliasIndex, brigadeAliasIndex] = await Promise.all([
    Promise.resolve(buildDepartmentMatchIndex(departments)),
    loadSavedEmployeeAliasIndex(),
    loadSavedBrigadeAliasIndex(departmentById),
  ]);
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
