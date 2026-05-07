import { supabase } from '../config/database.js';

export interface IDirectReportRow {
  id: string;
  subordinate_employee_id: number;
  manager_employee_id: number;
  assigned_at: string;
  assigned_by: string | null;
  unassigned_at: string | null;
  is_active: boolean;
  note: string | null;
}

export interface IDirectReportWithEmployee extends IDirectReportRow {
  subordinate?: {
    id: number;
    full_name: string | null;
    org_department_id: string | null;
    position_id: number | null;
  } | null;
  manager?: {
    id: number;
    full_name: string | null;
    org_department_id: string | null;
    position_id: number | null;
  } | null;
}

let missingTableWarned = false;

function isMissingTableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error ? String((error as { code?: unknown }).code || '') : '';
  const message = 'message' in error ? String((error as { message?: unknown }).message || '') : '';
  return code === 'PGRST205'
    || message.includes("Could not find the table 'public.employee_direct_reports'");
}

function warnMissingTable(): void {
  if (missingTableWarned) return;
  missingTableWarned = true;
  console.warn(
    '[employee-direct-reports] table public.employee_direct_reports not found; direct supervisor links are disabled.',
  );
}

/**
 * Активные подчинённые (employee_id) для конкретного руководителя.
 */
export async function listDirectSubordinates(managerEmployeeId: number): Promise<number[]> {
  if (!Number.isInteger(managerEmployeeId) || managerEmployeeId <= 0) return [];
  const { data, error } = await supabase
    .from('employee_direct_reports')
    .select('subordinate_employee_id')
    .eq('manager_employee_id', managerEmployeeId)
    .eq('is_active', true);

  if (error) {
    if (isMissingTableError(error)) {
      warnMissingTable();
      return [];
    }
    throw error;
  }

  return [...new Set(
    (data || [])
      .map(row => row.subordinate_employee_id as number | null)
      .filter((id): id is number => Number.isInteger(id)),
  )];
}

/**
 * Активный руководитель для подчинённого (или null, если не назначен).
 * Используется в UI для проверки эксклюзивности перед назначением.
 */
export async function getActiveDirectManagerFor(
  subordinateEmployeeId: number,
): Promise<number | null> {
  if (!Number.isInteger(subordinateEmployeeId) || subordinateEmployeeId <= 0) return null;
  const { data, error } = await supabase
    .from('employee_direct_reports')
    .select('manager_employee_id')
    .eq('subordinate_employee_id', subordinateEmployeeId)
    .eq('is_active', true)
    .maybeSingle();

  if (error) {
    if (isMissingTableError(error)) {
      warnMissingTable();
      return null;
    }
    throw error;
  }

  return (data?.manager_employee_id as number | null) ?? null;
}

/**
 * Список назначений с раскрытыми employee-полями.
 * Если managerEmployeeId не передан — возвращает все активные связи (для админ-панели).
 */
export async function listDirectReports(
  options: { managerEmployeeId?: number; includeInactive?: boolean } = {},
): Promise<IDirectReportWithEmployee[]> {
  let query = supabase
    .from('employee_direct_reports')
    .select(
      `
        id,
        subordinate_employee_id,
        manager_employee_id,
        assigned_at,
        assigned_by,
        unassigned_at,
        is_active,
        note
      `,
    )
    .order('assigned_at', { ascending: false });

  if (options.managerEmployeeId != null) {
    query = query.eq('manager_employee_id', options.managerEmployeeId);
  }
  if (!options.includeInactive) {
    query = query.eq('is_active', true);
  }

  const { data, error } = await query;
  if (error) {
    if (isMissingTableError(error)) {
      warnMissingTable();
      return [];
    }
    throw error;
  }

  const rows = (data || []) as IDirectReportRow[];
  if (rows.length === 0) return [];

  const employeeIds = [...new Set(rows.flatMap(r => [r.subordinate_employee_id, r.manager_employee_id]))];
  const { data: employees, error: empError } = await supabase
    .from('employees')
    .select('id, full_name, org_department_id, position_id')
    .in('id', employeeIds);
  if (empError) throw empError;

  const employeeMap = new Map<number, { id: number; full_name: string | null; org_department_id: string | null; position_id: number | null }>(
    (employees || []).map(e => [
      e.id as number,
      {
        id: e.id as number,
        full_name: (e.full_name as string | null) ?? null,
        org_department_id: (e.org_department_id as string | null) ?? null,
        position_id: (e.position_id as number | null) ?? null,
      },
    ]),
  );

  return rows.map(row => ({
    ...row,
    subordinate: employeeMap.get(row.subordinate_employee_id) ?? null,
    manager: employeeMap.get(row.manager_employee_id) ?? null,
  }));
}

