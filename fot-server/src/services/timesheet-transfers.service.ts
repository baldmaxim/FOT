import { query, queryOne, withTransaction } from '../config/postgres.js';
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

interface IAssignmentRawRow {
  id: string | number;
  employee_id: number | string;
  org_department_id: string;
  effective_from: string;
  effective_to: string | null;
}

const mapAssignmentRow = (row: IAssignmentRawRow): IAssignmentRow => ({
  id: String(row.id),
  employee_id: Number(row.employee_id),
  org_department_id: String(row.org_department_id),
  effective_from: String(row.effective_from),
  effective_to: row.effective_to ?? null,
});

async function loadAssignmentsByIds(ids: string[]): Promise<IAssignmentRow[]> {
  if (ids.length === 0) return [];
  const rows = await query<IAssignmentRawRow>(
    `SELECT id, employee_id, org_department_id, effective_from, effective_to
       FROM employee_assignments
       WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  return rows.map(mapAssignmentRow);
}

async function loadAssignmentById(id: string): Promise<IAssignmentRow | null> {
  const row = await queryOne<IAssignmentRawRow>(
    `SELECT id, employee_id, org_department_id, effective_from, effective_to
       FROM employee_assignments
       WHERE id = $1
       LIMIT 1`,
    [id],
  );
  if (!row) return null;
  return mapAssignmentRow(row);
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
  const strict = await queryOne<IAssignmentRawRow>(
    `SELECT id, employee_id, org_department_id, effective_from, effective_to
       FROM employee_assignments
       WHERE employee_id = $1
         AND effective_to = $2
       ORDER BY effective_from DESC
       LIMIT 1`,
    [assignment.employee_id, expectedClose],
  );
  if (strict) {
    return mapAssignmentRow(strict);
  }

  const lenient = await queryOne<IAssignmentRawRow>(
    `SELECT id, employee_id, org_department_id, effective_from, effective_to
       FROM employee_assignments
       WHERE employee_id = $1
         AND id <> $2
         AND effective_to IS NOT NULL
         AND effective_to < $3
       ORDER BY effective_to DESC
       LIMIT 1`,
    [assignment.employee_id, assignment.id, assignment.effective_from],
  );
  if (!lenient) return null;
  return mapAssignmentRow(lenient);
}

/**
 * Список переводов и исключений по конкретному отделу.
 *
 * Перевод: сотрудник, у которого есть закрытое назначение в этом отделе и текущее открытое — в другом.
 * Исключение: сотрудник с employees.org_department_id = departmentId и excluded_from_timesheet = true.
 */
export async function listDepartmentTransfers(departmentId: string): Promise<IDepartmentTransfersListing> {
  // 1) Закрытые назначения в этом отделе.
  const closedHere = await query<IAssignmentRawRow>(
    `SELECT id, employee_id, org_department_id, effective_from, effective_to
       FROM employee_assignments
       WHERE org_department_id = $1
         AND effective_to IS NOT NULL
       ORDER BY effective_to DESC`,
    [departmentId],
  );

  const lastClosedByEmployee = new Map<number, IAssignmentRow>();
  for (const row of closedHere) {
    const cur = mapAssignmentRow(row);
    if (!Number.isFinite(cur.employee_id)) continue;
    const existing = lastClosedByEmployee.get(cur.employee_id);
    if (!existing || (cur.effective_to ?? '') > (existing.effective_to ?? '')) {
      lastClosedByEmployee.set(cur.employee_id, cur);
    }
  }

  const candidateEmployeeIds = [...lastClosedByEmployee.keys()];

  // 2) Текущие открытые назначения этих сотрудников.
  const transfers: ITransferRow[] = [];
  if (candidateEmployeeIds.length > 0) {
    const openRows = await query<IAssignmentRawRow>(
      `SELECT id, employee_id, org_department_id, effective_from, effective_to
         FROM employee_assignments
         WHERE employee_id = ANY($1::int[])
           AND effective_to IS NULL`,
      [candidateEmployeeIds],
    );

    const openByEmployee = new Map<number, IAssignmentRow>();
    for (const row of openRows) {
      const cur = mapAssignmentRow(row);
      if (!Number.isFinite(cur.employee_id)) continue;
      const existing = openByEmployee.get(cur.employee_id);
      if (!existing || cur.effective_from > existing.effective_from) {
        openByEmployee.set(cur.employee_id, cur);
      }
    }

    // 3) Подгружаем имена сотрудников и названия целевых отделов.
    const targetDeptIds = [...new Set([...openByEmployee.values()].map(a => a.org_department_id))];
    const [employeesRows, deptRows] = await Promise.all([
      query<{ id: number; full_name: string | null; is_archived: boolean; employment_status: string | null }>(
        `SELECT id, full_name, is_archived, employment_status
           FROM employees
           WHERE id = ANY($1::int[])`,
        [candidateEmployeeIds],
      ),
      targetDeptIds.length > 0
        ? query<{ id: string; name: string | null }>(
          `SELECT id, name FROM org_departments WHERE id = ANY($1::uuid[])`,
          [targetDeptIds],
        )
        : Promise.resolve([] as Array<{ id: string; name: string | null }>),
    ]);

    const nameByEmployee = new Map<number, string>();
    const archivedSet = new Set<number>();
    for (const row of employeesRows) {
      const empId = Number(row.id);
      nameByEmployee.set(empId, String(row.full_name || ''));
      if (row.is_archived || row.employment_status !== 'active') archivedSet.add(empId);
    }
    const deptNameById = new Map<string, string>();
    for (const row of deptRows) {
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
  const excludedRows = await query<{
    id: number;
    full_name: string | null;
    excluded_from_timesheet_date: string | null;
    excluded_from_timesheet_at: string | null;
  }>(
    `SELECT id, full_name, excluded_from_timesheet_date, excluded_from_timesheet_at
       FROM employees
       WHERE org_department_id = $1
         AND excluded_from_timesheet = true
         AND is_archived = false`,
    [departmentId],
  );

  const exclusions: IExclusionRow[] = excludedRows.map(row => ({
    employee_id: Number(row.id),
    employee_full_name: String(row.full_name || ''),
    exclusion_date: row.excluded_from_timesheet_date ?? null,
    excluded_at: row.excluded_from_timesheet_at ?? null,
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
  const row = await queryOne<{ id: string }>(
    `SELECT id FROM org_departments WHERE id = $1 LIMIT 1`,
    [deptId],
  );
  if (!row) throw new Error('Отдел не найден');
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
    const overlap = await query<{ id: string }>(
      `SELECT id
         FROM employee_assignments
         WHERE employee_id = $1
           AND id <> $2
           AND id <> $3
           AND effective_from <= $4
           AND (effective_to IS NULL OR effective_to >= $5)`,
      [newA.employee_id, oldA.id, newA.id, previousDay, oldA.effective_from],
    );
    if (overlap.length > 0) {
      throw new Error('Новая дата пересекается с другими назначениями сотрудника');
    }
  }

  const nowIso = new Date().toISOString();

  await withTransaction(async (client) => {
    const oldUpdates: string[] = ['updated_at = $1'];
    const oldParams: unknown[] = [nowIso];
    if (dateChanged) {
      oldParams.push(previousDay);
      oldUpdates.push(`effective_to = $${oldParams.length}`);
    }
    if (fromDeptChanged) {
      oldParams.push(nextFromDept);
      oldUpdates.push(`org_department_id = $${oldParams.length}`);
    }
    if (oldUpdates.length > 1) {
      oldParams.push(oldA.id);
      await client.query(
        `UPDATE employee_assignments
           SET ${oldUpdates.join(', ')}
           WHERE id = $${oldParams.length}`,
        oldParams,
      );
    }

    const newUpdates: string[] = ['updated_at = $1'];
    const newParams: unknown[] = [nowIso];
    if (dateChanged) {
      newParams.push(nextDate);
      newUpdates.push(`effective_from = $${newParams.length}`);
    }
    if (toDeptChanged) {
      newParams.push(nextToDept);
      newUpdates.push(`org_department_id = $${newParams.length}`);
    }
    if (newUpdates.length > 1) {
      newParams.push(newA.id);
      await client.query(
        `UPDATE employee_assignments
           SET ${newUpdates.join(', ')}
           WHERE id = $${newParams.length}`,
        newParams,
      );
    }

    if (toDeptChanged) {
      await client.query(
        `UPDATE employees
           SET org_department_id = $1, updated_at = $2
           WHERE id = $3`,
        [nextToDept, nowIso, newA.employee_id],
      );
    }
  });

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

function wrapPgError(err: unknown, fallback: string): Error {
  if (err instanceof Error) return err;
  if (err && typeof err === 'object') {
    const obj = err as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown };
    const parts: string[] = [];
    if (typeof obj.message === 'string' && obj.message) parts.push(obj.message);
    if (typeof obj.details === 'string' && obj.details) parts.push(obj.details);
    if (typeof obj.hint === 'string' && obj.hint) parts.push(obj.hint);
    if (parts.length > 0) return new Error(parts.join(' — '));
  }
  return new Error(fallback);
}

/**
 * Полная отмена перевода: удаляет новое назначение, открывает старое (effective_to=NULL),
 * возвращает employees.org_department_id к старому отделу. Sigur не трогается.
 *
 * Возвращает null, если парное закрытое назначение не найдено — вызывающий код решает,
 * как трактовать (deleteTransfer кидает ошибку, deleteAssignment бросает свой текст).
 *
 * Порядок операций важен: триггер trg_ensure_no_overlapping_employee_assignments
 * не пускает пересечение диапазонов на BEFORE UPDATE/INSERT. Если просто переоткрыть
 * old (effective_to=NULL) пока new ещё жив — оба диапазона [from, ∞) пересекаются.
 * Поэтому сначала выправляем инвариант (old.effective_to = new.effective_from − 1),
 * затем удаляем new, и только потом переоткрываем old.
 */
export async function tryDeleteTransfer(assignmentNewId: string): Promise<IDeleteTransferResult | null> {
  // Полная копия new — нужна, чтобы восстановить через INSERT, если переоткрытие old свалится.
  let fullNew: Record<string, unknown> | null;
  try {
    fullNew = await queryOne<Record<string, unknown>>(
      `SELECT * FROM employee_assignments WHERE id = $1 LIMIT 1`,
      [assignmentNewId],
    );
  } catch (err) {
    throw wrapPgError(err, 'Не удалось загрузить назначение');
  }
  if (!fullNew) throw new Error('Назначение не найдено');
  if ((fullNew.effective_to as string | null) != null) {
    throw new Error('Назначение уже закрыто, отмена не выполняется');
  }

  const newA: IAssignmentRow = {
    id: String(fullNew.id),
    employee_id: Number(fullNew.employee_id),
    org_department_id: String(fullNew.org_department_id),
    effective_from: String(fullNew.effective_from),
    effective_to: null,
  };

  const oldA = await findPreviousClosedAssignment(newA);
  if (!oldA) return null;

  const nowIso = new Date().toISOString();
  const expectedClose = formatDateShift(newA.effective_from, -1);

  try {
    await withTransaction(async (client) => {
      // Шаг 1: выправить инвариант на old (закрытое не пересекается с открытым new).
      await client.query(
        `UPDATE employee_assignments
           SET effective_to = $1, updated_at = $2
           WHERE id = $3`,
        [expectedClose, nowIso, oldA.id],
      );

      // Шаг 2: удалить new.
      await client.query(
        `DELETE FROM employee_assignments WHERE id = $1`,
        [newA.id],
      );

      // Шаг 3: переоткрыть old.
      await client.query(
        `UPDATE employee_assignments
           SET effective_to = NULL, updated_at = $1
           WHERE id = $2`,
        [nowIso, oldA.id],
      );

      // Шаг 4: синхронизируем employees.org_department_id.
      await client.query(
        `UPDATE employees
           SET org_department_id = $1, updated_at = $2
           WHERE id = $3`,
        [oldA.org_department_id, nowIso, newA.employee_id],
      );
    });
  } catch (err) {
    throw wrapPgError(err, 'Не удалось отменить перевод');
  }

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
  const emp = await queryOne<{
    id: number;
    excluded_from_timesheet: boolean;
    org_department_id: string | null;
  }>(
    `SELECT id, excluded_from_timesheet, org_department_id
       FROM employees
       WHERE id = $1
       LIMIT 1`,
    [employeeId],
  );
  if (!emp) throw new Error('Сотрудник не найден');
  if (!emp.excluded_from_timesheet) throw new Error('Сотрудник не исключён из табеля');

  const previousDay = formatDateShift(newDate, -1);
  const nowIso = new Date().toISOString();

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE employees
         SET excluded_from_timesheet_date = $1, updated_at = $2
         WHERE id = $3`,
      [newDate, nowIso, employeeId],
    );

    if (emp.org_department_id) {
      // Подзапрос на последнее закрытое назначение сотрудника в этом отделе.
      await client.query(
        `UPDATE employee_assignments
           SET effective_to = $1, updated_at = $2
           WHERE id = (
             SELECT id
               FROM employee_assignments
               WHERE employee_id = $3
                 AND org_department_id = $4
                 AND effective_to IS NOT NULL
               ORDER BY effective_to DESC
               LIMIT 1
           )`,
        [previousDay, nowIso, employeeId, String(emp.org_department_id)],
      );
    }
  });

  return { employee_id: employeeId, excluded_from_timesheet_date: newDate };
}

