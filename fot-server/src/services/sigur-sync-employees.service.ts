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

// ─── Чистые функции синхронизации ───

export async function syncPositionsFromSigurLogic(
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
  if (!sigurService.isConfigured()) throw new Error('Sigur не настроен');

  const send = onProgress || (() => {});
  send({ type: 'employees_progress', phase: 'loading', current: 0, total: 0, percent: 0 });

  // Всегда загружаем полный список — чтобы обновлять отдел у существующих сотрудников
  // даже если они переехали за пределы whitelist-отделов
  const whitelist = await getWhitelistedDepartmentIdsCached(context);
  if (whitelist) {
    console.log(`[syncEmployees] whitelist active: ${whitelist.size} departments (applies to inserts only)`);
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

  // Глобальный поиск по sigur_employee_id
  const existingEmps: { id: number; sigur_employee_id: number; employment_status: string; department_locked: boolean; org_department_id: string | null; position_id: string | null }[] = [];
  const EMP_PAGE = 1000;
  let empOffset = 0;
  while (true) {
    const { data: existingEmpsPage } = await supabase
      .from('employees')
      .select('id, sigur_employee_id, employment_status, department_locked, org_department_id, position_id')
      .not('sigur_employee_id', 'is', null)
      .range(empOffset, empOffset + EMP_PAGE - 1);
    if (!existingEmpsPage || existingEmpsPage.length === 0) break;
    existingEmps.push(...existingEmpsPage);
    if (existingEmpsPage.length < EMP_PAGE) break;
    empOffset += EMP_PAGE;
  }

  const sigurIdToDbId = new Map<number, number>();
  const firedSigurIds = new Set<number>();
  const lockedDeptSigurIds = new Set<number>();
  const dbEmpById = new Map<number, { org_department_id: string | null; position_id: string | null }>();
  for (const e of existingEmps || []) {
    if (e.sigur_employee_id != null) {
      if (!sigurIdToDbId.has(e.sigur_employee_id)) {
        sigurIdToDbId.set(e.sigur_employee_id, e.id);
      }
      dbEmpById.set(e.id, { org_department_id: e.org_department_id, position_id: e.position_id });
      if (e.employment_status === 'fired') firedSigurIds.add(e.sigur_employee_id);
      if (e.department_locked) lockedDeptSigurIds.add(e.sigur_employee_id);
    }
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
      // Должности из Sigur не обновляем — приоритет у портала ФОТ

      if (Object.keys(updateFields).length > 0) {
        updates.push({ id: dbId, fields: updateFields, name: fullName });
      } else {
        skipped++;
      }
      continue;
    }

    if (autoInsert) {
      // Whitelist ограничивает только вставку новых сотрудников, не обновление существующих
      if (whitelist && sigurDeptId != null && !whitelist.has(sigurDeptId)) {
        skipped++;
        continue;
      }
      const fio = parseFIO(fullName);
      inserts.push({
        full_name: fullName.trim(),
        last_name: fio.lastName,
        first_name: fio.firstName || null,
        middle_name: fio.middleName || null,
        hire_date: new Date().toISOString().slice(0, 10),
        sigur_employee_id: sigurEmpId || null,
        org_department_id: orgDepartmentId,
        position_id: positionId,
      });
    } else {
      const sigurDeptId = emp.departmentId;
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
          // Отдел изменился → пишем историю
          if (u.fields.org_department_id && prev && u.fields.org_department_id !== prev.org_department_id) {
            await employeeChangesService.changeDepartment(u.id, u.fields.org_department_id as string, {
              reason: 'Синхронизация Sigur',
            });
            delete u.fields.org_department_id;
          }
          // Должность из Sigur — прямой update без истории (история ведётся вручную)
          // Остальные поля — прямой update
          if (Object.keys(u.fields).length > 0) {
            const { error } = await supabase.from('employees').update(u.fields).eq('id', u.id);
            if (error) return { error };
          }
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

  // Авто-увольнение сотрудников, которых больше нет в SIGUR
  const sigurIdSet = new Set<number>();
  for (const emp of sigurEmployees) {
    if (emp.id != null) sigurIdSet.add(emp.id);
  }

  const toAutoFire = existingEmps.filter(
    e => e.employment_status === 'active' && !sigurIdSet.has(e.sigur_employee_id),
  );

  let autoFired = 0;
  const today = new Date().toISOString().slice(0, 10);

  for (const emp of toAutoFire) {
    const { error: fireErr } = await supabase
      .from('employees')
      .update({ employment_status: 'fired' })
      .eq('id', emp.id);
    if (fireErr) {
      errors.push(`auto-fire ${emp.id}: ${fireErr.message}`);
      continue;
    }
    await supabase
      .from('employee_assignments')
      .update({ effective_to: today })
      .eq('employee_id', emp.id)
      .is('effective_to', null);
    autoFired++;
  }

  if (autoFired > 0) {
    console.log(`[syncEmployees] auto-fired ${autoFired} employees not found in Sigur`);
  }

  console.log(`[syncEmployees] done: ${imported} imported, ${updated} updated, ${skipped} skipped, ${unmatchedList.length} unmatched, ${autoFired} auto-fired`);
  return { imported, updated, skipped, total: sigurEmployeesRaw.length, errors, unmatched: unmatchedList, auto_fired: autoFired };
}
