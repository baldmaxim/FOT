import ExcelJS from 'exceljs';
import { supabase } from '../src/config/database.js';

const DEFAULT_FILE = '/Users/odintsovlive/Desktop/Project/008 FOT/Список НУ-бр-объект  (март).xlsx';
const DEFAULT_SOURCE = 'excel_march_2026';
const MANAGER_FILL = 'FFFAFAD2';
const BRIGADE_FILL = 'FFE6E6FA';
const SECTION_FILL = 'FFE6E6E6';

interface IParsedLink {
  manager_name: string;
  brigade_name: string;
  row_number: number;
  section_name: string | null;
}

interface IUserProfileRow {
  id: string;
  full_name: string | null;
  employee_id: number | null;
}

interface IEmployeeRow {
  id: number;
  full_name: string | null;
}

interface IDepartmentRow {
  id: string;
  name: string | null;
}

interface IResolvedPair {
  user_id: string;
  department_id: string;
  manager_name: string;
  brigade_name: string;
  row_number: number;
}

interface IMatchIssue {
  kind: 'manager' | 'brigade';
  type: 'unmatched' | 'ambiguous';
  source_value: string;
  row_number: number;
  candidates?: string[];
}

function normalizeText(value: string | null | undefined): string {
  return String(value || '')
    .replace(/\u00A0/g, ' ')
    .replace(/ё/giu, 'е')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function getArgValue(flag: string): string | null {
  const argv = process.argv.slice(2);
  const directIndex = argv.findIndex(arg => arg === flag);
  if (directIndex >= 0) {
    return argv[directIndex + 1] || null;
  }

  const inline = argv.find(arg => arg.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : null;
}

function hasFlag(flag: string): boolean {
  return process.argv.slice(2).includes(flag);
}

function extractArgb(cell: ExcelJS.Cell): string | null {
  const fill = cell.fill;
  if (!fill || fill.type !== 'pattern') return null;
  if (fill.pattern && fill.pattern !== 'solid') return null;
  return fill.fgColor?.argb || fill.bgColor?.argb || null;
}

function extractCellText(cell: ExcelJS.Cell): string {
  if (typeof cell.text === 'string' && cell.text.trim()) {
    return cell.text.trim();
  }

  const value = cell.value;
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (value && typeof value === 'object' && 'richText' in value && Array.isArray(value.richText)) {
    return value.richText.map(part => part.text).join('').trim();
  }

  return '';
}

async function parseWorkbook(filePath: string): Promise<IParsedLink[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    throw new Error('В книге не найден ни один лист');
  }

  const links: IParsedLink[] = [];
  let currentSection: string | null = null;
  let currentManager: string | null = null;

  worksheet.eachRow((row, rowNumber) => {
    const cell = row.getCell(2);
    const text = extractCellText(cell);
    const fill = extractArgb(cell);
    if (!text) {
      return;
    }

    if (fill === SECTION_FILL) {
      currentSection = text;
      currentManager = null;
      return;
    }

    if (fill === MANAGER_FILL) {
      currentManager = text;
      return;
    }

    if (fill === BRIGADE_FILL && currentManager) {
      links.push({
        manager_name: currentManager,
        brigade_name: text,
        row_number: rowNumber,
        section_name: currentSection,
      });
    }
  });

  return links;
}

async function loadProfileMatchIndex(): Promise<Map<string, IUserProfileRow[]>> {
  const { data: profiles, error: profilesError } = await supabase
    .from('user_profiles')
    .select('id, full_name, employee_id');

  if (profilesError) {
    throw profilesError;
  }

  const profileRows = (profiles || []) as IUserProfileRow[];
  const employeeIds = profileRows
    .map(profile => profile.employee_id)
    .filter((employeeId): employeeId is number => Number.isInteger(employeeId));

  const employeeNameById = new Map<number, string>();
  if (employeeIds.length > 0) {
    const { data: employees, error: employeesError } = await supabase
      .from('employees')
      .select('id, full_name')
      .in('id', employeeIds);

    if (employeesError) {
      throw employeesError;
    }

    for (const employee of (employees || []) as IEmployeeRow[]) {
      if (employee.full_name) {
        employeeNameById.set(employee.id, employee.full_name);
      }
    }
  }

  const index = new Map<string, IUserProfileRow[]>();
  for (const profile of profileRows) {
    const keys = new Set([
      normalizeText(profile.full_name),
      normalizeText(profile.employee_id != null ? employeeNameById.get(profile.employee_id) || null : null),
    ]);

    for (const key of keys) {
      if (!key) continue;
      const current = index.get(key) || [];
      current.push(profile);
      index.set(key, current);
    }
  }

  return index;
}

async function loadDepartmentMatchIndex(): Promise<Map<string, IDepartmentRow[]>> {
  const { data, error } = await supabase
    .from('org_departments')
    .select('id, name')
    .eq('is_active', true);

  if (error) {
    throw error;
  }

  const index = new Map<string, IDepartmentRow[]>();
  for (const row of (data || []) as IDepartmentRow[]) {
    const key = normalizeText(row.name);
    if (!key) continue;
    const current = index.get(key) || [];
    current.push(row);
    index.set(key, current);
  }

  return index;
}

function resolveMatches(params: {
  links: IParsedLink[];
  profileIndex: Map<string, IUserProfileRow[]>;
  departmentIndex: Map<string, IDepartmentRow[]>;
}): {
  resolvedPairs: IResolvedPair[];
  issues: IMatchIssue[];
} {
  const resolvedPairs: IResolvedPair[] = [];
  const issues: IMatchIssue[] = [];

  for (const link of params.links) {
    const managerMatches = params.profileIndex.get(normalizeText(link.manager_name)) || [];
    if (managerMatches.length === 0) {
      issues.push({
        kind: 'manager',
        type: 'unmatched',
        source_value: link.manager_name,
        row_number: link.row_number,
      });
      continue;
    }
    if (managerMatches.length > 1) {
      issues.push({
        kind: 'manager',
        type: 'ambiguous',
        source_value: link.manager_name,
        row_number: link.row_number,
        candidates: managerMatches.map(match => `${match.id}:${match.full_name || 'Без ФИО'}`),
      });
      continue;
    }

    const brigadeMatches = params.departmentIndex.get(normalizeText(link.brigade_name)) || [];
    if (brigadeMatches.length === 0) {
      issues.push({
        kind: 'brigade',
        type: 'unmatched',
        source_value: link.brigade_name,
        row_number: link.row_number,
      });
      continue;
    }
    if (brigadeMatches.length > 1) {
      issues.push({
        kind: 'brigade',
        type: 'ambiguous',
        source_value: link.brigade_name,
        row_number: link.row_number,
        candidates: brigadeMatches.map(match => `${match.id}:${match.name || 'Без названия'}`),
      });
      continue;
    }

    resolvedPairs.push({
      user_id: managerMatches[0].id,
      department_id: brigadeMatches[0].id,
      manager_name: link.manager_name,
      brigade_name: link.brigade_name,
      row_number: link.row_number,
    });
  }

  return {
    resolvedPairs: Array.from(
      new Map(
        resolvedPairs.map(pair => [`${pair.user_id}:${pair.department_id}`, pair] as const),
      ).values(),
    ),
    issues,
  };
}

async function applyPairs(resolvedPairs: IResolvedPair[], source: string): Promise<void> {
  const now = new Date().toISOString();
  const rows = resolvedPairs.map(pair => ({
    user_id: pair.user_id,
    department_id: pair.department_id,
    source,
    is_active: true,
    updated_at: now,
  }));

  if (rows.length > 0) {
    const { error } = await supabase
      .from('user_department_access')
      .upsert(rows, { onConflict: 'user_id,department_id' });

    if (error) {
      throw error;
    }
  }

  const activeKeySet = new Set(rows.map(row => `${row.user_id}:${row.department_id}`));
  const { data: existingRows, error: existingError } = await supabase
    .from('user_department_access')
    .select('id, user_id, department_id')
    .eq('source', source);

  if (existingError) {
    throw existingError;
  }

  const staleIds = (existingRows || [])
    .filter(row => !activeKeySet.has(`${row.user_id}:${row.department_id}`))
    .map(row => row.id as string);

  if (staleIds.length > 0) {
    const { error } = await supabase
      .from('user_department_access')
      .update({ is_active: false, updated_at: now })
      .in('id', staleIds);

    if (error) {
      throw error;
    }
  }
}

async function main() {
  const filePath = getArgValue('--file') || DEFAULT_FILE;
  const source = getArgValue('--source') || DEFAULT_SOURCE;
  const apply = hasFlag('--apply');

  console.log(`[import-manager-department-access] mode=${apply ? 'apply' : 'dry-run'} file=${filePath}`);

  const links = await parseWorkbook(filePath);
  const managerCount = new Set(links.map(link => normalizeText(link.manager_name))).size;
  const uniqueBrigadesCount = new Set(links.map(link => normalizeText(link.brigade_name))).size;
  const multiManagerCount = new Map<string, number>();
  for (const link of links) {
    const key = normalizeText(link.manager_name);
    multiManagerCount.set(key, (multiManagerCount.get(key) || 0) + 1);
  }
  const managerWithMultipleBrigades = [...multiManagerCount.values()].filter(count => count > 1).length;

  const { resolvedPairs, issues } = resolveMatches({
    links,
    profileIndex: await loadProfileMatchIndex(),
    departmentIndex: await loadDepartmentMatchIndex(),
  });

  console.log(`[summary] managers=${managerCount} links=${links.length} unique_brigades=${uniqueBrigadesCount} multi_brigade_managers=${managerWithMultipleBrigades}`);
  console.log(`[summary] resolved_pairs=${resolvedPairs.length} issues=${issues.length}`);

  if (issues.length > 0) {
    console.log('[issues]');
    for (const issue of issues) {
      const suffix = issue.candidates?.length ? ` candidates=${issue.candidates.join(' | ')}` : '';
      console.log(`- ${issue.kind}:${issue.type} row=${issue.row_number} value="${issue.source_value}"${suffix}`);
    }
  }

  if (!apply) {
    console.log('[done] dry-run completed');
    return;
  }

  if (issues.length > 0) {
    throw new Error('Найдены unmatched/ambiguous строки. Исправьте матчинги и повторите --apply.');
  }

  await applyPairs(resolvedPairs, source);
  console.log(`[done] apply completed source=${source} active_pairs=${resolvedPairs.length}`);
}

void main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[import-manager-department-access] error:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
