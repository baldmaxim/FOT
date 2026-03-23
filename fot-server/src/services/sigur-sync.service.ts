import { sigurService } from './sigur.service.js';
import { supabase } from '../config/database.js';
import { parseFIO } from '../utils/fio.utils.js';
import { mapSigurEvent } from '../utils/sigur.mapper.js';
import { computeDedupHash } from '../utils/dedup.utils.js';
import { buildInclusiveDateRange } from '../utils/date.utils.js';

/** Системные папки Sigur — больше не фильтруем, синхронизируем все */
const SIGUR_SYSTEM_DEPARTMENTS: string[] = [];

// ─── Нормализация полей Sigur API ───

/** Ищет значение среди возможных имён поля (с case-insensitive fallback) */
function resolveField<T = unknown>(
  obj: Record<string, unknown>,
  ...candidates: string[]
): T | undefined {
  for (const key of candidates) {
    if (obj[key] !== undefined) return obj[key] as T;
  }
  const lowerMap = new Map<string, string>();
  for (const k of Object.keys(obj)) {
    lowerMap.set(k.toLowerCase(), k);
  }
  for (const key of candidates) {
    const actualKey = lowerMap.get(key.toLowerCase());
    if (actualKey && obj[actualKey] !== undefined) return obj[actualKey] as T;
  }
  return undefined;
}

interface INormalizedDept {
  id: number;
  name: string;
  parentId: number | null;
}

function normalizeDepartment(raw: Record<string, unknown>): INormalizedDept {
  return {
    id: resolveField<number>(raw, 'id', 'ID', 'Id') ?? 0,
    name: (resolveField<string>(raw, 'name', 'title', 'NAME', 'Name', 'Title') ?? '').trim(),
    parentId: resolveField<number | null>(raw, 'parentId', 'parentDepartmentId', 'parent_id', 'PARENTID', 'ParentId') ?? null,
  };
}

interface INormalizedEmployee {
  id: number | undefined;
  name: string;
  departmentId: number | undefined;
  positionId: number | undefined;
  position: string;
}

function normalizeEmployee(raw: Record<string, unknown>): INormalizedEmployee {
  return {
    id: resolveField<number>(raw, 'id', 'ID', 'Id'),
    name: (resolveField<string>(raw, 'name', 'NAME', 'Name', 'fullName', 'full_name') ?? '').trim(),
    departmentId: resolveField<number>(raw, 'departmentId', 'department_id', 'DEPARTMENTID', 'DepartmentId'),
    positionId: resolveField<number>(raw, 'positionId', 'position_id', 'POSITIONID', 'PositionId'),
    position: (resolveField<string>(raw, 'position', 'positionName', 'position_name', 'POSITION', 'jobTitle') ?? '').trim(),
  };
}

/** Логирует образец данных и предупреждает о несовпадении полей */
function logSampleAndWarn(label: string, sample: Record<string, unknown>, expectedFields: string[]) {
  const keys = Object.keys(sample);
  console.log(`[${label}] SAMPLE keys: [${keys.join(', ')}]`);
  console.log(`[${label}] SAMPLE data:`, JSON.stringify(sample, null, 2));
  const missing = expectedFields.filter(f => sample[f] === undefined);
  if (missing.length > 0) {
    console.warn(`[${label}] WARNING: expected fields missing: [${missing.join(', ')}]. Available: [${keys.join(', ')}]`);
  }
}

function isSystemDepartment(name: string): boolean {
  return SIGUR_SYSTEM_DEPARTMENTS.includes(name.toLowerCase().trim());
}

/** Загружает whitelist отделов из skud_sync_department_filter. null = фильтр не задан (синхронизировать все) */
export async function getWhitelistedDepartmentIds(organizationId: string): Promise<Set<number> | null> {
  const { data } = await supabase
    .from('skud_sync_department_filter')
    .select('sigur_department_id')
    .eq('organization_id', organizationId);

  if (!data || data.length === 0) return null;
  return new Set(data.map(d => d.sigur_department_id));
}

export const SYNC_ALL_STEP_ORDER = [
  'organizations',
  'clean-duplicates',
  'departments',
  'positions',
  'employees',
] as const;

export type SyncAllStepName = typeof SYNC_ALL_STEP_ORDER[number];

interface IWhitelistedEmployeesCache {
  data: Record<string, unknown>[];
  allowedNames: Set<string>;
  allowedSigurIds: Set<number>;
}

export interface ISyncContext {
  departmentsRaw?: Record<string, unknown>[];
  positionsRaw?: Record<string, unknown>[] | null;
  whitelistDepartmentIds?: Set<number> | null;
  whitelistedSigurEmployees?: IWhitelistedEmployeesCache | null;
}

async function getDepartmentsRaw(
  connection?: 'external' | 'internal',
  context?: ISyncContext,
): Promise<Record<string, unknown>[]> {
  if (context?.departmentsRaw) {
    return context.departmentsRaw;
  }

  const departments = await sigurService.getDepartments(connection) as Record<string, unknown>[];
  if (context) {
    context.departmentsRaw = departments;
  }
  return departments;
}

async function getPositionsRaw(
  connection?: 'external' | 'internal',
  context?: ISyncContext,
): Promise<Record<string, unknown>[] | null> {
  if (context && context.positionsRaw !== undefined) {
    return context.positionsRaw;
  }

  const positions = await sigurService.getPositions(connection);
  if (context) {
    context.positionsRaw = positions;
  }
  return positions;
}

