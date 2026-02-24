import { sigurService } from './sigur.service.js';
import { supabase } from '../config/database.js';
import { encryptionService } from './encryption.service.js';
import { parseFIO } from '../utils/fio.utils.js';

/** Системные папки Sigur — больше не фильтруем, синхронизируем все */
const SIGUR_SYSTEM_DEPARTMENTS: string[] = [];

function isSystemDepartment(name: string): boolean {
  return SIGUR_SYSTEM_DEPARTMENTS.includes(name.toLowerCase().trim());
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
): Promise<ISyncOrganizationsResult> {
  if (!sigurService.isConfigured()) throw new Error('Sigur не настроен');

  const departments = await sigurService.getDepartments(connection) as Record<string, unknown>[];
  if (!departments || departments.length === 0) {
    return { imported: 0, skipped: 0, total: 0 };
  }

  const { data: existingOrgs } = await supabase
    .from('organizations')
    .select('id, name_encrypted');

  const existingNames = new Set<string>();
  for (const org of existingOrgs || []) {
    if (org.name_encrypted) {
      existingNames.add(encryptionService.decrypt(org.name_encrypted).toLowerCase().trim());
    }
  }

  let imported = 0;
  let skipped = 0;

  for (const dept of departments) {
    const name = (dept.name as string) || (dept.title as string) || '';
    if (!name.trim()) { skipped++; continue; }

    if (existingNames.has(name.toLowerCase().trim())) {
      skipped++;
      continue;
    }

    const { error: insertError } = await supabase
      .from('organizations')
      .insert({ name_encrypted: encryptionService.encrypt(name.trim()) });

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
    .select('id, name_encrypted, created_at')
    .order('created_at', { ascending: true });

  if (!allOrgs || allOrgs.length === 0) {
    return { duplicatesRemoved: 0, totalBefore: 0, totalAfter: 0, errors: [] };
  }

  const groups = new Map<string, typeof allOrgs>();
  for (const org of allOrgs) {
    const name = org.name_encrypted
      ? encryptionService.decrypt(org.name_encrypted).toLowerCase().trim()
      : '';
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
): Promise<ISyncDepartmentsResult> {
  if (!sigurService.isConfigured()) throw new Error('Sigur не настроен');

  const departments = await sigurService.getDepartments(connection) as Record<string, unknown>[];
  if (!departments || departments.length === 0) {
    return { imported: 0, updated: 0, skipped: 0, filtered: 0, total: 0, parentLinksSet: 0, errors: [] };
  }

  console.log(`[syncDepartments] got ${departments.length} departments from Sigur`);

  const { data: existingDepts } = await supabase
    .from('org_departments')
    .select('id, sigur_department_id, name_encrypted')
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
    if (!d.name_encrypted) return false;
    try {
      return encryptionService.decrypt(d.name_encrypted).trim() === ROOT_DEPT_NAME;
    } catch { return false; }
  });

  if (existingRoot) {
    rootDeptId = existingRoot.id;
  } else {
    const { data: createdRoot, error: rootError } = await supabase
      .from('org_departments')
      .insert({
        organization_id: organizationId,
        name_encrypted: encryptionService.encrypt(ROOT_DEPT_NAME),
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
    if (isSystemDepartment((dept.name as string) || '')) {
      systemIds.add(dept.id as number);
      filteredSigurIds.add(dept.id as number);
    }
  }
  // Каскадно добавляем потомков системных отделов
  let changed = true;
  while (changed) {
    changed = false;
    for (const dept of departments) {
      const sigurId = dept.id as number;
      const parentId = dept.parentId as number | null | undefined;
      if (!filteredSigurIds.has(sigurId) && parentId && filteredSigurIds.has(parentId)) {
        filteredSigurIds.add(sigurId);
        changed = true;
      }
    }
  }

  // Pass 1: Upsert отделов (без parent_id)
  const sigurToDbMap = new Map<number, string>();
  for (const [sigurId, dbId] of sigurIdToDbId) {
    sigurToDbMap.set(sigurId, dbId);
  }

  for (const dept of departments) {
    const name = (dept.name as string) || '';
    const sigurId = dept.id as number;

    if (!name.trim()) { skipped++; continue; }

    if (filteredSigurIds.has(sigurId)) {
      filtered++;
      continue;
    }

    if (sigurIdToDbId.has(sigurId)) {
      const dbId = sigurIdToDbId.get(sigurId)!;
      const { error: updateError } = await supabase
        .from('org_departments')
        .update({ name_encrypted: encryptionService.encrypt(name.trim()) })
        .eq('id', dbId);

      if (updateError) {
        errors.push(`update ${name}: ${updateError.message}`);
      } else {
        updated++;
      }
      sigurToDbMap.set(sigurId, dbId);
    } else {
      const { data: created, error: insertError } = await supabase
        .from('org_departments')
        .insert({
          organization_id: organizationId,
          name_encrypted: encryptionService.encrypt(name.trim()),
          sigur_department_id: sigurId,
        })
        .select('id')
        .single();

      if (insertError) {
        errors.push(`insert ${name}: ${insertError.message}`);
      } else {
        imported++;
        sigurToDbMap.set(sigurId, created.id);
      }
    }
  }

  // Pass 2: Проставляем parent_id связи
  let parentLinksSet = 0;
  for (const dept of departments) {
    const sigurId = dept.id as number;
    const parentSigurId = dept.parentId as number | null | undefined;

    if (!sigurToDbMap.has(sigurId)) continue;
    if (filteredSigurIds.has(sigurId)) continue;

    const dbId = sigurToDbMap.get(sigurId)!;
    let parentDbId: string | null;

    if (!parentSigurId || parentSigurId === 0) {
      // Корневой отдел в Sigur (parentId=0/null) → привязываем к «Объект»
      parentDbId = rootDeptId;
    } else {
      parentDbId = sigurToDbMap.get(parentSigurId) || null;
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
): Promise<ISyncPositionsFromSigurResult> {
  if (!sigurService.isConfigured()) throw new Error('Sigur не настроен');

  const sigurPositions = await sigurService.getPositions(connection);
  if (!sigurPositions || sigurPositions.length === 0) {
    return { imported: 0, updated: 0, skipped: 0, total: 0, errors: [] };
  }

  console.log(`[syncPositionsFromSigur] got ${sigurPositions.length} positions from Sigur`);

  const { data: existingPositions } = await supabase
    .from('positions')
    .select('id, sigur_position_id, name_encrypted')
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
        .update({ name_encrypted: encryptionService.encrypt(name.trim()) })
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
          name_encrypted: encryptionService.encrypt(name.trim()),
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
    .select('id, name_encrypted')
    .eq('organization_id', organizationId);

  const existingNames = new Set<string>();
  for (const pos of existing || []) {
    if (pos.name_encrypted) {
      existingNames.add(encryptionService.decrypt(pos.name_encrypted).toLowerCase().trim());
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
        name_encrypted: encryptionService.encrypt(pos.name),
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
): Promise<ISyncEmployeesResult> {
  if (!sigurService.isConfigured()) throw new Error('Sigur не настроен');

  const sigurEmployees = await sigurService.getEmployeesCached(connection);
  console.log('[syncEmployees] got', sigurEmployees.length, 'employees from Sigur');

  if (sigurEmployees.length === 0) {
    return { imported: 0, updated: 0, skipped: 0, total: 0, errors: [] };
  }

  const { data: existingEmps } = await supabase
    .from('employees')
    .select('id, sigur_employee_id, employment_status, department_locked')
    .eq('organization_id', organizationId)
    .not('sigur_employee_id', 'is', null);

  const sigurIdToDbId = new Map<number, number>();
  const firedSigurIds = new Set<number>();
  const lockedDeptSigurIds = new Set<number>();
  for (const e of existingEmps || []) {
    if (e.sigur_employee_id != null) {
      sigurIdToDbId.set(e.sigur_employee_id, e.id);
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
    .select('id, name_encrypted')
    .eq('organization_id', organizationId);

  const posNameToDbId = new Map<string, string>();
  for (const p of allDbPositions || []) {
    if (p.name_encrypted) {
      const name = encryptionService.decrypt(p.name_encrypted).toLowerCase().trim();
      if (name && !posNameToDbId.has(name)) posNameToDbId.set(name, p.id);
    }
  }

  let imported = 0;
  let updated = 0;
  let skipped = 0;
  const errors: string[] = [];
  const inserts: Record<string, unknown>[] = [];

  for (const emp of sigurEmployees) {
    const fullName = (emp.name as string) || '';
    if (!fullName.trim()) { skipped++; continue; }

    const sigurEmpId = emp.id as number | undefined;

    // Пропускаем уволенных сотрудников
    if (sigurEmpId && firedSigurIds.has(sigurEmpId)) { skipped++; continue; }

    const sigurDeptId = emp.departmentId as number | undefined;
    const orgDepartmentId = sigurDeptId ? sigurDeptToDbId.get(sigurDeptId) || null : null;
    const sigurPosId = emp.positionId as number | undefined;
    const positionText = ((emp.position as string) || '').trim();

    let positionId: string | null = null;

    // 1) FK-маппинг через sigur_position_id
    if (sigurPosId) {
      positionId = sigurPosToDbId.get(sigurPosId) || null;
    }

    // 2) Текстовый матчинг по имени должности
    if (!positionId && positionText) {
      const posKey = positionText.toLowerCase();
      positionId = posNameToDbId.get(posKey) || null;

      // 3) Создаём новую должность если нет совпадения
      if (!positionId) {
        const { data: created, error: createErr } = await supabase
          .from('positions')
          .insert({
            organization_id: organizationId,
            name_encrypted: encryptionService.encrypt(positionText),
            category: 'other' as const,
          })
          .select('id')
          .single();

        if (!createErr && created) {
          positionId = created.id;
          posNameToDbId.set(posKey, created.id);
        }
      }
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
        const { error: updateError } = await supabase
          .from('employees')
          .update(updateFields)
          .eq('id', dbId);
        if (!updateError) updated++;
        else errors.push(`update ${fullName}: ${updateError.message}`);
      } else {
        skipped++;
      }
      continue;
    }

    const fio = parseFIO(fullName);

    inserts.push({
      organization_id: organizationId,
      full_name_encrypted: encryptionService.encrypt(fullName.trim()),
      last_name_encrypted: encryptionService.encrypt(fio.lastName),
      first_name_encrypted: fio.firstName ? encryptionService.encrypt(fio.firstName) : null,
      middle_name_encrypted: fio.middleName ? encryptionService.encrypt(fio.middleName) : null,
      hire_date_encrypted: encryptionService.encrypt(new Date().toISOString().slice(0, 10)),
      sigur_employee_id: sigurEmpId || null,
      org_department_id: orgDepartmentId,
      position_id: positionId,
    });
  }

  console.log('[syncEmployees] prepared', inserts.length, 'inserts');

  const BATCH_SIZE = 100;
  for (let i = 0; i < inserts.length; i += BATCH_SIZE) {
    const batch = inserts.slice(i, i + BATCH_SIZE);
    const { error: insertError } = await supabase.from('employees').insert(batch);
    if (insertError) {
      errors.push(`Ошибка вставки батча ${i / BATCH_SIZE + 1}: ${insertError.message}`);
    } else {
      imported += batch.length;
    }
  }

  console.log(`[syncEmployees] done: ${imported} imported, ${updated} updated, ${skipped} skipped`);
  return { imported, updated, skipped, total: sigurEmployees.length, errors };
}
