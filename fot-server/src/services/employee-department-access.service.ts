import { supabase } from '../config/database.js';

export type EmployeeDepartmentAccessSource =
  | 'manual_admin_ui'
  | 'sigur_sync'
  | 'portal_lifecycle';

const TECHNICAL_SOURCES: EmployeeDepartmentAccessSource[] = ['sigur_sync', 'portal_lifecycle'];

export async function upsertTechnicalDepartmentAccess(
  employeeId: number,
  currentDepartmentId: string,
  previousDepartmentId: string | null,
  source: 'sigur_sync' | 'portal_lifecycle' = 'sigur_sync',
): Promise<void> {
  if (!employeeId || !currentDepartmentId) return;
  const now = new Date().toISOString();

  if (previousDepartmentId && previousDepartmentId !== currentDepartmentId) {
    const { error: deactivateError } = await supabase
      .from('employee_department_access')
      .update({ is_active: false, updated_at: now })
      .eq('employee_id', employeeId)
      .eq('department_id', previousDepartmentId)
      .in('source', TECHNICAL_SOURCES);
    if (deactivateError) throw deactivateError;
  }

  const { data: existing, error: selectError } = await supabase
    .from('employee_department_access')
    .select('source, is_active')
    .eq('employee_id', employeeId)
    .eq('department_id', currentDepartmentId)
    .maybeSingle();
  if (selectError) throw selectError;

  if (existing) {
    if (!existing.is_active) {
      const { error: activateError } = await supabase
        .from('employee_department_access')
        .update({ is_active: true, updated_at: now })
        .eq('employee_id', employeeId)
        .eq('department_id', currentDepartmentId);
      if (activateError) throw activateError;
    }
    return;
  }

  const { error: insertError } = await supabase
    .from('employee_department_access')
    .insert({
      employee_id: employeeId,
      department_id: currentDepartmentId,
      source,
      is_active: true,
      created_at: now,
      updated_at: now,
    });
  if (insertError) throw insertError;
}

export async function deactivateAllDepartmentAccessForEmployee(
  employeeId: number,
): Promise<void> {
  if (!employeeId) return;
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('employee_department_access')
    .update({ is_active: false, updated_at: now })
    .eq('employee_id', employeeId)
    .eq('is_active', true);
  if (error) throw error;
}

export async function batchUpsertTechnicalDepartmentAccess(
  items: Array<{ employeeId: number; currentDepartmentId: string; previousDepartmentId: string | null }>,
  source: 'sigur_sync' | 'portal_lifecycle' = 'sigur_sync',
): Promise<void> {
  for (const item of items) {
    await upsertTechnicalDepartmentAccess(
      item.employeeId,
      item.currentDepartmentId,
      item.previousDepartmentId,
      source,
    );
  }
}
