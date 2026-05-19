import { sigurService } from './sigur.service.js';
import { query, queryOne, execute, withTransaction } from '../config/postgres.js';
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
        // ON CONFLICT по партиальному UNIQUE-индексу
        // uniq_org_departments_sigur (миграция 106): если строка с этим
        // sigur_department_id уже есть (а в sigurIdToDbId не попала) — не
        // плодим дубликат, а обновляем имя. Идемпотентность при повторном
        // синке/смене root, чтобы не появлялись осиротевшие копии.
        const created = await queryOne<{ id: string }>(
          `INSERT INTO org_departments (name, sigur_department_id, kind)
           VALUES ($1, $2, $3)
           ON CONFLICT (sigur_department_id) WHERE sigur_department_id IS NOT NULL
           DO UPDATE SET name = EXCLUDED.name
           RETURNING id`,
          [dept.name, dept.id, detectDepartmentKindFromName(dept.name)],
        );
        if (created) {
          imported++;
          sigurIdToDbId.set(dept.id, created.id);
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

  // Sigur при пересоздании компании выдаёт НОВЫЕ sigur-id, whitelist гасит
  // старое поддерево → осиротевшие is_active=false дубликаты с застрявшими
  // сотрудниками. Схлопываем их на одноимённую активную строку, чтобы
  // массовое назначение графика по бригадам никого не теряло.
  try {
    const consolidated = await consolidateDuplicateDepartments();
    if (consolidated.pairs > 0) {
      console.log(`[syncDepartments] consolidated ${consolidated.pairs} duplicate departments, moved ${consolidated.employeesMoved} employees`);
    }
  } catch (consolidateError) {
    errors.push(`consolidate duplicates: ${(consolidateError as Error).message}`);
  }

  // Sync структуры из Sigur меняет и имена (employee-mapper), и иерархию
  // (dept tree), и whitelist sync-фильтра — инвалидируем все три согласованно.
  invalidateOrgStructureCaches();
  return { imported, updated, skipped, filtered, total: departments.length, parentLinksSet, errors };
}

export interface IConsolidateResult {
  /** Сколько пар orphan→canonical схлопнуто. */
  pairs: number;
  /** Сколько активных сотрудников перенесено с осиротевших строк. */
  employeesMoved: number;
}

/**
 * Схлопывает осиротевшие дубликаты org_departments на одноимённую активную
 * строку. Логика ИДЕНТИЧНА docs/migrations/106_dedup_org_departments.sql и
 * fot-server/scripts/diagnose-dup-departments.mjs: для name с РОВНО одной
 * is_active=false строкой (sigur_department_id IS NOT NULL) и РОВНО одной
 * is_active=true строкой — orphan=inactive, canonical=active; переносим все
 * FK с orphan на canonical и удаляем orphan. Неоднозначные имена (>1 активной
 * и т.п.) НЕ трогаем. Идемпотентна, безопасна при 0 дублей.
 */