async function getWhitelistedDepartmentIdsCached(
  organizationId: string,
  context?: ISyncContext,
): Promise<Set<number> | null> {
  if (context && context.whitelistDepartmentIds !== undefined) {
    return context.whitelistDepartmentIds;
  }

  const whitelist = await getWhitelistedDepartmentIds(organizationId);
  if (context) {
    context.whitelistDepartmentIds = whitelist;
  }
  return whitelist;
}

function buildWhitelistedEmployeesCache(data: Record<string, unknown>[]): IWhitelistedEmployeesCache {
  const allowedNames = new Set<string>();
  const allowedSigurIds = new Set<number>();

  for (const emp of data) {
    const name = ((emp.name as string) || '').toLowerCase().trim();
    if (name) {
      allowedNames.add(name);
    }
    if (typeof emp.id === 'number') {
      allowedSigurIds.add(emp.id);
    }
  }

  return { data, allowedNames, allowedSigurIds };
}

async function getWhitelistedDbEmployeeSets(
  organizationId: string,
  whitelist: Set<number>,
): Promise<{ allowedNames: Set<string>; allowedSigurIds: Set<number> } | null> {
  const { data: dbDepartments } = await supabase
    .from('org_departments')
    .select('id, sigur_department_id')
    .eq('organization_id', organizationId)
    .in('sigur_department_id', [...whitelist]);

  const allowedDepartmentIds = (dbDepartments || []).map(dept => dept.id);
  if (allowedDepartmentIds.length === 0) {
    return null;
  }

  const { data: employees } = await supabase
    .from('employees')
    .select('full_name, sigur_employee_id')
    .eq('organization_id', organizationId)
    .eq('is_archived', false)
    .in('org_department_id', allowedDepartmentIds);

  const allowedNames = new Set<string>();
  const allowedSigurIds = new Set<number>();

  for (const employee of employees || []) {
    const name = (employee.full_name || '').toLowerCase().trim();
    if (name) {
      allowedNames.add(name);
    }
    if (employee.sigur_employee_id != null) {
      allowedSigurIds.add(employee.sigur_employee_id);
    }
  }

  return { allowedNames, allowedSigurIds };
}

async function getWhitelistedSigurEmployees(
  organizationId: string,
  connection: 'external' | 'internal' | undefined,
  context?: ISyncContext,
  onProgress?: (data: Record<string, unknown>) => void,
): Promise<Record<string, unknown>[]> {
  const send = onProgress || (() => {});
  const whitelist = await getWhitelistedDepartmentIdsCached(organizationId, context);

  if (!whitelist || whitelist.size === 0) {
    return sigurService.getEmployeesCached(connection);
  }

  if (context?.whitelistedSigurEmployees?.data) {
    send({
      type: 'employees_progress',
      current: whitelist.size,
      total: whitelist.size,
      percent: 100,
      status: `Using whitelist cache: ${context.whitelistedSigurEmployees.data.length} employees`,
    });
    return context.whitelistedSigurEmployees.data;
  }

  try {
    send({
      type: 'employees_progress',
      current: 0,
      total: whitelist.size,
      percent: 5,
      status: 'Loading all employees once and filtering locally...',
    });

    const allEmployees = await sigurService.getEmployeesCached(connection);
    const filteredEmployees = allEmployees.filter(emp => {
      const normalized = normalizeEmployee(emp);
      return normalized.departmentId != null && whitelist.has(normalized.departmentId);
    });

    if (filteredEmployees.length > 0 || allEmployees.length === 0) {
      if (context) {
        context.whitelistedSigurEmployees = buildWhitelistedEmployeesCache(filteredEmployees);
      }
      send({
        type: 'employees_progress',
        current: whitelist.size,
        total: whitelist.size,
        percent: 100,
        status: `Filtered ${filteredEmployees.length} employees from ${allEmployees.length}`,
      });
      return filteredEmployees;
    }
  } catch (error) {
    console.warn('[syncEmployees] full employee fetch failed, falling back to department scan:', (error as Error).message);
  }

  send({
    type: 'employees_progress',
    current: 0,
    total: whitelist.size,
    percent: 0,
    status: `Loading by ${whitelist.size} departments...`,
  });

  const sigurEmployeesRaw = await sigurService.getEmployeesByDepartments(
    [...whitelist],
    connection,
    (loaded, deptIdx, totalDepts) => {
      send({
        type: 'employees_progress',
        current: deptIdx,
        total: totalDepts,
        percent: Math.round((deptIdx / totalDepts) * 100),
        status: `Departments loaded: ${deptIdx}/${totalDepts} (${loaded} employees)`,
      });
    },
  );

  if (context) {
    context.whitelistedSigurEmployees = buildWhitelistedEmployeesCache(sigurEmployeesRaw);
  }

  return sigurEmployeesRaw;
}

// ─── Типы результатов ───

export interface ISyncOrganizationsResult {
  imported: number;
  skipped: number;
  total: number;
}

export interface ICleanDuplicatesResult {
  totalBefore: number;
  totalAfter: number;
  duplicatesRemoved: number;
  errors: string[];
}

