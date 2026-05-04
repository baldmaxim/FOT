import { sigurService } from './sigur.service.js';
import { supabase } from '../config/database.js';
import { parseFIO } from '../utils/fio.utils.js';
import {
  getPositionsRaw,
  getWhitelistedDepartmentIdsCached,
  logSampleAndWarn,
  normalizeEmployee,
  type ISyncContext,
} from './sigur-sync-shared.js';
import { employeeChangesService } from './employee-changes.service.js';
import { employeeCache } from './employee-cache.service.js';
import { assignEmployeesToArchiveDepartment } from './employee-archive-department.service.js';
import { invalidatePresencePollingEmployeeCache } from './presence-polling-cache.service.js';
import { batchMoveSigurEmployees } from './sigur-live-admin.service.js';
import { settingsService } from './settings.service.js';
import { upsertTechnicalDepartmentAccess } from './employee-department-access.service.js';

// ─── Типы результатов ───

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

export interface IUnmatchedSigurEmployee {
  sigurId: number | undefined;
  name: string;
  departmentName: string;
  positionName: string;
  orgDepartmentId: string | null;
  positionId: string | null;
}

export interface ISyncEmployeesResult {
  imported: number;
  updated: number;
  skipped: number;
  total: number;
  errors: string[];
  unmatched: IUnmatchedSigurEmployee[];
  auto_fired: number;
}

// ─── Защита авто-fire от ложных срабатываний ───

export interface IAutoFireSafetyOptions {
  /** Минимальный порог по абсолютному количеству, переопределяется env SIGUR_AUTOFIRE_MAX. По умолчанию 20. */
  absoluteLimit?: number;
  /** Доля активных, выше которой массовый авто-fire считается аномалией. По умолчанию 0.05 (5%). */
  relativeLimitRatio?: number;
  /** Пороговая доля «выгрузка / активные»: ниже неё считаем выгрузку усечённой. По умолчанию 0.5 (50%). */
  truncationRatio?: number;
}

export interface IAutoFireDecision {
  shouldSkip: boolean;
  reason: string | null;
  limit: number;
}

/**
 * Решает, безопасно ли применить авто-fire к найденным «отсутствующим» сотрудникам.
 * Чистая функция — тестируется без моков supabase/sigur.
 */
export function evaluateAutoFireSafety(
  activeWithSigur: number,
  sigurCount: number,
  toFireCount: number,
  opts: IAutoFireSafetyOptions = {},
): IAutoFireDecision {
  const absLimit = Math.max(1, opts.absoluteLimit ?? 20);
  const relRatio = opts.relativeLimitRatio ?? 0.05;
  const truncRatio = opts.truncationRatio ?? 0.5;
  const limit = Math.max(absLimit, Math.ceil(activeWithSigur * relRatio));

  if (activeWithSigur > 0 && sigurCount < activeWithSigur * truncRatio) {
    return {
      shouldSkip: true,
      reason: `auto-fire skipped: sigur returned ${sigurCount} but db has ${activeWithSigur} active — looks truncated`,
      limit,
    };
  }
  if (toFireCount > limit) {
    return {
      shouldSkip: true,
      reason: `auto-fire skipped: would fire ${toFireCount} employees, exceeds limit ${limit}`,
      limit,
    };
  }
  return { shouldSkip: false, reason: null, limit };
}

// ─── Чистые функции синхронизации ───