export async function consolidateDuplicateDepartments(): Promise<IConsolidateResult> {
  return withTransaction(async (client) => {
    await client.query(`
      CREATE TEMP TABLE dept_dedup_map ON COMMIT DROP AS
      WITH dup AS (
        SELECT name FROM org_departments
         GROUP BY name
        HAVING count(*) FILTER (WHERE is_active = false AND sigur_department_id IS NOT NULL) = 1
           AND count(*) FILTER (WHERE is_active = true) = 1
      )
      SELECT orphan.id AS orphan_id, canon.id AS canonical_id
        FROM dup
        JOIN org_departments orphan
          ON orphan.name = dup.name AND orphan.is_active = false AND orphan.sigur_department_id IS NOT NULL
        JOIN org_departments canon
          ON canon.name = dup.name AND canon.is_active = true`);
    await client.query('CREATE INDEX ON dept_dedup_map (orphan_id)');

    const pairs = Number((await client.query('SELECT count(*)::int AS n FROM dept_dedup_map')).rows[0].n);
    if (pairs === 0) return { pairs: 0, employeesMoved: 0 };

    const employeesMoved = Number((await client.query(
      `SELECT count(*)::int AS n FROM employees e JOIN dept_dedup_map m ON m.orphan_id = e.org_department_id
        WHERE e.is_archived = false AND e.excluded_from_timesheet = false AND e.employment_status <> 'fired'`,
    )).rows[0].n);

    // Плоские репоинты (UNIQUE только на id → конфликт по колонке отдела невозможен).
    const flat = [
      `UPDATE employees t SET org_department_id = m.canonical_id FROM dept_dedup_map m WHERE t.org_department_id = m.orphan_id`,
      `UPDATE employee_assignments t SET org_department_id = m.canonical_id FROM dept_dedup_map m WHERE t.org_department_id = m.orphan_id`,
      `UPDATE contractor_submissions t SET org_department_id = m.canonical_id FROM dept_dedup_map m WHERE t.org_department_id = m.orphan_id`,
      `UPDATE contractor_org_access t SET org_department_id = m.canonical_id FROM dept_dedup_map m WHERE t.org_department_id = m.orphan_id`,
      `UPDATE org_sites t SET department_id = m.canonical_id FROM dept_dedup_map m WHERE t.department_id = m.orphan_id`,
      `UPDATE timesheet_approval_events t SET department_id = m.canonical_id FROM dept_dedup_map m WHERE t.department_id = m.orphan_id`,
      `UPDATE timesheet_approvals t SET department_id = m.canonical_id FROM dept_dedup_map m WHERE t.department_id = m.orphan_id`,
      `UPDATE manager_department_import_brigade_aliases t SET department_id = m.canonical_id FROM dept_dedup_map m WHERE t.department_id = m.orphan_id`,
      `UPDATE org_departments t SET parent_id = m.canonical_id FROM dept_dedup_map m WHERE t.parent_id = m.orphan_id`,
    ];
    for (const sql of flat) await client.query(sql);

    // Репоинты с защитой от UNIQUE-конфликта: сперва удалить orphan-строки,
    // которые столкнулись бы с уже существующей canonical-строкой.
    const guarded: Array<[string, string]> = [
      [`DELETE FROM employee_department_access t USING dept_dedup_map m WHERE t.department_id = m.orphan_id AND EXISTS (SELECT 1 FROM employee_department_access x WHERE x.department_id = m.canonical_id AND x.employee_id = t.employee_id)`,
       `UPDATE employee_department_access t SET department_id = m.canonical_id FROM dept_dedup_map m WHERE t.department_id = m.orphan_id`],
      [`DELETE FROM timesheet_responsibles t USING dept_dedup_map m WHERE t.department_id = m.orphan_id AND EXISTS (SELECT 1 FROM timesheet_responsibles x WHERE x.department_id = m.canonical_id AND x.role = t.role)`,
       `UPDATE timesheet_responsibles t SET department_id = m.canonical_id FROM dept_dedup_map m WHERE t.department_id = m.orphan_id`],
      [`DELETE FROM user_company_access t USING dept_dedup_map m WHERE t.company_root_id = m.orphan_id AND EXISTS (SELECT 1 FROM user_company_access x WHERE x.company_root_id = m.canonical_id AND x.user_id = t.user_id)`,
       `UPDATE user_company_access t SET company_root_id = m.canonical_id FROM dept_dedup_map m WHERE t.company_root_id = m.orphan_id`],
      [`DELETE FROM contractor_passes t USING dept_dedup_map m WHERE t.org_department_id = m.orphan_id AND EXISTS (SELECT 1 FROM contractor_passes x WHERE x.org_department_id = m.canonical_id AND x.pass_number = t.pass_number)`,
       `UPDATE contractor_passes t SET org_department_id = m.canonical_id FROM dept_dedup_map m WHERE t.org_department_id = m.orphan_id`],
      [`DELETE FROM contractor_roster t USING dept_dedup_map m WHERE t.org_department_id = m.orphan_id AND t.sigur_employee_id IS NOT NULL AND EXISTS (SELECT 1 FROM contractor_roster x WHERE x.org_department_id = m.canonical_id AND x.sigur_employee_id = t.sigur_employee_id)`,
       `UPDATE contractor_roster t SET org_department_id = m.canonical_id FROM dept_dedup_map m WHERE t.org_department_id = m.orphan_id`],
    ];
    for (const [del, upd] of guarded) { await client.query(del); await client.query(upd); }

    // timesheet_reminder_log — журнал (ON DELETE CASCADE, UNIQUE по
    // dept+period+user+stage): для дефунктного отдела ценности нет, удаляем.
    await client.query(`DELETE FROM timesheet_reminder_log t USING dept_dedup_map m WHERE t.department_id = m.orphan_id`);

    // Orphan-строки больше никем не используются → удаляем.
    await client.query(`DELETE FROM org_departments WHERE id IN (SELECT orphan_id FROM dept_dedup_map)`);

    return { pairs, employeesMoved };
  });
}
