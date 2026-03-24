import { sigurService } from './sigur.service.js';
import { supabase } from '../config/database.js';
import {
  getDepartmentsRaw,
  getWhitelistedDepartmentIdsCached,
  isSystemDepartment,
  logSampleAndWarn,
  normalizeDepartment,
  type ISyncContext,
} from './sigur-sync-shared.js';

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