export async function syncPositionsFromSigurLogic(
  connection?: 'external' | 'internal',
  context?: ISyncContext,
): Promise<ISyncPositionsFromSigurResult> {
  if (!(await sigurService.isConfigured())) throw new Error('Sigur не настроен');

  const sigurPositions = await getPositionsRaw(connection, context);
  if (!sigurPositions || sigurPositions.length === 0) {
    return { imported: 0, updated: 0, skipped: 0, total: 0, errors: [] };
  }

  console.log(`[syncPositionsFromSigur] got ${sigurPositions.length} positions from Sigur`);

  const { data: existingPositions } = await supabase
    .from('positions')
    .select('id, sigur_position_id, name');

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

export async function seedPositionsLogic(): Promise<ISeedPositionsResult> {
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
    .select('id, name');

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
  connection?: 'external' | 'internal',
  onProgress?: (data: Record<string, unknown>) => void,
  context?: ISyncContext,
  autoInsert = true,
): Promise<ISyncEmployeesResult> {
  if (!(await sigurService.isConfigured())) throw new Error('Sigur не настроен');

  const send = onProgress || (() => {});
  send({ type: 'employees_progress', phase: 'loading', current: 0, total: 0, percent: 0 });

  // Всегда загружаем полный список — чтобы обновлять отдел у существующих сотрудников
  // даже если они переехали за пределы whitelist-отделов
  const whitelist = await getWhitelistedDepartmentIdsCached(connection, context);
  if (whitelist) {
    console.log(`[syncEmployees] whitelist active: ${whitelist.size} subtree departments (applies to inserts and unmatched list)`);
  }
  const sigurEmployeesRaw = await sigurService.getEmployeesCached(connection);
  console.log('[syncEmployees] got', sigurEmployeesRaw.length, 'employees from Sigur');

  if (sigurEmployeesRaw.length === 0) {
    return { imported: 0, updated: 0, skipped: 0, total: 0, errors: [], unmatched: [], auto_fired: 0 };
  }

  logSampleAndWarn('syncEmployees', sigurEmployeesRaw[0], ['id', 'name', 'departmentId', 'positionId', 'position']);

  const sigurEmployees = sigurEmployeesRaw.map(normalizeEmployee);
  const skippedByWhitelist = 0;
  console.log(`[syncEmployees] employees to process: ${sigurEmployees.length}`);

  // Архивная папка Sigur — единый источник «уволен в Sigur».
  // Имена отделов больше не используются: regex /уволен/i ловил ложные совпадения.
  const archiveDepartmentId = (await settingsService.getSigurConnectionSettings()).archiveDepartmentId;
  if (!archiveDepartmentId) {
    console.warn('[syncEmployees] sigur_archive_department_id не задан — fire по архивной папке отключён');
  }

  // Глобальный поиск по sigur_employee_id
  const existingEmps: {
    id: number;
    sigur_employee_id: number;
    employment_status: string;
    department_locked: boolean;
    name_locked: boolean;
    org_department_id: string | null;
    position_id: string | null;
    tab_number: string | null;
    full_name: string | null;
    last_name: string | null;
    first_name: string | null;
    middle_name: string | null;
  }[] = [];
  const EMP_PAGE = 1000;
  let empOffset = 0;
  while (true) {
    const { data: existingEmpsPage } = await supabase
      .from('employees')
      .select('id, sigur_employee_id, employment_status, department_locked, name_locked, org_department_id, position_id, tab_number, full_name, last_name, first_name, middle_name')
      .not('sigur_employee_id', 'is', null)
      .range(empOffset, empOffset + EMP_PAGE - 1);
    if (!existingEmpsPage || existingEmpsPage.length === 0) break;
    existingEmps.push(...existingEmpsPage);
    if (existingEmpsPage.length < EMP_PAGE) break;
    empOffset += EMP_PAGE;
  }

  const sigurIdToDbId = new Map<number, number>();
  const firedSigurIds = new Set<number>();
  const dbEmpById = new Map<number, {
    org_department_id: string | null;
    position_id: string | null;
    tab_number: string | null;
    full_name: string | null;
    last_name: string | null;
    first_name: string | null;
    middle_name: string | null;
    department_locked: boolean;
    name_locked: boolean;
    employment_status: string;
  }>();
  for (const e of existingEmps || []) {
    if (e.sigur_employee_id != null) {
      if (!sigurIdToDbId.has(e.sigur_employee_id)) {
        sigurIdToDbId.set(e.sigur_employee_id, e.id);
      }
      dbEmpById.set(e.id, {
        org_department_id: e.org_department_id,
        position_id: e.position_id,
        tab_number: e.tab_number,
        full_name: e.full_name,
        last_name: e.last_name,
        first_name: e.first_name,
        middle_name: e.middle_name,
        department_locked: e.department_locked,
        name_locked: e.name_locked,
        employment_status: e.employment_status,
      });
      if (e.employment_status === 'fired') firedSigurIds.add(e.sigur_employee_id);
    }
  }

  // Portal-only активные сотрудники (sigur_employee_id IS NULL) — чтобы новосозданный
  // в Sigur человек не породил дубль, если в БД уже есть активный portal-only с таким же ФИО
  // (например, после rehire с auto-detach).
  interface IPortalOnlyRow {
    id: number;
    full_name: string | null;
    last_name: string | null;
    first_name: string | null;
    middle_name: string | null;
    org_department_id: string | null;
    position_id: string | null;
    tab_number: string | null;
    department_locked: boolean;
    name_locked: boolean;
  }
  const portalOnlyEmps: IPortalOnlyRow[] = [];
  let portalOffset = 0;
  while (true) {
    const { data: page } = await supabase
      .from('employees')
      .select('id, full_name, last_name, first_name, middle_name, org_department_id, position_id, tab_number, department_locked, name_locked')
      .is('sigur_employee_id', null)
      .eq('employment_status', 'active')
      .range(portalOffset, portalOffset + EMP_PAGE - 1);
    if (!page || page.length === 0) break;
    portalOnlyEmps.push(...(page as IPortalOnlyRow[]));
    if (page.length < EMP_PAGE) break;
    portalOffset += EMP_PAGE;
  }

  const normalizeFullName = (name: string): string => (
    name.trim().toLowerCase().replace(/\s+/g, ' ').replace(/ё/g, 'е')
  );
  const portalOnlyByName = new Map<string, IPortalOnlyRow[]>();
  for (const e of portalOnlyEmps) {
    if (!e.full_name) continue;
    const key = normalizeFullName(e.full_name);
    const arr = portalOnlyByName.get(key);
    if (arr) arr.push(e);
    else portalOnlyByName.set(key, [e]);
  }

  const { data: dbDepartments } = await supabase
    .from('org_departments')
    .select('id, sigur_department_id, name')
    .not('sigur_department_id', 'is', null);

  const sigurDeptToDbId = new Map<number, string>();
  const sigurDeptToName = new Map<number, string>();
  for (const d of dbDepartments || []) {
    if (d.sigur_department_id != null) {
      sigurDeptToDbId.set(d.sigur_department_id, d.id);
      if (d.name) sigurDeptToName.set(d.sigur_department_id, d.name);
    }
  }

  const { data: dbPositions } = await supabase
    .from('positions')
    .select('id, sigur_position_id')
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
    .select('id, name');

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
  const unmatchedList: IUnmatchedSigurEmployee[] = [];

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
    send({ type: 'employees_progress', phase: 'positions', current: 0, total: totalEmployees, percent: 0 });
    const posInserts = [...missingPositions].map(name => ({
      name,
      category: 'other' as const,
    }));
    const POS_BATCH = 100;
    for (let i = 0; i < posInserts.length; i += POS_BATCH) {
      const batch = posInserts.slice(i, i + POS_BATCH);
      const { data: created } = await supabase.from('positions').upsert(batch, { onConflict: 'name', ignoreDuplicates: true }).select('id, name');
      for (const p of created || []) {
        if (p.name) posNameToDbId.set(p.name.toLowerCase(), p.id);
      }
    }
  }

  // Собираем обновления и вставки (без DB-запросов в цикле)
  const updates: { id: number; fields: Record<string, unknown>; name: string }[] = [];

  for (let empIdx = 0; empIdx < sigurEmployees.length; empIdx++) {
    const emp = sigurEmployees[empIdx];
    if (empIdx % 50 === 0) {
      send({ type: 'employees_progress', phase: 'matching', current: empIdx, total: totalEmployees, percent: Math.round((empIdx / totalEmployees) * 100) });
    }
    const fullName = emp.name;
    if (!fullName) { skipped++; continue; }

    const sigurEmpId = emp.id;
    const sigurDeptId = emp.departmentId;
    const sigurDeptName = sigurDeptId ? (sigurDeptToName.get(sigurDeptId) ?? null) : null;
    // Признак «уволен в Sigur» — точное совпадение с архивной папкой по id (settings.sigur_archive_department_id).
    // Раньше тут была regex /уволен/i по имени отдела, которая ловила ложные совпадения
    // (например, любой отдел с подстрокой «уволен» в названии).
    const isDismissalDept = archiveDepartmentId != null
      && sigurDeptId != null
      && sigurDeptId === archiveDepartmentId;
    const orgDepartmentId = sigurDeptId ? sigurDeptToDbId.get(sigurDeptId) || null : null;
    const sigurPosId = emp.positionId;
    const positionText = emp.position;
    const tabNumber = emp.tabId ? emp.tabId.trim() : null;

    let positionId: string | null = null;
    if (sigurPosId) positionId = sigurPosToDbId.get(sigurPosId) || null;
    if (!positionId && positionText) {
      positionId = posNameToDbId.get(positionText.toLowerCase()) || null;
    }

    if (sigurEmpId && sigurIdToDbId.has(sigurEmpId)) {
      const dbId = sigurIdToDbId.get(sigurEmpId)!;
      const updateFields: Record<string, unknown> = {};
      const prev = dbEmpById.get(dbId);

      if (isDismissalDept) {
        // Сотрудник перемещён в «Уволенные» в Sigur → увольняем
        if (prev?.employment_status === 'active') {
          updateFields.employment_status = 'fired';
          console.log(`[syncEmployees] fire (dismissal dept): ${fullName} (sigurId=${sigurEmpId})`);
        }
      } else if (sigurEmpId && firedSigurIds.has(sigurEmpId)) {
        // Сотрудник fired в БД, но числится в обычном отделе Sigur → реактивируем
        updateFields.employment_status = 'active';
        console.log(`[syncEmployees] reactivate: ${fullName} (sigurId=${sigurEmpId})`);
      }

      if (orgDepartmentId) {
        updateFields.org_department_id = orgDepartmentId;
      }
      if (positionId) {
        updateFields.position_id = positionId;
      }
      const normalizedFullName = fullName.trim();
      const fio = parseFIO(normalizedFullName);
      if (
        prev
        && !prev.name_locked
        && (
          (prev.full_name || '') !== normalizedFullName
          || (prev.last_name || '') !== fio.lastName
          || (prev.first_name || null) !== (fio.firstName || null)
          || (prev.middle_name || null) !== (fio.middleName || null)
        )
      ) {
        updateFields.full_name = normalizedFullName;
        updateFields.last_name = fio.lastName;
        updateFields.first_name = fio.firstName || null;
        updateFields.middle_name = fio.middleName || null;
      }
      if ((prev?.tab_number || null) !== tabNumber) {
        updateFields.tab_number = tabNumber;
      }
      if (prev?.department_locked) {
        updateFields.department_locked = false;
      }

      if (Object.keys(updateFields).length > 0) {
        updates.push({ id: dbId, fields: updateFields, name: fullName });
      } else {
        skipped++;
      }
      continue;
    }

    if (autoInsert) {
      // Whitelist ограничивает только вставку новых сотрудников, не обновление существующих.
      // Вставляем только сотрудников из реально выбранных для sync отделов.
      if (isDismissalDept) { skipped++; continue; }
      if (whitelist && (sigurDeptId == null || !whitelist.has(sigurDeptId))) {
        const deptName = (sigurDeptId ? sigurDeptToName.get(sigurDeptId) : null) || `sigurDeptId=${sigurDeptId ?? 'null'}`;
        console.log(`[syncEmployees] skip insert (whitelist): ${fullName} | dept: ${deptName}`);
        skipped++;
        continue;
      }

      // Защита от дублей: если в БД уже есть активный portal-only сотрудник с таким же ФИО
      // (например, восстановленный через rehire с auto-detach), привязываем нового Sigur-сотрудника
      // к существующей портальной записи вместо создания новой.
      const nameKey = normalizeFullName(fullName);
      const portalMatches = portalOnlyByName.get(nameKey);
      if (portalMatches && portalMatches.length === 1 && sigurEmpId) {
        const match = portalMatches[0];
        const fio = parseFIO(fullName);
        const normalizedFullName = fullName.trim();
        const linkFields: Record<string, unknown> = {
          sigur_employee_id: sigurEmpId,
          department_locked: false,
        };
        if (orgDepartmentId) linkFields.org_department_id = orgDepartmentId;
        if (positionId) linkFields.position_id = positionId;
        if (tabNumber !== (match.tab_number || null)) linkFields.tab_number = tabNumber;
        if (!match.name_locked && (match.full_name || '') !== normalizedFullName) {
          linkFields.full_name = normalizedFullName;
          linkFields.last_name = fio.lastName;
          linkFields.first_name = fio.firstName || null;
          linkFields.middle_name = fio.middleName || null;
        }
        updates.push({ id: match.id, fields: linkFields, name: fullName });
        // dbEmpById нужен для корректной обработки в batch ниже (changeDepartment / changePosition)
        dbEmpById.set(match.id, {
          org_department_id: match.org_department_id,
          position_id: match.position_id,
          tab_number: match.tab_number,
          full_name: match.full_name,
          last_name: match.last_name,
          first_name: match.first_name,
          middle_name: match.middle_name,
          department_locked: match.department_locked,
          name_locked: match.name_locked,
          employment_status: 'active',
        });
        sigurIdToDbId.set(sigurEmpId, match.id);
        portalOnlyByName.delete(nameKey);
        console.log(`[syncEmployees] auto-link portal-only: ${fullName} (id=${match.id}) ← sigurId=${sigurEmpId}`);
        continue;
      }
      if (portalMatches && portalMatches.length > 1) {
        // Неоднозначно — в unmatched, чтобы HR решил вручную через SigurMatchModal
        console.warn(`[syncEmployees] ambiguous portal-only match: ${fullName} (${portalMatches.length} candidates) — skip insert, add to unmatched`);
        unmatchedList.push({
          sigurId: sigurEmpId,
          name: fullName.trim(),
          departmentName: sigurDeptName || '',
          positionName: emp.position || '',
          orgDepartmentId: orgDepartmentId,
          positionId: positionId,
        });
        continue;
      }

      const fio = parseFIO(fullName);
      inserts.push({
        full_name: fullName.trim(),
        last_name: fio.lastName,
        first_name: fio.firstName || null,
        middle_name: fio.middleName || null,
        hire_date: new Date().toISOString().slice(0, 10),
        employment_status: 'active',
        is_archived: false,
        sigur_employee_id: sigurEmpId || null,
        org_department_id: orgDepartmentId,
        position_id: positionId,
        tab_number: tabNumber,
      });
    } else {
      // Для ручного sync-all показываем unmatched только по отделам,
      // которые реально входят в текущий whitelist синхронизации.
      if (whitelist && (sigurDeptId == null || !whitelist.has(sigurDeptId))) {
        skipped++;
        continue;
      }

      unmatchedList.push({
        sigurId: sigurEmpId,
        name: fullName.trim(),
        departmentName: (sigurDeptId ? sigurDeptToName.get(sigurDeptId) : null) || '',
        positionName: emp.position || '',
        orgDepartmentId: orgDepartmentId,
        positionId: positionId,
      });
    }
  }

  // Батчим обновления (параллельно по 20)
  console.log('[syncEmployees] prepared', updates.length, 'updates,', inserts.length, 'inserts,', unmatchedList.length, 'unmatched');
  send({ type: 'employees_progress', phase: 'saving', current: totalEmployees, total: totalEmployees, percent: 95 });

  const UPDATE_CONCURRENCY = 20;
  for (let i = 0; i < updates.length; i += UPDATE_CONCURRENCY) {
    const batch = updates.slice(i, i + UPDATE_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async u => {
        try {
          const prev = dbEmpById.get(u.id);
          // Отдел изменился → пишем историю и синхронизируем назначения
          if (u.fields.org_department_id && prev && u.fields.org_department_id !== prev.org_department_id) {
            const nextDeptId = u.fields.org_department_id as string;

            // Защита от gap'а: если у сотрудника нет открытого назначения вообще,
            // но есть свежее закрытое в нужном Sigur-отделе — переоткрываем его
            // (effective_to=NULL), а не создаём новую запись задним числом today().
            // Иначе после случайного обрыва пары (например, удалённого нового
            // назначения через UI «История») каждый цикл sync порождал бы gap.
            const { count: openCount } = await supabase
              .from('employee_assignments')
              .select('id', { count: 'exact', head: true })
              .eq('employee_id', u.id)
              .is('effective_to', null);

            let reopened = false;
            if ((openCount ?? 0) === 0) {
              const { data: lastClosed } = await supabase
                .from('employee_assignments')
                .select('id, position_id, effective_to')
                .eq('employee_id', u.id)
                .eq('org_department_id', nextDeptId)
                .not('effective_to', 'is', null)
                .order('effective_to', { ascending: false })
                .limit(1)
                .maybeSingle();
              if (lastClosed) {
                const nowIso = new Date().toISOString();
                const { error: reopenErr } = await supabase
                  .from('employee_assignments')
                  .update({ effective_to: null, updated_at: nowIso })
                  .eq('id', lastClosed.id);
                if (!reopenErr) {
                  await supabase
                    .from('employees')
                    .update({
                      org_department_id: nextDeptId,
                      position_id: lastClosed.position_id || null,
                      updated_at: nowIso,
                    })
                    .eq('id', u.id);
                  console.log('[syncEmployees] reopened orphaned assignment', {
                    employeeId: u.id, assignmentId: lastClosed.id, deptId: nextDeptId,
                    previousEffectiveTo: lastClosed.effective_to,
                  });
                  reopened = true;
                }
              }
            }

            if (!reopened) {
              await employeeChangesService.changeDepartment(u.id, nextDeptId, {
                reason: 'Синхронизация Sigur',
                lockDepartment: false,
              });
            }
            await upsertTechnicalDepartmentAccess(u.id, nextDeptId, prev.org_department_id || null, 'sigur_sync');
            delete u.fields.org_department_id;
          }
          if (u.fields.position_id && prev && u.fields.position_id !== prev.position_id) {
            await employeeChangesService.changePosition(u.id, u.fields.position_id as string, {
              reason: 'Синхронизация Sigur',
            });
            delete u.fields.position_id;
          }
          // Остальные поля — прямой update
          if (Object.keys(u.fields).length > 0) {
            const { error } = await supabase.from('employees').update(u.fields).eq('id', u.id);
            if (error) return { error };
          }
          employeeCache.invalidate(u.id);
          return { error: null };
        } catch (err) {
          return { error: { message: err instanceof Error ? err.message : 'Unknown' } };
        }
      })
    );
    for (let j = 0; j < results.length; j++) {
      if (!results[j].error) updated++;
      else errors.push(`update ${batch[j].name}: ${results[j].error!.message}`);
    }
  }

  send({ type: 'employees_progress', phase: 'saving', current: totalEmployees, total: totalEmployees, percent: 100 });

  const BATCH_SIZE = 100;
  const insertedAccessSeeds: Array<{ id: number; org_department_id: string }> = [];
  for (let i = 0; i < inserts.length; i += BATCH_SIZE) {
    const batch = inserts.slice(i, i + BATCH_SIZE);
    const { data: insertedRows, error: insertError } = await supabase
      .from('employees')
      .insert(batch)
      .select('id, org_department_id');
    if (insertError) {
      console.warn(`[syncEmployees] batch ${i / BATCH_SIZE + 1} failed: ${insertError.message}. Fallback to individual inserts.`);
      for (const row of batch) {
        const { data: singleRow, error: singleErr } = await supabase
          .from('employees')
          .insert(row)
          .select('id, org_department_id')
          .single();
        if (singleErr) {
          errors.push(`${(row as Record<string, unknown>).full_name}: ${singleErr.message}`);
        } else {
          imported++;
          if (singleRow?.id && singleRow.org_department_id) {
            insertedAccessSeeds.push({ id: singleRow.id as number, org_department_id: singleRow.org_department_id as string });
          }
        }
      }
    } else {
      imported += batch.length;
      for (const row of insertedRows || []) {
        if (row.id && row.org_department_id) {
          insertedAccessSeeds.push({ id: row.id as number, org_department_id: row.org_department_id as string });
        }
      }
    }
  }

  for (const seed of insertedAccessSeeds) {
    try {
      await upsertTechnicalDepartmentAccess(seed.id, seed.org_department_id, null, 'sigur_sync');
    } catch (accessError) {
      errors.push(`access insert ${seed.id}: ${(accessError as Error).message}`);
    }
  }

  // Авто-увольнение сотрудников, которых больше нет в SIGUR.
  // Защита от инцидентов: при подозрительно тонкой выгрузке Sigur и при попытке зафаерить
  // слишком многих за один проход — авто-fire отменяется целиком (см. инцидент 17.04.2026).
  const sigurIdSet = new Set<number>();
  for (const emp of sigurEmployees) {
    if (emp.id != null) sigurIdSet.add(emp.id);
  }

  const activeWithSigur = existingEmps.filter(e => e.employment_status === 'active').length;
  const toAutoFire = existingEmps.filter(
    e => e.employment_status === 'active' && !sigurIdSet.has(e.sigur_employee_id),
  );

  const safety = evaluateAutoFireSafety(activeWithSigur, sigurEmployees.length, toAutoFire.length, {
    absoluteLimit: Number(process.env.SIGUR_AUTOFIRE_MAX) || undefined,
  });

  let autoFired = 0;
  const today = new Date().toISOString().slice(0, 10);
  const autoFiredIds: number[] = [];

  if (safety.shouldSkip) {
    console.error(`[syncEmployees] ${safety.reason}`);
    errors.push(safety.reason!);
  } else {
    for (const emp of toAutoFire) {
      const { error: fireErr } = await supabase
        .from('employees')
        .update({ employment_status: 'fired', updated_at: new Date().toISOString() })
        .eq('id', emp.id);
      if (fireErr) {
        errors.push(`auto-fire ${emp.id}: ${fireErr.message}`);
        continue;
      }
      autoFired++;
      autoFiredIds.push(emp.id);
    }

    if (autoFiredIds.length > 0) {
      try {
        await assignEmployeesToArchiveDepartment(autoFiredIds, null, { connection, effectiveDate: today });
      } catch (archiveError) {
        errors.push(`auto-fire archive move: ${(archiveError as Error).message}`);
      }
    }

    if (autoFired > 0) {
      console.log(`[syncEmployees] auto-fired ${autoFired} employees not found in Sigur`);
    }
  }

  // Перенос всех fired сотрудников в архивную папку Sigur (идемпотентно).
  // Сотрудников без sigur_employee_id пропускаем — их нет в Sigur, переносить некуда.
  try {
    const sigurSettings = await settingsService.getSigurConnectionSettings();
    if (!sigurSettings.archiveDepartmentId) {
      console.warn('[syncEmployees] archive department not configured — skip fired->archive sync');
    } else {
      const archiveDepartmentId = sigurSettings.archiveDepartmentId;

      const sigurDeptById = new Map<number, number | null>();
      for (const emp of sigurEmployees) {
        if (emp.id != null) sigurDeptById.set(emp.id, emp.departmentId ?? null);
      }

      const { data: firedRows, error: firedErr } = await supabase
        .from('employees')
        .select('id, sigur_employee_id')
        .eq('employment_status', 'fired')
        .not('sigur_employee_id', 'is', null);

      if (firedErr) {
        errors.push(`fired->archive select: ${firedErr.message}`);
      } else {
        const toMove: number[] = [];
        let skippedNotInSigur = 0;
        let skippedAlreadyArchived = 0;

        for (const row of firedRows ?? []) {
          const sid = row.sigur_employee_id as number | null;
          if (sid == null) continue;
          if (!sigurDeptById.has(sid)) { skippedNotInSigur++; continue; }
          if (sigurDeptById.get(sid) === archiveDepartmentId) { skippedAlreadyArchived++; continue; }
          toMove.push(sid);
        }

        if (toMove.length > 0) {
          const moveResult = await batchMoveSigurEmployees(toMove, archiveDepartmentId, connection);
          console.log(
            `[syncEmployees] fired->archive moved=${moveResult.moved}/${moveResult.requested} ` +
            `failed=${moveResult.failedIds.length} skipped_not_in_sigur=${skippedNotInSigur} ` +
            `skipped_already_archived=${skippedAlreadyArchived}`,
          );
          if (moveResult.failedIds.length > 0) {
            errors.push(`fired->archive failed ids: ${moveResult.failedIds.join(',')}`);
          }
        } else if (skippedNotInSigur > 0 || skippedAlreadyArchived > 0) {
          console.log(
            `[syncEmployees] fired->archive moved=0 ` +
            `skipped_not_in_sigur=${skippedNotInSigur} skipped_already_archived=${skippedAlreadyArchived}`,
          );
        }
      }
    }
  } catch (archiveSyncErr) {
    errors.push(`fired->archive sync: ${(archiveSyncErr as Error).message}`);
  }

  console.log(`[syncEmployees] done: ${imported} imported, ${updated} updated, ${skipped} skipped, ${unmatchedList.length} unmatched, ${autoFired} auto-fired`);

  // Сбрасываем локальный кэш presence-polling, чтобы первые события нового/изменённого
  // сотрудника сразу привязывались к employee_id без ожидания TTL кэша (10 мин).
  if (imported > 0 || updated > 0 || autoFired > 0) {
    invalidatePresencePollingEmployeeCache();
  }

  return { imported, updated, skipped, total: sigurEmployeesRaw.length, errors, unmatched: unmatchedList, auto_fired: autoFired };
}
