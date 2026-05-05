import { supabase } from '../config/database.js';
import { formatDateShift } from './timesheet-department-assignments.service.js';
import { escapeLike } from '../utils/search.utils.js';

export interface ITransferRow {
  assignment_new_id: string;
  assignment_old_id: string;
  employee_id: number;
  employee_full_name: string;
  to_department_id: string;
  to_department_name: string;
  transfer_date: string;
}

export interface IExclusionRow {
  employee_id: number;
  employee_full_name: string;
  exclusion_date: string | null;
  excluded_at: string | null;
}

export interface IDepartmentTransfersListing {
  transfers: ITransferRow[];
  exclusions: IExclusionRow[];
}

interface IAssignmentRow {
  id: string;
  employee_id: number;
  org_department_id: string;
  effective_from: string;
  effective_to: string | null;
}

async function loadAssignmentsByIds(ids: string[]): Promise<IAssignmentRow[]> {
  if (ids.length === 0) return [];
  const { data, error } = await supabase
    .from('employee_assignments')
    .select('id, employee_id, org_department_id, effective_from, effective_to')
    .in('id', ids);
  if (error) throw error;
  return (data || []).map(row => ({
    id: String(row.id),
    employee_id: Number(row.employee_id),
    org_department_id: String(row.org_department_id),
    effective_from: String(row.effective_from),
    effective_to: (row.effective_to as string | null) ?? null,
  }));
}

async function loadAssignmentById(id: string): Promise<IAssignmentRow | null> {
  const { data, error } = await supabase
    .from('employee_assignments')
    .select('id, employee_id, org_department_id, effective_from, effective_to')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    id: String(data.id),
    employee_id: Number(data.employee_id),
    org_department_id: String(data.org_department_id),
    effective_from: String(data.effective_from),
    effective_to: (data.effective_to as string | null) ?? null,
  };
}

/**
 * Парный assignment к назначению `assignment` — закрытое назначение того же сотрудника.
 *
 * Сначала ищем строго по инварианту effective_to = assignment.effective_from − 1
 * (так пишет changeDepartment). Если инвариант нарушен (правка вручную, sigur sync
 * с другой датой и т.п.) — фолбэк: последнее закрытое до open.effective_from. Так же
 * как делает buildAllTransfers при построении списка — список и удаление становятся
 * симметричны.
 */