export interface ISyncDepartmentsResult {
  imported: number;
  updated: number;
  skipped: number;
  filtered: number;
  total: number;
  parentLinksSet: number;
  errors: string[];
}

export interface ISeedPositionsResult {
  created: number;
  skipped: number;
  total: number;
}

export interface ISyncPositionsFromSigurResult {
  imported: number;
  updated: number;
  skipped: number;
  total: number;
  errors: string[];
}

export interface ISyncEmployeesResult {
  imported: number;
  updated: number;
  skipped: number;
  total: number;
  errors: string[];
}

// ─── Чистые функции синхронизации ───

export async function syncOrganizationsLogic(
  connection?: 'external' | 'internal',
  context?: ISyncContext,
): Promise<ISyncOrganizationsResult> {
  if (!sigurService.isConfigured()) throw new Error('Sigur не настроен');

  const departments = await getDepartmentsRaw(connection, context);
  if (!departments || departments.length === 0) {
    return { imported: 0, skipped: 0, total: 0 };
  }

  if (departments.length > 0) {
    logSampleAndWarn('syncOrganizations', departments[0], ['id', 'name', 'parentId']);
  }

  const { data: existingOrgs } = await supabase
    .from('organizations')
    .select('id, name');

  const existingNames = new Set<string>();
  for (const org of existingOrgs || []) {
    if (org.name) {
      existingNames.add(org.name.toLowerCase().trim());
    }
  }

  let imported = 0;
  let skipped = 0;

  for (const dept of departments) {
    const normalized = normalizeDepartment(dept);
    const name = normalized.name;
    if (!name) { skipped++; continue; }

    if (existingNames.has(name.toLowerCase().trim())) {
      skipped++;
      continue;
    }

    const { error: insertError } = await supabase
      .from('organizations')
      .insert({ name: name.trim() });

    if (insertError) {
      console.error('[syncOrganizations] insert error:', insertError.message);
      skipped++;
    } else {
      existingNames.add(name.toLowerCase().trim());
      imported++;
    }
  }

  console.log(`[syncOrganizations] done: ${imported} imported, ${skipped} skipped`);
  return { imported, skipped, total: departments.length };
}

export async function cleanDuplicateOrganizationsLogic(): Promise<ICleanDuplicatesResult> {
  const { data: allOrgs } = await supabase
    .from('organizations')
    .select('id, name, created_at')
    .order('created_at', { ascending: true });

  if (!allOrgs || allOrgs.length === 0) {
    return { duplicatesRemoved: 0, totalBefore: 0, totalAfter: 0, errors: [] };
  }

  const groups = new Map<string, typeof allOrgs>();
  for (const org of allOrgs) {
    const name = (org.name || '').toLowerCase().trim();
    if (!name) continue;
    const existing = groups.get(name) || [];
    existing.push(org);
    groups.set(name, existing);
  }

  const remapEntries: { dupId: string; keepId: string }[] = [];
  const allDuplicateIds: string[] = [];

  for (const [, orgs] of groups) {
    if (orgs.length <= 1) continue;
    const keepId = orgs[0].id;
    for (let i = 1; i < orgs.length; i++) {
      remapEntries.push({ dupId: orgs[i].id, keepId });
      allDuplicateIds.push(orgs[i].id);
    }
  }

  if (allDuplicateIds.length === 0) {
    return { duplicatesRemoved: 0, totalBefore: allOrgs.length, totalAfter: allOrgs.length, errors: [] };
  }

  const TABLES_WITH_ORG_ID = [
    'employees', 'org_departments', 'org_sites',
    'positions', 'skud_daily_summary', 'skud_events', 'user_profiles',
  ];

  const errors: string[] = [];
  const keepGroups = new Map<string, string[]>();
  for (const { dupId, keepId } of remapEntries) {
    const list = keepGroups.get(keepId) || [];
    list.push(dupId);
    keepGroups.set(keepId, list);
  }

  for (const table of TABLES_WITH_ORG_ID) {
    for (const [keepId, dupIds] of keepGroups) {
      const { error: updateError } = await supabase
        .from(table)
        .update({ organization_id: keepId })
        .in('organization_id', dupIds);

      if (updateError) {
        errors.push(`${table}: ${updateError.message}`);
      }
    }
  }

  const { error: deleteError } = await supabase
    .from('organizations')
    .delete()
    .in('id', allDuplicateIds);

  let duplicatesRemoved = allDuplicateIds.length;
  if (deleteError) {
    errors.push(`delete batch: ${deleteError.message}`);
    duplicatesRemoved = 0;
  }

  console.log(`[cleanDuplicateOrgs] removed ${duplicatesRemoved} duplicates`);
  return {
    totalBefore: allOrgs.length,
    totalAfter: allOrgs.length - duplicatesRemoved,
    duplicatesRemoved,
    errors,
  };
}

