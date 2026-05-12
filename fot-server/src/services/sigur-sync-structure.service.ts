import { sigurService } from './sigur.service.js';
import { query, queryOne, execute } from '../config/postgres.js';
import {
  expandDepartmentIdsToAncestors,
  getDepartmentsRaw,
  getWhitelistedDepartmentIdsCached,
  isSystemDepartment,
  logSampleAndWarn,
  normalizeDepartment,
  normalizeDepartmentLookupName,
  type ISyncContext,
} from './sigur-sync-shared.js';
import { invalidateOrgStructureCaches } from './employee-mapper.service.js';
import { detectDepartmentKindFromName } from '../utils/department-kind.utils.js';

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

interface IExistingDepartmentRow {
  id: string;
  sigur_department_id: number | null;
  name: string | null;
}

function buildReusableDepartmentNameMap(
  existingDepartments: IExistingDepartmentRow[],
  currentSigurDepartmentIds: Set<number>,
  rootDepartmentName: string,
): Map<string, IExistingDepartmentRow[]> {
  const byName = new Map<string, IExistingDepartmentRow[]>();

  for (const department of existingDepartments) {
    const normalizedName = normalizeDepartmentLookupName(department.name);
    if (!normalizedName || normalizedName === normalizeDepartmentLookupName(rootDepartmentName)) {
      continue;
    }

    const hasCurrentSigurBinding = department.sigur_department_id != null
      && currentSigurDepartmentIds.has(department.sigur_department_id);
    if (hasCurrentSigurBinding) {
      continue;
    }

    const bucket = byName.get(normalizedName) || [];
    bucket.push(department);
    byName.set(normalizedName, bucket);
  }

  return byName;
}

// ─── Чистые функции синхронизации ───

export async function syncDepartmentsLogic(
  connection?: 'external' | 'internal',
  context?: ISyncContext,
): Promise<ISyncDepartmentsResult> {
  if (!(await sigurService.isConfigured())) throw new Error('Sigur не настроен');

  const rawDepartments = await getDepartmentsRaw(connection, context);
  if (!rawDepartments || rawDepartments.length === 0) {
    return { imported: 0, updated: 0, skipped: 0, filtered: 0, total: 0, parentLinksSet: 0, errors: [] };
  }

  console.log(`[syncDepartments] got ${rawDepartments.length} departments from Sigur`);
  if (rawDepartments.length > 0) {
    logSampleAndWarn('syncDepartments', rawDepartments[0], ['id', 'name', 'parentId']);
  }

  const departments = rawDepartments.map(normalizeDepartment);
  const currentSigurDepartmentIds = new Set<number>(departments.map(dept => dept.id));
  const ROOT_DEPT_NAME = 'Объект';

  const existingDepts = await query<IExistingDepartmentRow>(
    'SELECT id, sigur_department_id, name FROM org_departments',
  );

  const typedExistingDepts = existingDepts;

  const sigurIdToDbId = new Map<number, string>();
  for (const d of typedExistingDepts) {
    if (d.sigur_department_id != null) {
      sigurIdToDbId.set(d.sigur_department_id, d.id);
    }
  }
  const reusableDepartmentsByName = buildReusableDepartmentNameMap(
    typedExistingDepts,
    currentSigurDepartmentIds,
    ROOT_DEPT_NAME,
  );

  let imported = 0;
  let updated = 0;
  let skipped = 0;
  let filtered = 0;
  const errors: string[] = [];

  // Создаём/находим корневой отдел «Объект» (виртуальный корень Sigur, не возвращается API)
  let rootDeptId: string | null = null;

  const existingRoot = typedExistingDepts.find(d => {
    return (d.name || '').trim() === ROOT_DEPT_NAME;
  });

  if (existingRoot) {
    rootDeptId = existingRoot.id;
  } else {
    try {
      const createdRoot = await queryOne<{ id: string }>(
        `INSERT INTO org_departments (name, parent_id, kind)
         VALUES ($1, NULL, 'object')
         RETURNING id`,
        [ROOT_DEPT_NAME],
      );
      if (createdRoot) {
        rootDeptId = createdRoot.id;
        imported++;
        console.log(`[syncDepartments] created root department «${ROOT_DEPT_NAME}» id=${rootDeptId}`);
      } else {
        errors.push(`create root «${ROOT_DEPT_NAME}»: no rows returned`);
      }
    } catch (rootError) {
      errors.push(`create root «${ROOT_DEPT_NAME}»: ${(rootError as Error).message}`);
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
      try {
        await execute('UPDATE org_departments SET name = $1 WHERE id = $2', [dept.name, dbId]);
        updated++;
      } catch (updateError) {
        errors.push(`update ${dept.name}: ${(updateError as Error).message}`);
      }
      sigurToDbMap.set(dept.id, dbId);
    } else {
      const reusableKey = normalizeDepartmentLookupName(dept.name);
      const reusableCandidates = reusableDepartmentsByName.get(reusableKey) || [];

      if (reusableCandidates.length === 1) {
        const reusableDepartment = reusableCandidates[0];
        try {
          await execute(
            'UPDATE org_departments SET name = $1, sigur_department_id = $2 WHERE id = $3',
            [dept.name, dept.id, reusableDepartment.id],
          );
          updated++;
          sigurIdToDbId.set(dept.id, reusableDepartment.id);
          sigurToDbMap.set(dept.id, reusableDepartment.id);
          reusableDepartmentsByName.delete(reusableKey);
        } catch (reuseError) {
          errors.push(`rebind ${dept.name}: ${(reuseError as Error).message}`);
        }
        continue;
      }

      try {
        const created = await queryOne<{ id: string }>(
          `INSERT INTO org_departments (name, sigur_department_id, kind)
           VALUES ($1, $2, $3)
           RETURNING id`,
          [dept.name, dept.id, detectDepartmentKindFromName(dept.name)],
        );
        if (created) {
          imported++;
          sigurToDbMap.set(dept.id, created.id);
        }
      } catch (insertError) {
        errors.push(`insert ${dept.name}: ${(insertError as Error).message}`);
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

    try {
      await execute('UPDATE org_departments SET parent_id = $1 WHERE id = $2', [parentDbId, dbId]);
      parentLinksSet++;
    } catch {
      // игнорируем ошибки связывания parent_id — суммируем только успешные
    }
  }

  console.log(`[syncDepartments] done: ${imported} imported, ${updated} updated, ${skipped} skipped, ${filtered} filtered, ${parentLinksSet} parent links`);
  // Sync структуры из Sigur меняет и имена (employee-mapper), и иерархию
  // (dept tree), и whitelist sync-фильтра — инвалидируем все три согласованно.
  invalidateOrgStructureCaches();
  return { imported, updated, skipped, filtered, total: departments.length, parentLinksSet, errors };
}