async function findPreviousClosedAssignment(assignment: IAssignmentRow): Promise<IAssignmentRow | null> {
  const expectedClose = formatDateShift(assignment.effective_from, -1);
  const { data: strict, error: strictErr } = await supabase
    .from('employee_assignments')
    .select('id, employee_id, org_department_id, effective_from, effective_to')
    .eq('employee_id', assignment.employee_id)
    .eq('effective_to', expectedClose)
    .order('effective_from', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (strictErr) throw strictErr;
  if (strict) {
    return {
      id: String(strict.id),
      employee_id: Number(strict.employee_id),
      org_department_id: String(strict.org_department_id),
      effective_from: String(strict.effective_from),
      effective_to: (strict.effective_to as string | null) ?? null,
    };
  }

  const { data: lenient, error: lenientErr } = await supabase
    .from('employee_assignments')
    .select('id, employee_id, org_department_id, effective_from, effective_to')
    .eq('employee_id', assignment.employee_id)
    .neq('id', assignment.id)
    .not('effective_to', 'is', null)
    .lt('effective_to', assignment.effective_from)
    .order('effective_to', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lenientErr) throw lenientErr;
  if (!lenient) return null;
  return {
    id: String(lenient.id),
    employee_id: Number(lenient.employee_id),
    org_department_id: String(lenient.org_department_id),
    effective_from: String(lenient.effective_from),
    effective_to: (lenient.effective_to as string | null) ?? null,
  };
}

/**
 * Список переводов и исключений по конкретному отделу.
 *
 * Перевод: сотрудник, у которого есть закрытое назначение в этом отделе и текущее открытое — в другом.
 * Исключение: сотрудник с employees.org_department_id = departmentId и excluded_from_timesheet = true.
 */
export async function listDepartmentTransfers(departmentId: string): Promise<IDepartmentTransfersListing> {
  // 1) Закрытые назначения в этом отделе.
  const { data: closedHere, error: closedErr } = await supabase
    .from('employee_assignments')
    .select('id, employee_id, org_department_id, effective_from, effective_to')
    .eq('org_department_id', departmentId)
    .not('effective_to', 'is', null)
    .order('effective_to', { ascending: false });
  if (closedErr) throw closedErr;

  const lastClosedByEmployee = new Map<number, IAssignmentRow>();
  for (const row of closedHere || []) {
    const empId = Number(row.employee_id);
    if (!Number.isFinite(empId)) continue;
    const cur: IAssignmentRow = {
      id: String(row.id),
      employee_id: empId,
      org_department_id: String(row.org_department_id),
      effective_from: String(row.effective_from),
      effective_to: (row.effective_to as string | null) ?? null,
    };
    const existing = lastClosedByEmployee.get(empId);
    if (!existing || (cur.effective_to ?? '') > (existing.effective_to ?? '')) {
      lastClosedByEmployee.set(empId, cur);
    }
  }

  const candidateEmployeeIds = [...lastClosedByEmployee.keys()];

  // 2) Текущие открытые назначения этих сотрудников.
  const transfers: ITransferRow[] = [];
  if (candidateEmployeeIds.length > 0) {
    const { data: openRows, error: openErr } = await supabase
      .from('employee_assignments')
      .select('id, employee_id, org_department_id, effective_from, effective_to')
      .in('employee_id', candidateEmployeeIds)
      .is('effective_to', null);
    if (openErr) throw openErr;

    const openByEmployee = new Map<number, IAssignmentRow>();
    for (const row of openRows || []) {
      const empId = Number(row.employee_id);
      if (!Number.isFinite(empId)) continue;
      const cur: IAssignmentRow = {
        id: String(row.id),
        employee_id: empId,
        org_department_id: String(row.org_department_id),
        effective_from: String(row.effective_from),
        effective_to: null,
      };
      const existing = openByEmployee.get(empId);
      if (!existing || cur.effective_from > existing.effective_from) {
        openByEmployee.set(empId, cur);
      }
    }

    // 3) Подгружаем имена сотрудников и названия целевых отделов.
    const targetDeptIds = [...new Set([...openByEmployee.values()].map(a => a.org_department_id))];
    const [{ data: employeesRows, error: empErr }, { data: deptRows, error: deptErr }] = await Promise.all([
      supabase
        .from('employees')
        .select('id, full_name, is_archived, employment_status')
        .in('id', candidateEmployeeIds),
      targetDeptIds.length > 0
        ? supabase.from('org_departments').select('id, name').in('id', targetDeptIds)
        : Promise.resolve({ data: [] as Array<{ id: string; name: string }>, error: null }),
    ]);
    if (empErr) throw empErr;
    if (deptErr) throw deptErr;

    const nameByEmployee = new Map<number, string>();
    const archivedSet = new Set<number>();
    for (const row of employeesRows || []) {
      const empId = Number(row.id);
      nameByEmployee.set(empId, String(row.full_name || ''));
      if (row.is_archived || row.employment_status !== 'active') archivedSet.add(empId);
    }
    const deptNameById = new Map<string, string>();
    for (const row of deptRows || []) {
      deptNameById.set(String(row.id), String(row.name || ''));
    }

    for (const empId of candidateEmployeeIds) {
      if (archivedSet.has(empId)) continue;
      const oldA = lastClosedByEmployee.get(empId);
      const newA = openByEmployee.get(empId);
      if (!oldA || !newA) continue;
      // Если сотрудник вернулся обратно — его текущий отдел = departmentId, не показываем.
      if (newA.org_department_id === departmentId) continue;
      transfers.push({
        assignment_new_id: newA.id,
        assignment_old_id: oldA.id,
        employee_id: empId,
        employee_full_name: nameByEmployee.get(empId) || '',
        to_department_id: newA.org_department_id,
        to_department_name: deptNameById.get(newA.org_department_id) || '',
        transfer_date: newA.effective_from,
      });
    }
  }

  transfers.sort((a, b) => (a.transfer_date > b.transfer_date ? -1 : a.transfer_date < b.transfer_date ? 1 : 0));

  // 4) Исключённые из этого отдела.
  const { data: excludedRows, error: exclErr } = await supabase
    .from('employees')
    .select('id, full_name, excluded_from_timesheet_date, excluded_from_timesheet_at')
    .eq('org_department_id', departmentId)
    .eq('excluded_from_timesheet', true)
    .eq('is_archived', false);
  if (exclErr) throw exclErr;

  const exclusions: IExclusionRow[] = (excludedRows || []).map(row => ({
    employee_id: Number(row.id),
    employee_full_name: String(row.full_name || ''),
    exclusion_date: (row.excluded_from_timesheet_date as string | null) ?? null,
    excluded_at: (row.excluded_from_timesheet_at as string | null) ?? null,
  }));

  exclusions.sort((a, b) => {
    const ad = a.exclusion_date || '';
    const bd = b.exclusion_date || '';
    return ad > bd ? -1 : ad < bd ? 1 : 0;
  });

  return { transfers, exclusions };
}

export interface IUpdateTransferResult {
  assignment_new_id: string;
  assignment_old_id: string;
  effective_from: string;
  effective_to_old: string;
  employee_id: number;
  to_department_id: string;
  from_department_id: string;
  changed: { date: boolean; to_dept: boolean; from_dept: boolean };
}

export interface IUpdateTransferInput {
  effective_from?: string;
  to_department_id?: string;
  from_department_id?: string;
  assignment_old_id?: string;
}

async function ensureDepartmentExists(deptId: string): Promise<void> {
  const { data, error } = await supabase
    .from('org_departments')
    .select('id')
    .eq('id', deptId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('Отдел не найден');
}

/**
 * Унифицированное обновление перевода: дата перевода и/или отдел назначения и/или исходный отдел.
 * Хотя бы одно поле должно отличаться от текущего значения.
 *
 * Семантика:
 * - effective_from — дата нового назначения; effective_to старого синхронно сдвигается на newDate-1.
 * - to_department_id — отдел открытого (нового) назначения. Если new — последнее открытое назначение
 *   сотрудника, то employees.org_department_id тоже синхронизируется.
 * - from_department_id — отдел закрытого (предыдущего) назначения. employees.org_department_id не трогаем.
 */
export async function updateTransfer(
  assignmentNewId: string,
  input: IUpdateTransferInput,
): Promise<IUpdateTransferResult> {
  const newA = await loadAssignmentById(assignmentNewId);
  if (!newA) throw new Error('Назначение не найдено');
  if (newA.effective_to != null) throw new Error('Назначение уже закрыто, корректировка невозможна');

  const oldA = input.assignment_old_id
    ? await loadAssignmentById(input.assignment_old_id)
    : await findPreviousClosedAssignment(newA);
  if (!oldA) throw new Error('Парное предыдущее назначение не найдено — возможно, перевод создан вручную');

  if (oldA.id === newA.id) {
    throw new Error('Старое и новое назначения не должны совпадать');
  }
  if (oldA.employee_id !== newA.employee_id) {
    throw new Error('Старое и новое назначения принадлежат разным сотрудникам');
  }
  if (oldA.effective_to == null) {
    throw new Error('Парное предыдущее назначение должно быть закрыто');
  }

  const nextDate = input.effective_from ?? newA.effective_from;
  const nextToDept = input.to_department_id ?? newA.org_department_id;
  const nextFromDept = input.from_department_id ?? oldA.org_department_id;

  const dateChanged = input.effective_from != null && input.effective_from !== newA.effective_from;
  const toDeptChanged = input.to_department_id != null && input.to_department_id !== newA.org_department_id;
  const fromDeptChanged = input.from_department_id != null && input.from_department_id !== oldA.org_department_id;

  if (!dateChanged && !toDeptChanged && !fromDeptChanged) {
    throw new Error('Не указаны изменения');
  }

  if (nextToDept === nextFromDept) {
    throw new Error('Отдел назначения не может совпадать с исходным отделом');
  }

  if (toDeptChanged) await ensureDepartmentExists(nextToDept);
  if (fromDeptChanged) await ensureDepartmentExists(nextFromDept);

  if (nextDate <= oldA.effective_from) {
    throw new Error('Дата перевода не может быть раньше начала предыдущего назначения');
  }

  const previousDay = formatDateShift(nextDate, -1);

  if (dateChanged) {
    const { data: overlap, error: overlapErr } = await supabase
      .from('employee_assignments')
      .select('id, effective_from, effective_to')
      .eq('employee_id', newA.employee_id)
      .neq('id', oldA.id)
      .neq('id', newA.id)
      .lte('effective_from', previousDay)
      .or(`effective_to.is.null,effective_to.gte.${oldA.effective_from}`);
    if (overlapErr) throw overlapErr;
    if ((overlap || []).length > 0) {
      throw new Error('Новая дата пересекается с другими назначениями сотрудника');
    }
  }

  const nowIso = new Date().toISOString();

  const oldUpdate: Record<string, unknown> = { updated_at: nowIso };
  if (dateChanged) oldUpdate.effective_to = previousDay;
  if (fromDeptChanged) oldUpdate.org_department_id = nextFromDept;

  if (Object.keys(oldUpdate).length > 1) {
    const { error: oldUpdErr } = await supabase
      .from('employee_assignments')
      .update(oldUpdate)
      .eq('id', oldA.id);
    if (oldUpdErr) throw oldUpdErr;
  }

  const newUpdate: Record<string, unknown> = { updated_at: nowIso };
  if (dateChanged) newUpdate.effective_from = nextDate;
  if (toDeptChanged) newUpdate.org_department_id = nextToDept;

  if (Object.keys(newUpdate).length > 1) {
    const { error: newUpdErr } = await supabase
      .from('employee_assignments')
      .update(newUpdate)
      .eq('id', newA.id);
    if (newUpdErr) {
      // Откатываем изменения старого назначения.
      const rollback: Record<string, unknown> = { updated_at: nowIso };
      if (dateChanged) rollback.effective_to = oldA.effective_to;
      if (fromDeptChanged) rollback.org_department_id = oldA.org_department_id;
      await supabase
        .from('employee_assignments')
        .update(rollback)
        .eq('id', oldA.id);
      throw newUpdErr;
    }
  }

  // Если поменялся отдел открытого назначения — синхронизируем employees.org_department_id.
  if (toDeptChanged) {
    const { error: empErr } = await supabase
      .from('employees')
      .update({ org_department_id: nextToDept, updated_at: nowIso })
      .eq('id', newA.employee_id);
    if (empErr) throw empErr;
  }

  return {
    assignment_new_id: newA.id,
    assignment_old_id: oldA.id,
    effective_from: nextDate,
    effective_to_old: previousDay,
    employee_id: newA.employee_id,
    to_department_id: nextToDept,
    from_department_id: nextFromDept,
    changed: { date: dateChanged, to_dept: toDeptChanged, from_dept: fromDeptChanged },
  };
}

export interface IDeleteTransferResult {
  employee_id: number;
  restored_department_id: string;
  removed_assignment_id: string;
  reopened_assignment_id: string;
}

/**
 * Полная отмена перевода: удаляет новое назначение, открывает старое (effective_to=NULL),
 * возвращает employees.org_department_id к старому отделу. Sigur не трогается.
 *
 * Возвращает null, если парное закрытое назначение не найдено — вызывающий код решает,
 * как трактовать (deleteTransfer кидает ошибку, deleteAssignment бросает свой текст).
 */
export async function tryDeleteTransfer(assignmentNewId: string): Promise<IDeleteTransferResult | null> {
  const newA = await loadAssignmentById(assignmentNewId);
  if (!newA) throw new Error('Назначение не найдено');
  if (newA.effective_to != null) throw new Error('Назначение уже закрыто, отмена не выполняется');

  const oldA = await findPreviousClosedAssignment(newA);
  if (!oldA) return null;

  const nowIso = new Date().toISOString();

  const { error: openErr } = await supabase
    .from('employee_assignments')
    .update({ effective_to: null, updated_at: nowIso })
    .eq('id', oldA.id);
  if (openErr) throw openErr;

  const { error: delErr } = await supabase
    .from('employee_assignments')
    .delete()
    .eq('id', newA.id);
  if (delErr) {
    // Откатываем открытие старого.
    await supabase
      .from('employee_assignments')
      .update({ effective_to: oldA.effective_to, updated_at: nowIso })
      .eq('id', oldA.id);
    throw delErr;
  }

  const { error: empErr } = await supabase
    .from('employees')
    .update({ org_department_id: oldA.org_department_id, updated_at: nowIso })
    .eq('id', newA.employee_id);
  if (empErr) throw empErr;

  return {
    employee_id: newA.employee_id,
    restored_department_id: oldA.org_department_id,
    removed_assignment_id: newA.id,
    reopened_assignment_id: oldA.id,
  };
}

export async function deleteTransfer(assignmentNewId: string): Promise<IDeleteTransferResult> {
  const result = await tryDeleteTransfer(assignmentNewId);
  if (!result) throw new Error('Парное предыдущее назначение не найдено — отмена невозможна');
  return result;
}

export interface IUpdateExclusionResult {
  employee_id: number;
  excluded_from_timesheet_date: string;
}

export async function updateExclusionDate(
  employeeId: number,
  newDate: string,
): Promise<IUpdateExclusionResult> {
  const { data: emp, error } = await supabase
    .from('employees')
    .select('id, excluded_from_timesheet, org_department_id')
    .eq('id', employeeId)
    .maybeSingle();
  if (error) throw error;
  if (!emp) throw new Error('Сотрудник не найден');
  if (!emp.excluded_from_timesheet) throw new Error('Сотрудник не исключён из табеля');

  const previousDay = formatDateShift(newDate, -1);
  const nowIso = new Date().toISOString();

  const { error: updErr } = await supabase
    .from('employees')
    .update({ excluded_from_timesheet_date: newDate, updated_at: nowIso })
    .eq('id', employeeId);
  if (updErr) throw updErr;

  // Если есть закрытое назначение в текущем отделе сотрудника — синхронизируем его дату закрытия.
  if (emp.org_department_id) {
    await supabase
      .from('employee_assignments')
      .update({ effective_to: previousDay, updated_at: nowIso })
      .eq('employee_id', employeeId)
      .eq('org_department_id', String(emp.org_department_id))
      .not('effective_to', 'is', null)
      .order('effective_to', { ascending: false })
      .limit(1);
  }

  return { employee_id: employeeId, excluded_from_timesheet_date: newDate };
}

export interface IDeleteExclusionResult {
  employee_id: number;
  reopened_assignment_id: string | null;
}

export async function deleteExclusion(employeeId: number): Promise<IDeleteExclusionResult> {
  const { data: emp, error } = await supabase
    .from('employees')
    .select('id, excluded_from_timesheet, org_department_id, excluded_from_timesheet_date')
    .eq('id', employeeId)
    .maybeSingle();
  if (error) throw error;
  if (!emp) throw new Error('Сотрудник не найден');
  if (!emp.excluded_from_timesheet) throw new Error('Сотрудник не исключён из табеля');

  const nowIso = new Date().toISOString();

  const { error: updErr } = await supabase
    .from('employees')
    .update({
      excluded_from_timesheet: false,
      excluded_from_timesheet_at: null,
      excluded_from_timesheet_date: null,
      updated_at: nowIso,
    })
    .eq('id', employeeId);
  if (updErr) throw updErr;

  let reopenedAssignmentId: string | null = null;
  if (emp.org_department_id) {
    // Восстанавливаем последнее закрытое назначение в текущем отделе.
    const { data: lastClosed, error: lastErr } = await supabase
      .from('employee_assignments')
      .select('id')
      .eq('employee_id', employeeId)
      .eq('org_department_id', String(emp.org_department_id))
      .not('effective_to', 'is', null)
      .order('effective_to', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastErr) throw lastErr;
    if (lastClosed) {
      const { error: openErr } = await supabase
        .from('employee_assignments')
        .update({ effective_to: null, updated_at: nowIso })
        .eq('id', String(lastClosed.id));
      if (openErr) throw openErr;
      reopenedAssignmentId = String(lastClosed.id);
    }
  }

  return { employee_id: employeeId, reopened_assignment_id: reopenedAssignmentId };
}

export async function loadAssignmentEmployeeId(assignmentId: string): Promise<number | null> {
  const a = await loadAssignmentById(assignmentId);
  return a ? a.employee_id : null;
}

export { loadAssignmentsByIds };

export interface ITransferAdminRow extends ITransferRow {
  from_department_id: string;
  from_department_name: string;
  employee_position: string | null;
}

export interface IExclusionAdminRow extends IExclusionRow {
  department_id: string | null;
  department_name: string;
  employee_position: string | null;
}

export interface IAdminTransfersFilters {
  from?: string;
  to?: string;
  department_id?: string;
  employee_query?: string;
}

export interface IAdminTransfersListing {
  transfers: ITransferAdminRow[];
  exclusions: IExclusionAdminRow[];
}

/**
 * Глобальный список переводов и исключений по всем отделам — для админ-страницы.
 *
 * Перевод определяется как пара (последнее закрытое, текущее открытое) у одного сотрудника
 * в разных отделах. Дата перевода — open.effective_from.
 *
 * Фильтры применяются после построения базового списка:
 * - from/to: по transfer_date (для переводов) или exclusion_date (для исключений)
 * - department_id: для переводов — связан с from или to; для исключений — текущий отдел сотрудника
 * - employee_query: ilike по full_name
 */
export async function listAllTransfersAndExclusions(
  filters: IAdminTransfersFilters,
): Promise<IAdminTransfersListing> {
  const trimmedQuery = (filters.employee_query || '').trim();
  const dateFrom = filters.from || null;
  const dateTo = filters.to || null;
  const deptFilter = filters.department_id || null;

  const transfers = await buildAllTransfers({ dateFrom, dateTo, deptFilter, query: trimmedQuery });
  const exclusions = await buildAllExclusions({ dateFrom, dateTo, deptFilter, query: trimmedQuery });

  return { transfers, exclusions };
}

interface IBuildArgs {
  dateFrom: string | null;
  dateTo: string | null;
  deptFilter: string | null;
  query: string;
}

async function buildAllTransfers(args: IBuildArgs): Promise<ITransferAdminRow[]> {
  // 1) Все открытые назначения активных сотрудников.
  let openQuery = supabase
    .from('employee_assignments')
    .select('id, employee_id, org_department_id, effective_from, effective_to')
    .is('effective_to', null);
  if (args.dateFrom) openQuery = openQuery.gte('effective_from', args.dateFrom);
  if (args.dateTo) openQuery = openQuery.lte('effective_from', args.dateTo);
  const { data: openRows, error: openErr } = await openQuery;
  if (openErr) throw openErr;

  if (!openRows || openRows.length === 0) return [];

  // Группируем по сотруднику, оставляем последнее открытое.
  const openByEmployee = new Map<number, IAssignmentRow>();
  for (const row of openRows) {
    const empId = Number(row.employee_id);
    if (!Number.isFinite(empId)) continue;
    const cur: IAssignmentRow = {
      id: String(row.id),
      employee_id: empId,
      org_department_id: String(row.org_department_id),
      effective_from: String(row.effective_from),
      effective_to: null,
    };
    const existing = openByEmployee.get(empId);
    if (!existing || cur.effective_from > existing.effective_from) {
      openByEmployee.set(empId, cur);
    }
  }

  const candidateEmployeeIds = [...openByEmployee.keys()];
  if (candidateEmployeeIds.length === 0) return [];

  // 2) Закрытые назначения этих сотрудников.
  const { data: closedRows, error: closedErr } = await supabase
    .from('employee_assignments')
    .select('id, employee_id, org_department_id, effective_from, effective_to')
    .in('employee_id', candidateEmployeeIds)
    .not('effective_to', 'is', null);
  if (closedErr) throw closedErr;

  // Для каждого сотрудника берём последнее закрытое (по effective_to desc).
  const lastClosedByEmployee = new Map<number, IAssignmentRow>();
  for (const row of closedRows || []) {
    const empId = Number(row.employee_id);
    if (!Number.isFinite(empId)) continue;
    const cur: IAssignmentRow = {
      id: String(row.id),
      employee_id: empId,
      org_department_id: String(row.org_department_id),
      effective_from: String(row.effective_from),
      effective_to: (row.effective_to as string | null) ?? null,
    };
    const existing = lastClosedByEmployee.get(empId);
    if (!existing || (cur.effective_to ?? '') > (existing.effective_to ?? '')) {
      lastClosedByEmployee.set(empId, cur);
    }
  }

  // 3) Подгружаем сотрудников и отделы.
  const employeeIds = candidateEmployeeIds;
  const deptIds = new Set<string>();
  for (const a of openByEmployee.values()) deptIds.add(a.org_department_id);
  for (const a of lastClosedByEmployee.values()) deptIds.add(a.org_department_id);

  const [{ data: employeesRows, error: empErr }, { data: deptRows, error: deptErr }] = await Promise.all([
    supabase
      .from('employees')
      .select('id, full_name, position_id, is_archived, employment_status')
      .in('id', employeeIds),
    deptIds.size > 0
      ? supabase.from('org_departments').select('id, name').in('id', [...deptIds])
      : Promise.resolve({ data: [] as Array<{ id: string; name: string }>, error: null }),
  ]);
  if (empErr) throw empErr;
  if (deptErr) throw deptErr;

  const nameByEmployee = new Map<number, string>();
  const archivedSet = new Set<number>();
  const positionIdByEmployee = new Map<number, string | null>();
  for (const row of employeesRows || []) {
    const empId = Number(row.id);
    nameByEmployee.set(empId, String(row.full_name || ''));
    if (row.is_archived || row.employment_status !== 'active') archivedSet.add(empId);
    positionIdByEmployee.set(empId, (row.position_id as string | null) ?? null);
  }
  const deptNameById = new Map<string, string>();
  for (const row of deptRows || []) {
    deptNameById.set(String(row.id), String(row.name || ''));
  }

  const positionIds = [...new Set([...positionIdByEmployee.values()].filter((v): v is string => !!v))];
  const positionNameById = new Map<string, string>();
  if (positionIds.length > 0) {
    const { data: posRows, error: posErr } = await supabase
      .from('positions')
      .select('id, name')
      .in('id', positionIds);
    if (posErr) throw posErr;
    for (const row of posRows || []) {
      positionNameById.set(String(row.id), String(row.name || ''));
    }
  }

  // 4) Собираем строки переводов.
  const queryLower = args.query.toLowerCase();
  const result: ITransferAdminRow[] = [];
  for (const empId of candidateEmployeeIds) {
    if (archivedSet.has(empId)) continue;
    const newA = openByEmployee.get(empId);
    const oldA = lastClosedByEmployee.get(empId);
    if (!newA || !oldA) continue;
    if (newA.org_department_id === oldA.org_department_id) continue;

    const fullName = nameByEmployee.get(empId) || '';
    if (queryLower && !fullName.toLowerCase().includes(queryLower)) continue;
    if (
      args.deptFilter
      && newA.org_department_id !== args.deptFilter
      && oldA.org_department_id !== args.deptFilter
    ) continue;

    const positionId = positionIdByEmployee.get(empId);
    result.push({
      assignment_new_id: newA.id,
      assignment_old_id: oldA.id,
      employee_id: empId,
      employee_full_name: fullName,
      to_department_id: newA.org_department_id,
      to_department_name: deptNameById.get(newA.org_department_id) || '',
      transfer_date: newA.effective_from,
      from_department_id: oldA.org_department_id,
      from_department_name: deptNameById.get(oldA.org_department_id) || '',
      employee_position: positionId ? positionNameById.get(positionId) || null : null,
    });
  }

  result.sort((a, b) => (a.transfer_date > b.transfer_date ? -1 : a.transfer_date < b.transfer_date ? 1 : 0));
  return result;
}

async function buildAllExclusions(args: IBuildArgs): Promise<IExclusionAdminRow[]> {
  let q = supabase
    .from('employees')
    .select('id, full_name, position_id, org_department_id, excluded_from_timesheet_date, excluded_from_timesheet_at')
    .eq('excluded_from_timesheet', true)
    .eq('is_archived', false);
  if (args.dateFrom) q = q.gte('excluded_from_timesheet_date', args.dateFrom);
  if (args.dateTo) q = q.lte('excluded_from_timesheet_date', args.dateTo);
  if (args.deptFilter) q = q.eq('org_department_id', args.deptFilter);
  if (args.query) q = q.ilike('full_name', `%${escapeLike(args.query)}%`);

  const { data, error } = await q;
  if (error) throw error;

  const rows = data || [];
  if (rows.length === 0) return [];

  const deptIds = [...new Set(rows.map(r => r.org_department_id).filter((v): v is string => !!v))];
  const positionIds = [...new Set(rows.map(r => r.position_id).filter((v): v is string => !!v))];

  const [{ data: deptRows, error: deptErr }, { data: posRows, error: posErr }] = await Promise.all([
    deptIds.length > 0
      ? supabase.from('org_departments').select('id, name').in('id', deptIds)
      : Promise.resolve({ data: [] as Array<{ id: string; name: string }>, error: null }),
    positionIds.length > 0
      ? supabase.from('positions').select('id, name').in('id', positionIds)
      : Promise.resolve({ data: [] as Array<{ id: string; name: string }>, error: null }),
  ]);
  if (deptErr) throw deptErr;
  if (posErr) throw posErr;

  const deptNameById = new Map<string, string>();
  for (const row of deptRows || []) deptNameById.set(String(row.id), String(row.name || ''));
  const positionNameById = new Map<string, string>();
  for (const row of posRows || []) positionNameById.set(String(row.id), String(row.name || ''));

  const result: IExclusionAdminRow[] = rows.map(row => {
    const deptId = (row.org_department_id as string | null) ?? null;
    const posId = (row.position_id as string | null) ?? null;
    return {
      employee_id: Number(row.id),
      employee_full_name: String(row.full_name || ''),
      exclusion_date: (row.excluded_from_timesheet_date as string | null) ?? null,
      excluded_at: (row.excluded_from_timesheet_at as string | null) ?? null,
      department_id: deptId,
      department_name: deptId ? deptNameById.get(deptId) || '' : '',
      employee_position: posId ? positionNameById.get(posId) || null : null,
    };
  });

  result.sort((a, b) => {
    const ad = a.exclusion_date || '';
    const bd = b.exclusion_date || '';
    return ad > bd ? -1 : ad < bd ? 1 : 0;
  });

  return result;
}