export interface IAssignDirectReportInput {
  managerEmployeeId: number;
  subordinateEmployeeId: number;
  assignedBy?: string | null;
  note?: string | null;
}

export type AssignDirectReportResult =
  | { ok: true; row: IDirectReportRow }
  | { ok: false; reason: 'already_assigned'; existingManagerEmployeeId: number }
  | { ok: false; reason: 'self_report' }
  | { ok: false; reason: 'employee_not_found' };

export async function assignDirectReport(
  input: IAssignDirectReportInput,
): Promise<AssignDirectReportResult> {
  const managerId = Number(input.managerEmployeeId);
  const subId = Number(input.subordinateEmployeeId);
  if (!Number.isInteger(managerId) || !Number.isInteger(subId) || managerId <= 0 || subId <= 0) {
    return { ok: false, reason: 'employee_not_found' };
  }
  if (managerId === subId) {
    return { ok: false, reason: 'self_report' };
  }

  const { data: employees, error: empError } = await supabase
    .from('employees')
    .select('id')
    .in('id', [managerId, subId]);
  if (empError) throw empError;
  if ((employees || []).length < 2) {
    return { ok: false, reason: 'employee_not_found' };
  }

  const existingManager = await getActiveDirectManagerFor(subId);
  if (existingManager != null && existingManager !== managerId) {
    return { ok: false, reason: 'already_assigned', existingManagerEmployeeId: existingManager };
  }
  if (existingManager === managerId) {
    const { data: existingRow, error: existingErr } = await supabase
      .from('employee_direct_reports')
      .select('id, subordinate_employee_id, manager_employee_id, assigned_at, assigned_by, unassigned_at, is_active, note')
      .eq('subordinate_employee_id', subId)
      .eq('manager_employee_id', managerId)
      .eq('is_active', true)
      .maybeSingle();
    if (existingErr) throw existingErr;
    if (existingRow) return { ok: true, row: existingRow as IDirectReportRow };
  }

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('employee_direct_reports')
    .insert({
      subordinate_employee_id: subId,
      manager_employee_id: managerId,
      assigned_at: now,
      assigned_by: input.assignedBy ?? null,
      is_active: true,
      note: input.note ?? null,
      created_at: now,
      updated_at: now,
    })
    .select('id, subordinate_employee_id, manager_employee_id, assigned_at, assigned_by, unassigned_at, is_active, note')
    .single();

  if (error) {
    const code = (error as { code?: string }).code;
    if (code === '23505') {
      const refreshedManager = await getActiveDirectManagerFor(subId);
      return {
        ok: false,
        reason: 'already_assigned',
        existingManagerEmployeeId: refreshedManager ?? -1,
      };
    }
    throw error;
  }

  return { ok: true, row: data as IDirectReportRow };
}

export async function unassignDirectReportById(rowId: string): Promise<boolean> {
  if (!rowId) return false;
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('employee_direct_reports')
    .update({ is_active: false, unassigned_at: now, updated_at: now })
    .eq('id', rowId)
    .eq('is_active', true)
    .select('id')
    .maybeSingle();
  if (error) {
    if (isMissingTableError(error)) {
      warnMissingTable();
      return false;
    }
    throw error;
  }
  return !!data;
}

export async function unassignDirectReportByEmployees(
  managerEmployeeId: number,
  subordinateEmployeeId: number,
): Promise<boolean> {
  if (!Number.isInteger(managerEmployeeId) || !Number.isInteger(subordinateEmployeeId)) return false;
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('employee_direct_reports')
    .update({ is_active: false, unassigned_at: now, updated_at: now })
    .eq('manager_employee_id', managerEmployeeId)
    .eq('subordinate_employee_id', subordinateEmployeeId)
    .eq('is_active', true)
    .select('id')
    .maybeSingle();
  if (error) {
    if (isMissingTableError(error)) {
      warnMissingTable();
      return false;
    }
    throw error;
  }
  return !!data;
}