export async function syncDepartmentsLogic(
  organizationId: string,
  connection?: 'external' | 'internal',
  context?: ISyncContext,
): Promise<ISyncDepartmentsResult> {
  if (!sigurService.isConfigured()) throw new Error('Sigur не настроен');

  const rawDepartments = await getDepartmentsRaw(connection, context);
  if (!rawDepartments || rawDepartments.length === 0) {
    return { imported: 0, updated: 0, skipped: 0, filtered: 0, total: 0, parentLinksSet: 0, errors: [] };
  }

  console.log(`[syncDepartments] got ${rawDepartments.length} departments from Sigur`);
  if (rawDepartments.length > 0) {
    logSampleAndWarn('syncDepartments', rawDepartments[0], ['id', 'name', 'parentId']);
  }

  const departments = rawDepartments.map(normalizeDepartment);

  const { data: existingDepts } = await supabase
    .from('org_departments')
    .select('id, sigur_department_id, name')
    .eq('organization_id', organizationId);

  const sigurIdToDbId = new Map<number, string>();
  for (const d of existingDepts || []) {
    if (d.sigur_department_id != null) {
      sigurIdToDbId.set(d.sigur_department_id, d.id);
    }
  }

  let imported = 0;
  let updated = 0;
  let skipped = 0;
  let filtered = 0;
  const errors: string[] = [];

  // Создаём/находим корневой отдел «Объект» (виртуальный корень Sigur, не возвращается API)
  const ROOT_DEPT_NAME = 'Объект';
  let rootDeptId: string | null = null;

  const existingRoot = (existingDepts || []).find(d => {
    return (d.name || '').trim() === ROOT_DEPT_NAME;
  });

  if (existingRoot) {
    rootDeptId = existingRoot.id;
  } else {
    const { data: createdRoot, error: rootError } = await supabase
      .from('org_departments')
      .insert({
        organization_id: organizationId,
        name: ROOT_DEPT_NAME,
        parent_id: null,
      })
      .select('id')
      .single();

    if (rootError) {
      errors.push(`create root «${ROOT_DEPT_NAME}»: ${rootError.message}`);
    } else {
      rootDeptId = createdRoot.id;
      imported++;
      console.log(`[syncDepartments] created root department «${ROOT_DEPT_NAME}» id=${rootDeptId}`);
    }
  }

  // Собираем ID системных отделов и всех их потомков (каскадная фильтрация)
  const filteredSigurIds = new Set<number>();
  const systemIds = new Set<number>();
  for (const dept of departments) {
    if (isSystemDepartment(dept.name)) {
      systemIds.add(dept.id);
      filteredSigurIds.add(dept.id);
    }
  }
  // Каскадно добавляем потомков системных отделов
  let changed = true;
  while (changed) {
    changed = false;
    for (const dept of departments) {
      if (!filteredSigurIds.has(dept.id) && dept.parentId && filteredSigurIds.has(dept.parentId)) {
        filteredSigurIds.add(dept.id);
        changed = true;
      }
    }
  }

  // Whitelist: если задан фильтр, пропускаем отделы вне whitelist
  const whitelist = await getWhitelistedDepartmentIdsCached(organizationId, context);
  if (whitelist) {
    // Расширяем whitelist родительскими отделами для сохранения иерархии
    const parentMap = new Map<number, number>();
    for (const dept of departments) {
      if (dept.parentId) parentMap.set(dept.id, dept.parentId);
    }
    for (const id of [...whitelist]) {
      let current = parentMap.get(id);
      while (current && !whitelist.has(current)) {
        whitelist.add(current);
        current = parentMap.get(current);
      }
    }
    // Добавляем в filteredSigurIds всё, что не в whitelist
    for (const dept of departments) {
      if (!whitelist.has(dept.id)) {
        filteredSigurIds.add(dept.id);
      }
    }
    console.log(`[syncDepartments] whitelist active: ${whitelist.size} departments allowed`);
  }

  // Pass 1: Upsert отделов (без parent_id)
  const sigurToDbMap = new Map<number, string>();
  for (const [sigurId, dbId] of sigurIdToDbId) {
    sigurToDbMap.set(sigurId, dbId);
  }

  for (const dept of departments) {
    if (!dept.name) { skipped++; continue; }

    if (filteredSigurIds.has(dept.id)) {
      filtered++;
      continue;
    }

    if (sigurIdToDbId.has(dept.id)) {
      const dbId = sigurIdToDbId.get(dept.id)!;
      const { error: updateError } = await supabase
        .from('org_departments')
        .update({ name: dept.name })
        .eq('id', dbId);

      if (updateError) {
        errors.push(`update ${dept.name}: ${updateError.message}`);
      } else {
        updated++;
      }
      sigurToDbMap.set(dept.id, dbId);
    } else {
      const { data: created, error: insertError } = await supabase
        .from('org_departments')
        .insert({
          organization_id: organizationId,
          name: dept.name,
          sigur_department_id: dept.id,
        })
        .select('id')
        .single();

      if (insertError) {
        errors.push(`insert ${dept.name}: ${insertError.message}`);
      } else {
        imported++;
        sigurToDbMap.set(dept.id, created.id);
      }
    }
  }

  // Pass 2: Проставляем parent_id связи
  let parentLinksSet = 0;
  for (const dept of departments) {
    if (!sigurToDbMap.has(dept.id)) continue;
    if (filteredSigurIds.has(dept.id)) continue;

    const dbId = sigurToDbMap.get(dept.id)!;
    let parentDbId: string | null;

    if (!dept.parentId || dept.parentId === 0) {
      // Корневой отдел в Sigur (parentId=0/null) → привязываем к «Объект»
      parentDbId = rootDeptId;
    } else {
      parentDbId = sigurToDbMap.get(dept.parentId) || null;
    }

    const { error: linkError } = await supabase
      .from('org_departments')
      .update({ parent_id: parentDbId })
      .eq('id', dbId);

    if (!linkError) parentLinksSet++;
  }

  console.log(`[syncDepartments] done: ${imported} imported, ${updated} updated, ${skipped} skipped, ${filtered} filtered, ${parentLinksSet} parent links`);
  return { imported, updated, skipped, filtered, total: departments.length, parentLinksSet, errors };
}

