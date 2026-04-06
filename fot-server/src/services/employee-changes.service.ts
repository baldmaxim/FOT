import { supabase } from '../config/database.js';

interface ChangeOpts {
  reason?: string;
  note?: string;
  effectiveDate?: string;
  createdBy?: string;
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Единый сервис для изменений сотрудника с автоматической записью истории.
 * Все контроллеры должны вызывать эти методы вместо прямого supabase.update().
 */
export const employeeChangesService = {
  /**
   * Изменение оклада → salary_history + employees.salary_actual/current_salary
   */
  async changeSalary(employeeId: number, salary: number, opts: ChangeOpts = {}): Promise<void> {
    const date = opts.effectiveDate || today();

    await supabase
      .from('salary_history')
      .insert({
        employee_id: employeeId,
        salary,
        effective_date: date,
        change_reason: opts.reason || null,
        note: opts.note || null,
        created_by: opts.createdBy || null,
      });

    // Обновляем salary_actual только из самой поздней записи
    const { data: latest } = await supabase
      .from('salary_history')
      .select('salary')
      .eq('employee_id', employeeId)
      .order('effective_date', { ascending: false })
      .limit(1)
      .single();

    if (latest) {
      await supabase
        .from('employees')
        .update({
          salary_actual: latest.salary,
          current_salary: latest.salary,
          updated_at: new Date().toISOString(),
        })
        .eq('id', employeeId);
    }
  },

  /**
   * Изменение должности → закрыть текущий assignment + новый assignment + employees.position_id
   */
  async changePosition(employeeId: number, positionId: string, opts: ChangeOpts = {}): Promise<void> {
    const date = opts.effectiveDate || today();

    const { data: emp } = await supabase
      .from('employees')
      .select('org_department_id, position_id')
      .eq('id', employeeId)
      .single();

    // Новое назначение (не закрываем старые — они имеют свои даты)
    await supabase
      .from('employee_assignments')
      .insert({
        employee_id: employeeId,
        org_department_id: emp?.org_department_id || null,
        position_id: positionId,
        effective_from: date,
        is_primary: true,
        assignment_type: 'main',
        change_reason: opts.reason || 'Смена должности',
        created_by: opts.createdBy || null,
      });

    // Обновляем position_id только если эта запись — самая поздняя
    const { data: latest } = await supabase
      .from('employee_assignments')
      .select('position_id')
      .eq('employee_id', employeeId)
      .order('effective_from', { ascending: false })
      .limit(1)
      .single();

    if (latest) {
      await supabase
        .from('employees')
        .update({
          position_id: latest.position_id,
          updated_at: new Date().toISOString(),
        })
        .eq('id', employeeId);
    }
  },

  /**
   * Изменение отдела → закрыть текущий assignment + новый assignment + employees.org_department_id
   */
  async changeDepartment(employeeId: number, departmentId: string, opts: ChangeOpts & { lockDepartment?: boolean } = {}): Promise<void> {
    const date = opts.effectiveDate || today();

    const { data: emp } = await supabase
      .from('employees')
      .select('position_id, org_department_id')
      .eq('id', employeeId)
      .single();

    // Новое назначение
    await supabase
      .from('employee_assignments')
      .insert({
        employee_id: employeeId,
        org_department_id: departmentId,
        position_id: emp?.position_id || null,
        effective_from: date,
        is_primary: true,
        assignment_type: 'main',
        change_reason: opts.reason || 'Перевод в другой отдел',
        created_by: opts.createdBy || null,
      });

    // Обновляем отдел только из самой поздней записи
    const { data: latest } = await supabase
      .from('employee_assignments')
      .select('org_department_id')
      .eq('employee_id', employeeId)
      .order('effective_from', { ascending: false })
      .limit(1)
      .single();

    const updateData: Record<string, unknown> = {
      org_department_id: latest?.org_department_id || departmentId,
      updated_at: new Date().toISOString(),
    };
    if (opts.lockDepartment !== undefined) {
      updateData.department_locked = opts.lockDepartment;
    }

    await supabase
      .from('employees')
      .update(updateData)
      .eq('id', employeeId);
  },
};
