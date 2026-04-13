import { sigurService } from './sigur.service.js';
import { supabase } from '../config/database.js';
import {
  expandDepartmentIdsToAncestors,
  getDepartmentsRaw,
  getWhitelistedDepartmentIdsCached,
  isSystemDepartment,
  logSampleAndWarn,
  normalizeDepartment,
  type ISyncContext,
} from './sigur-sync-shared.js';
import { invalidateDeptTreeCache } from './skud-shared.service.js';

// ─── Типы результатов ───

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

export async function syncDepartmentsLogic(
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
    .select('id, sigur_department_id, name');

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
  const whitelist = await getWhitelistedDepartmentIdsCached(connection, context);
  if (whitelist) {
    const allowedSigurIds = expandDepartmentIdsToAncestors(new Set(whitelist), departments);

    // Добавляем в filteredSigurIds всё, что не входит в выбранное subtree плюс путь к нему
    for (const dept of departments) {
      if (!allowedSigurIds.has(dept.id)) {
        filteredSigurIds.add(dept.id);
      }
    }
    console.log(
      `[syncDepartments] whitelist active: ${whitelist.size} subtree departments allowed, ${allowedSigurIds.size} with ancestors`,
    );
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
  invalidateDeptTreeCache();
  return { imported, updated, skipped, filtered, total: departments.length, parentLinksSet, errors };
}