export async function syncPositionsFromSigurLogic(
  organizationId: string,
  connection?: 'external' | 'internal',
  context?: ISyncContext,
): Promise<ISyncPositionsFromSigurResult> {
  if (!sigurService.isConfigured()) throw new Error('Sigur не настроен');

  const sigurPositions = await getPositionsRaw(connection, context);
  if (!sigurPositions || sigurPositions.length === 0) {
    return { imported: 0, updated: 0, skipped: 0, total: 0, errors: [] };
  }

  console.log(`[syncPositionsFromSigur] got ${sigurPositions.length} positions from Sigur`);

  const { data: existingPositions } = await supabase
    .from('positions')
    .select('id, sigur_position_id, name')
    .eq('organization_id', organizationId);

  const sigurIdToDbId = new Map<number, string>();
  for (const p of existingPositions || []) {
    if (p.sigur_position_id != null) {
      sigurIdToDbId.set(p.sigur_position_id, p.id);
    }
  }

  let imported = 0;
  let updated = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const pos of sigurPositions) {
    const name = (pos.name as string) || '';
    const sigurId = pos.id as number;

    if (!name.trim()) { skipped++; continue; }

    if (sigurIdToDbId.has(sigurId)) {
      const dbId = sigurIdToDbId.get(sigurId)!;
      const { error: updateError } = await supabase
        .from('positions')
        .update({ name: name.trim() })
        .eq('id', dbId);

      if (updateError) {
        errors.push(`update ${name}: ${updateError.message}`);
      } else {
        updated++;
      }
    } else {
      const { error: insertError } = await supabase
        .from('positions')
        .insert({
          organization_id: organizationId,
          name: name.trim(),
          sigur_position_id: sigurId,
          category: 'other',
        });

      if (insertError) {
        errors.push(`insert ${name}: ${insertError.message}`);
      } else {
        imported++;
      }
    }
  }

  console.log(`[syncPositionsFromSigur] done: ${imported} imported, ${updated} updated, ${skipped} skipped`);
  return { imported, updated, skipped, total: sigurPositions.length, errors };
}

export async function seedPositionsLogic(organizationId: string): Promise<ISeedPositionsResult> {
  const SEED_POSITIONS = [
    { name: 'Руководитель строительства', category: 'manager', grade: 50, sort_order: 1 },
    { name: 'Начальник участка', category: 'manager', grade: 40, sort_order: 2 },
    { name: 'Прораб', category: 'engineer', grade: 30, sort_order: 3 },
    { name: 'Бригадир', category: 'worker', grade: 20, sort_order: 4 },
    { name: 'Рабочий', category: 'worker', grade: 10, sort_order: 5 },
    { name: 'Инженер', category: 'engineer', grade: 25, sort_order: 6 },
    { name: 'Сотрудник', category: 'other', grade: 5, sort_order: 7 },
  ];

  const { data: existing } = await supabase
    .from('positions')
    .select('id, name')
    .eq('organization_id', organizationId);

  const existingNames = new Set<string>();
  for (const pos of existing || []) {
    if (pos.name) {
      existingNames.add(pos.name.toLowerCase().trim());
    }
  }

  let created = 0;
  let skipped = 0;

  for (const pos of SEED_POSITIONS) {
    if (existingNames.has(pos.name.toLowerCase().trim())) {
      skipped++;
      continue;
    }

    const { error } = await supabase
      .from('positions')
      .insert({
        organization_id: organizationId,
        name: pos.name,
        category: pos.category,
        grade: pos.grade,
        sort_order: pos.sort_order,
      });

    if (error) {
      console.error(`[seedPositions] error for "${pos.name}":`, error.message);
    } else {
      created++;
    }
  }

  console.log(`[seedPositions] done: ${created} created, ${skipped} skipped`);
  return { created, skipped, total: SEED_POSITIONS.length };
}