export interface IDeleteExclusionResult {
  employee_id: number;
  reopened_assignment_id: string | null;
}

export async function deleteExclusion(employeeId: number): Promise<IDeleteExclusionResult> {
  const emp = await queryOne<{
    id: number;
    excluded_from_timesheet: boolean;
    org_department_id: string | null;
    excluded_from_timesheet_date: string | null;
  }>(
    `SELECT id, excluded_from_timesheet, org_department_id, excluded_from_timesheet_date
       FROM employees
       WHERE id = $1
       LIMIT 1`,
    [employeeId],
  );
  if (!emp) throw new Error('Сотрудник не найден');
  if (!emp.excluded_from_timesheet) throw new Error('Сотрудник не исключён из табеля');

  const nowIso = new Date().toISOString();

  let reopenedAssignmentId: string | null = null;

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE employees
         SET excluded_from_timesheet = false,
             excluded_from_timesheet_at = NULL,
             excluded_from_timesheet_date = NULL,
             updated_at = $1
         WHERE id = $2`,
      [nowIso, employeeId],
    );

    if (emp.org_department_id) {
      const lastClosed = await client.query<{ id: string }>(
        `SELECT id
           FROM employee_assignments
           WHERE employee_id = $1
             AND org_department_id = $2
             AND effective_to IS NOT NULL
           ORDER BY effective_to DESC
           LIMIT 1`,
        [employeeId, String(emp.org_department_id)],
      );
      const lastClosedRow = lastClosed.rows[0];
      if (lastClosedRow) {
        await client.query(
          `UPDATE employee_assignments
             SET effective_to = NULL, updated_at = $1
             WHERE id = $2`,
          [nowIso, String(lastClosedRow.id)],
        );
        reopenedAssignmentId = String(lastClosedRow.id);
      }
    }
  });

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
  const openWhere: string[] = ['effective_to IS NULL'];
  const openParams: unknown[] = [];
  if (args.dateFrom) {
    openParams.push(args.dateFrom);
    openWhere.push(`effective_from >= $${openParams.length}`);
  }
  if (args.dateTo) {
    openParams.push(args.dateTo);
    openWhere.push(`effective_from <= $${openParams.length}`);
  }
  const openRows = await query<IAssignmentRawRow>(
    `SELECT id, employee_id, org_department_id, effective_from, effective_to
       FROM employee_assignments
       WHERE ${openWhere.join(' AND ')}`,
    openParams,
  );

  if (openRows.length === 0) return [];

  // Группируем по сотруднику, оставляем последнее открытое.
  const openByEmployee = new Map<number, IAssignmentRow>();
  for (const row of openRows) {
    const cur = mapAssignmentRow(row);
    if (!Number.isFinite(cur.employee_id)) continue;
    const existing = openByEmployee.get(cur.employee_id);
    if (!existing || cur.effective_from > existing.effective_from) {
      openByEmployee.set(cur.employee_id, cur);
    }
  }

  const candidateEmployeeIds = [...openByEmployee.keys()];
  if (candidateEmployeeIds.length === 0) return [];

  // 2) Закрытые назначения этих сотрудников.
  const closedRows = await query<IAssignmentRawRow>(
    `SELECT id, employee_id, org_department_id, effective_from, effective_to
       FROM employee_assignments
       WHERE employee_id = ANY($1::int[])
         AND effective_to IS NOT NULL`,
    [candidateEmployeeIds],
  );

  // Для каждого сотрудника берём последнее закрытое (по effective_to desc).
  const lastClosedByEmployee = new Map<number, IAssignmentRow>();
  for (const row of closedRows) {
    const cur = mapAssignmentRow(row);
    if (!Number.isFinite(cur.employee_id)) continue;
    const existing = lastClosedByEmployee.get(cur.employee_id);
    if (!existing || (cur.effective_to ?? '') > (existing.effective_to ?? '')) {
      lastClosedByEmployee.set(cur.employee_id, cur);
    }
  }

  // 3) Подгружаем сотрудников и отделы.
  const employeeIds = candidateEmployeeIds;
  const deptIds = new Set<string>();
  for (const a of openByEmployee.values()) deptIds.add(a.org_department_id);
  for (const a of lastClosedByEmployee.values()) deptIds.add(a.org_department_id);

  const [employeesRows, deptRows] = await Promise.all([
    query<{ id: number; full_name: string | null; position_id: string | null; is_archived: boolean; employment_status: string | null }>(
      `SELECT id, full_name, position_id, is_archived, employment_status
         FROM employees
         WHERE id = ANY($1::int[])`,
      [employeeIds],
    ),
    deptIds.size > 0
      ? query<{ id: string; name: string | null }>(
        `SELECT id, name FROM org_departments WHERE id = ANY($1::uuid[])`,
        [[...deptIds]],
      )
      : Promise.resolve([] as Array<{ id: string; name: string | null }>),
  ]);

  const nameByEmployee = new Map<number, string>();
  const archivedSet = new Set<number>();
  const positionIdByEmployee = new Map<number, string | null>();
  for (const row of employeesRows) {
    const empId = Number(row.id);
    nameByEmployee.set(empId, String(row.full_name || ''));
    if (row.is_archived || row.employment_status !== 'active') archivedSet.add(empId);
    positionIdByEmployee.set(empId, row.position_id ?? null);
  }
  const deptNameById = new Map<string, string>();
  for (const row of deptRows) {
    deptNameById.set(String(row.id), String(row.name || ''));
  }

  const positionIds = [...new Set([...positionIdByEmployee.values()].filter((v): v is string => !!v))];
  const positionNameById = new Map<string, string>();
  if (positionIds.length > 0) {
    const posRows = await query<{ id: string; name: string | null }>(
      `SELECT id, name FROM positions WHERE id = ANY($1::uuid[])`,
      [positionIds],
    );
    for (const row of posRows) {
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
  const where: string[] = ['excluded_from_timesheet = true', 'is_archived = false'];
  const params: unknown[] = [];
  if (args.dateFrom) {
    params.push(args.dateFrom);
    where.push(`excluded_from_timesheet_date >= $${params.length}`);
  }
  if (args.dateTo) {
    params.push(args.dateTo);
    where.push(`excluded_from_timesheet_date <= $${params.length}`);
  }
  if (args.deptFilter) {
    params.push(args.deptFilter);
    where.push(`org_department_id = $${params.length}`);
  }
  if (args.query) {
    params.push(`%${escapeLike(args.query)}%`);
    where.push(`full_name ILIKE $${params.length}`);
  }

  const rows = await query<{
    id: number;
    full_name: string | null;
    position_id: string | null;
    org_department_id: string | null;
    excluded_from_timesheet_date: string | null;
    excluded_from_timesheet_at: string | null;
  }>(
    `SELECT id, full_name, position_id, org_department_id, excluded_from_timesheet_date, excluded_from_timesheet_at
       FROM employees
       WHERE ${where.join(' AND ')}`,
    params,
  );

  if (rows.length === 0) return [];

  const deptIds = [...new Set(rows.map(r => r.org_department_id).filter((v): v is string => !!v))];
  const positionIds = [...new Set(rows.map(r => r.position_id).filter((v): v is string => !!v))];

  const [deptRows, posRows] = await Promise.all([
    deptIds.length > 0
      ? query<{ id: string; name: string | null }>(
        `SELECT id, name FROM org_departments WHERE id = ANY($1::uuid[])`,
        [deptIds],
      )
      : Promise.resolve([] as Array<{ id: string; name: string | null }>),
    positionIds.length > 0
      ? query<{ id: string; name: string | null }>(
        `SELECT id, name FROM positions WHERE id = ANY($1::uuid[])`,
        [positionIds],
      )
      : Promise.resolve([] as Array<{ id: string; name: string | null }>),
  ]);

  const deptNameById = new Map<string, string>();
  for (const row of deptRows) deptNameById.set(String(row.id), String(row.name || ''));
  const positionNameById = new Map<string, string>();
  for (const row of posRows) positionNameById.set(String(row.id), String(row.name || ''));

  const result: IExclusionAdminRow[] = rows.map(row => {
    const deptId = row.org_department_id ?? null;
    const posId = row.position_id ?? null;
    return {
      employee_id: Number(row.id),
      employee_full_name: String(row.full_name || ''),
      exclusion_date: row.excluded_from_timesheet_date ?? null,
      excluded_at: row.excluded_from_timesheet_at ?? null,
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