export async function syncEmployeesLogic(
  organizationId: string,
  connection?: 'external' | 'internal',
  onProgress?: (data: Record<string, unknown>) => void,
  context?: ISyncContext,
): Promise<ISyncEmployeesResult> {
  if (!sigurService.isConfigured()) throw new Error('Sigur не настроен');

  const send = onProgress || (() => {});
  send({ type: 'employees_progress', current: 0, total: 0, percent: 0 });

  let sigurEmployeesRaw: Record<string, unknown>[];
  const whitelist = await getWhitelistedDepartmentIdsCached(organizationId, context);
  if (whitelist) {
    console.log(`[syncEmployees] whitelist active: ${whitelist.size} departments`);
    sigurEmployeesRaw = await getWhitelistedSigurEmployees(organizationId, connection, context, send);
  } else {
    sigurEmployeesRaw = await sigurService.getEmployeesCached(connection);
  }
  console.log('[syncEmployees] got', sigurEmployeesRaw.length, 'employees from Sigur');

  if (sigurEmployeesRaw.length === 0) {
    return { imported: 0, updated: 0, skipped: 0, total: 0, errors: [] };
  }

  if (sigurEmployeesRaw.length > 0) {
    logSampleAndWarn('syncEmployees', sigurEmployeesRaw[0], ['id', 'name', 'departmentId', 'positionId', 'position']);
  }

  // Все загруженные уже отфильтрованы по whitelist (если он есть)
  const sigurEmployees = sigurEmployeesRaw.map(normalizeEmployee);
  const skippedByWhitelist = 0;
  console.log(`[syncEmployees] employees to process: ${sigurEmployees.length}`);

  // Глобальный поиск по sigur_employee_id (не только в целевой org)
  // чтобы не создавать дубли при синхронизации в другую организацию
  const { data: existingEmps } = await supabase
    .from('employees')
    .select('id, sigur_employee_id, employment_status, department_locked, organization_id')
    .not('sigur_employee_id', 'is', null);

  const sigurIdToDbId = new Map<number, number>();
  const firedSigurIds = new Set<number>();
  const lockedDeptSigurIds = new Set<number>();
  for (const e of existingEmps || []) {
    if (e.sigur_employee_id != null) {
      // Приоритет: сотрудник из целевой организации, иначе первый найденный
      if (!sigurIdToDbId.has(e.sigur_employee_id) || e.organization_id === organizationId) {
        sigurIdToDbId.set(e.sigur_employee_id, e.id);
      }
      if (e.employment_status === 'fired') firedSigurIds.add(e.sigur_employee_id);
      if (e.department_locked) lockedDeptSigurIds.add(e.sigur_employee_id);
    }
  }

  const { data: dbDepartments } = await supabase
    .from('org_departments')
    .select('id, sigur_department_id')
    .eq('organization_id', organizationId)
    .not('sigur_department_id', 'is', null);

  const sigurDeptToDbId = new Map<number, string>();
  for (const d of dbDepartments || []) {
    if (d.sigur_department_id != null) {
      sigurDeptToDbId.set(d.sigur_department_id, d.id);
    }
  }

  const { data: dbPositions } = await supabase
    .from('positions')
    .select('id, sigur_position_id')
    .eq('organization_id', organizationId)
    .not('sigur_position_id', 'is', null);

  const sigurPosToDbId = new Map<number, string>();
  for (const p of dbPositions || []) {
    if (p.sigur_position_id != null) {
      sigurPosToDbId.set(p.sigur_position_id, p.id);
    }
  }

  // Карта имя должности → DB id (для текстового резолва)
  const { data: allDbPositions } = await supabase
    .from('positions')
    .select('id, name')
    .eq('organization_id', organizationId);

  const posNameToDbId = new Map<string, string>();
  for (const p of allDbPositions || []) {
    if (p.name) {
      const name = p.name.toLowerCase().trim();
      if (name && !posNameToDbId.has(name)) posNameToDbId.set(name, p.id);
    }
  }

  let imported = 0;
  let updated = 0;
  let skipped = skippedByWhitelist;
  const errors: string[] = [];
  const inserts: Record<string, unknown>[] = [];

  const totalEmployees = sigurEmployees.length;
  send({ type: 'employees_start', total: totalEmployees });

  // Сначала создаём недостающие должности (батчим по уникальным именам)
  const missingPositions = new Set<string>();
  for (const emp of sigurEmployees) {
    const sigurPosId = emp.positionId;
    const positionText = emp.position;
    if (!positionText) continue;
    let positionId: string | null = null;
    if (sigurPosId) positionId = sigurPosToDbId.get(sigurPosId) || null;
    if (!positionId) {
      const posKey = positionText.toLowerCase();
      if (!posNameToDbId.has(posKey)) missingPositions.add(positionText);
    }
  }

  if (missingPositions.size > 0) {
    send({ type: 'employees_progress', current: 0, total: totalEmployees, percent: 0 });
    const posInserts = [...missingPositions].map(name => ({
      organization_id: organizationId,
      name,
      category: 'other' as const,
    }));
    const POS_BATCH = 100;
    for (let i = 0; i < posInserts.length; i += POS_BATCH) {
      const batch = posInserts.slice(i, i + POS_BATCH);
      const { data: created } = await supabase.from('positions').upsert(batch, { onConflict: 'organization_id,name', ignoreDuplicates: true }).select('id, name');
      for (const p of created || []) {
        if (p.name) posNameToDbId.set(p.name.toLowerCase(), p.id);
      }
    }
  }

  // Собираем обновления и вставки (без DB-запросов в цикле)
  const updates: { id: number; fields: Record<string, unknown>; name: string }[] = [];

  for (let empIdx = 0; empIdx < sigurEmployees.length; empIdx++) {
    const emp = sigurEmployees[empIdx];
    if (empIdx % 200 === 0) {
      send({ type: 'employees_progress', current: empIdx, total: totalEmployees, percent: Math.round((empIdx / totalEmployees) * 100) });
    }
    const fullName = emp.name;
    if (!fullName) { skipped++; continue; }

    const sigurEmpId = emp.id;

    // Пропускаем уволенных сотрудников
    if (sigurEmpId && firedSigurIds.has(sigurEmpId)) { skipped++; continue; }

    const sigurDeptId = emp.departmentId;
    const orgDepartmentId = sigurDeptId ? sigurDeptToDbId.get(sigurDeptId) || null : null;
    const sigurPosId = emp.positionId;
    const positionText = emp.position;

    let positionId: string | null = null;
    if (sigurPosId) positionId = sigurPosToDbId.get(sigurPosId) || null;
    if (!positionId && positionText) {
      positionId = posNameToDbId.get(positionText.toLowerCase()) || null;
    }

    if (sigurEmpId && sigurIdToDbId.has(sigurEmpId)) {
      const dbId = sigurIdToDbId.get(sigurEmpId)!;
      const updateFields: Record<string, unknown> = {};

      // Не обновляем отдел если заблокирован вручную
      if (orgDepartmentId && !(sigurEmpId && lockedDeptSigurIds.has(sigurEmpId))) {
        updateFields.org_department_id = orgDepartmentId;
      }
      if (positionId) updateFields.position_id = positionId;

      if (Object.keys(updateFields).length > 0) {
        updates.push({ id: dbId, fields: updateFields, name: fullName });
      } else {
        skipped++;
      }
      continue;
    }

    const fio = parseFIO(fullName);

    inserts.push({
      organization_id: organizationId,
      full_name: fullName.trim(),
      last_name: fio.lastName,
      first_name: fio.firstName || null,
      middle_name: fio.middleName || null,
      hire_date: new Date().toISOString().slice(0, 10),
      sigur_employee_id: sigurEmpId || null,
      org_department_id: orgDepartmentId,
      position_id: positionId,
    });
  }

  // Батчим обновления (параллельно по 20)
  console.log('[syncEmployees] prepared', updates.length, 'updates,', inserts.length, 'inserts');
  send({ type: 'employees_progress', current: totalEmployees, total: totalEmployees, percent: 95 });

  const UPDATE_CONCURRENCY = 20;
  for (let i = 0; i < updates.length; i += UPDATE_CONCURRENCY) {
    const batch = updates.slice(i, i + UPDATE_CONCURRENCY);
    const results = await Promise.all(
      batch.map(u => supabase.from('employees').update(u.fields).eq('id', u.id))
    );
    for (let j = 0; j < results.length; j++) {
      if (!results[j].error) updated++;
      else errors.push(`update ${batch[j].name}: ${results[j].error!.message}`);
    }
  }

  send({ type: 'employees_progress', current: totalEmployees, total: totalEmployees, percent: 100 });

  const BATCH_SIZE = 100;
  for (let i = 0; i < inserts.length; i += BATCH_SIZE) {
    const batch = inserts.slice(i, i + BATCH_SIZE);
    const { error: insertError } = await supabase.from('employees').insert(batch);
    if (insertError) {
      console.warn(`[syncEmployees] batch ${i / BATCH_SIZE + 1} failed: ${insertError.message}. Fallback to individual inserts.`);
      for (const row of batch) {
        const { error: singleErr } = await supabase.from('employees').insert(row);
        if (singleErr) {
          errors.push(`${(row as Record<string, unknown>).full_name}: ${singleErr.message}`);
        } else {
          imported++;
        }
      }
    } else {
      imported += batch.length;
    }
  }

  console.log(`[syncEmployees] done: ${imported} imported, ${updated} updated, ${skipped} skipped`);
  return { imported, updated, skipped, total: sigurEmployeesRaw.length, errors };
}

export interface ISyncEventsResult {
  sigurTotal: number;
  imported: number;
  skipped: number;
  droppedNoName: number;
  droppedNoOrg: number;
  filteredByDept: number;
  matched: number;
  errors: string[];
}

export async function syncEventsLogic(
  organizationId: string,
  startDate: string,
  endDate: string,
  connection?: 'external' | 'internal',
  onProgress?: (data: Record<string, unknown>) => void,
  context?: ISyncContext,
): Promise<ISyncEventsResult> {
  if (!sigurService.isConfigured()) throw new Error('Sigur не настроен');

  const send = onProgress || (() => {});
  const days = buildInclusiveDateRange(startDate, endDate);

  send({ type: 'events_start', totalDays: days.length });

  // 1. Загружаем сотрудников
  const { data: employeesData } = await supabase
    .from('employees')
    .select('id, organization_id, full_name, sigur_employee_id')
    .eq('is_archived', false);

  const employeeByNameOrg = new Map<string, { id: number; organization_id: string }>();
  const sigurIdMap = new Map<number, { id: number; organization_id: string }>();
  for (const emp of employeesData || []) {
    const name = (emp.full_name || '').toLowerCase().trim();
    const empRef = { id: emp.id, organization_id: emp.organization_id };
    const key = `${name}|${emp.organization_id}`;
    if (!employeeByNameOrg.has(key)) employeeByNameOrg.set(key, empRef);
    if (emp.sigur_employee_id != null) sigurIdMap.set(emp.sigur_employee_id, empRef);
  }

  // 2. Whitelist
  const whitelist = await getWhitelistedDepartmentIdsCached(organizationId, context);
  let allowedNames: Set<string> | null = null;
  let allowedSigurIds: Set<number> | null = null;

  if (whitelist) {
    const dbWhitelistSets = await getWhitelistedDbEmployeeSets(organizationId, whitelist);
    if (dbWhitelistSets && (dbWhitelistSets.allowedNames.size > 0 || dbWhitelistSets.allowedSigurIds.size > 0)) {
      allowedNames = dbWhitelistSets.allowedNames;
      allowedSigurIds = dbWhitelistSets.allowedSigurIds;
      console.log(
        `[syncEvents] whitelist resolved from DB employees: ${allowedNames.size} names, ${allowedSigurIds.size} sigur ids`,
      );
    } else {
      console.log('[syncEvents] whitelist DB cache is empty, falling back to Sigur employees');
      let whitelistCache = context?.whitelistedSigurEmployees || null;
      if (!whitelistCache) {
        const sigurEmployees = await getWhitelistedSigurEmployees(organizationId, connection, context, send);
        whitelistCache = buildWhitelistedEmployeesCache(sigurEmployees);
        if (context) {
          context.whitelistedSigurEmployees = whitelistCache;
        }
      }
      allowedNames = whitelistCache.allowedNames;
      allowedSigurIds = whitelistCache.allowedSigurIds;
    }
  }

  const errors: string[] = [];
  let totalSigur = 0;
  let totalInserted = 0;
  let totalSkipped = 0;
  let totalNoName = 0;
  let totalNoOrg = 0;
  let totalFilteredDept = 0;
  const summariesToUpdate = new Set<string>();

  for (let dayIdx = 0; dayIdx < days.length; dayIdx++) {
    const day = days[dayIdx];
    const dayStart = `${day}T00:00:00`;
    const dayEnd = `${day}T23:59:59`;

    send({
      type: 'events_day',
      day,
      dayIndex: dayIdx,
      totalDays: days.length,
      percent: Math.round((dayIdx / days.length) * 100),
    });

    const rawEvents = await sigurService.getEvents(dayStart, dayEnd, connection, 'PASS_DETECTED', { pageSize: 3000 });
    totalSigur += rawEvents.length;

    if (rawEvents.length === 0) continue;

    const { data: existingEvents } = await supabase
      .from('skud_events')
      .select('dedup_hash')
      .eq('event_date', day)
      .not('dedup_hash', 'is', null);

    const existingSet = new Set<string>();
    for (const evt of existingEvents || []) {
      if (evt.dedup_hash) existingSet.add(evt.dedup_hash);
    }

    const dayInserts: Record<string, unknown>[] = [];

    for (const raw of rawEvents) {
      const mapped = mapSigurEvent(raw as Record<string, unknown>);
      if (!mapped) { totalNoName++; continue; }

      if (allowedNames) {
        const nameKey = mapped.physicalPerson.toLowerCase().trim();
        const sigurEmpId = mapped.employeeId;
        if (!allowedNames.has(nameKey) && !(sigurEmpId && allowedSigurIds?.has(sigurEmpId))) {
          totalFilteredDept++;
          continue;
        }
      }

      const dedupHash = computeDedupHash(
        mapped.physicalPerson, mapped.eventDate, mapped.eventTime,
        mapped.accessPoint, mapped.direction,
      );
      if (existingSet.has(dedupHash)) { totalSkipped++; continue; }
      existingSet.add(dedupHash);

      const nameKey = mapped.physicalPerson.toLowerCase().trim();
      let emp = mapped.employeeId != null ? sigurIdMap.get(mapped.employeeId) : undefined;
      if (!emp) emp = employeeByNameOrg.get(`${nameKey}|${organizationId}`);
      const orgId = emp?.organization_id || organizationId;
      if (!orgId) { totalNoOrg++; continue; }

      dayInserts.push({
        organization_id: orgId,
        physical_person: mapped.physicalPerson,
        card_number: mapped.cardNumber || null,
        event_date: mapped.eventDate,
        event_time: mapped.eventTime,
        access_point: mapped.accessPoint,
        direction: mapped.direction,
        employee_id: emp?.id || null,
        dedup_hash: dedupHash,
      });

      if (emp) summariesToUpdate.add(`${emp.id}:${orgId}:${mapped.eventDate}`);
    }

    const BATCH_SIZE = 500;
    for (let i = 0; i < dayInserts.length; i += BATCH_SIZE) {
      const batch = dayInserts.slice(i, i + BATCH_SIZE);
      const { error: insertError } = await supabase.from('skud_events').upsert(batch, { onConflict: 'dedup_hash', ignoreDuplicates: true });
      if (insertError) {
        errors.push(`[${day}] ${insertError.message}`);
      } else {
        totalInserted += batch.length;
      }
    }
  }

  // Пересчёт сводок
  if (summariesToUpdate.size > 0) {
    send({ type: 'events_summaries', count: summariesToUpdate.size });
    const pairs = [...summariesToUpdate].map(key => {
      const [empId, orgId, date] = key.split(':');
      return { org_id: orgId, emp_id: parseInt(empId, 10), date };
    });
    await supabase.rpc('batch_recalculate_skud_daily_summary', { p_pairs: pairs });
  }

  console.log(`[syncEvents] done: ${totalInserted} imported, ${totalSkipped} skipped, ${totalFilteredDept} filtered`);
  return {
    sigurTotal: totalSigur,
    imported: totalInserted,
    skipped: totalSkipped,
    droppedNoName: totalNoName,
    droppedNoOrg: totalNoOrg,
    filteredByDept: totalFilteredDept,
    matched: summariesToUpdate.size,
    errors,
  };
}
