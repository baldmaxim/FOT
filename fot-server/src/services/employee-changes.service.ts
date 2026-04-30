import { supabase } from '../config/database.js';
import { employeeCache } from './employee-cache.service.js';
import {
  formatDateShift,
  getEmployeeAssignments,
  isAssignmentActiveOnDateInclusive,
} from './timesheet-department-assignments.service.js';

interface ChangeOpts {
  reason?: string;
  note?: string;
  effectiveDate?: string;
  createdBy?: string;
}

const today = () => new Date().toISOString().slice(0, 10);

const syncEmployeeSalarySnapshot = async (employeeId: number, salary: number | null): Promise<void> => {
  await supabase
    .from('employees')
    .update({
      current_salary: salary,
      // Legacy mirror for old screens/imports until salary_actual is retired fully.
      salary_actual: salary,
      updated_at: new Date().toISOString(),
    })
    .eq('id', employeeId);
};

const syncEmployeeAssignmentSnapshot = async (employeeId: number, referenceDate = today()): Promise<void> => {
  const assignments = await getEmployeeAssignments(employeeId);
  const activeAssignment = [...assignments]
    .reverse()
    .find(assignment => isAssignmentActiveOnDateInclusive(
      assignment.effective_from,
      assignment.effective_to,
      referenceDate,
    )) || null;

  await supabase
    .from('employees')
    .update({
      position_id: activeAssignment?.position_id || null,
      org_department_id: activeAssignment?.org_department_id || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', employeeId);
};

/**
 * Единый сервис для изменений сотрудника с автоматической записью истории.
 * Все контроллеры должны вызывать эти методы вместо прямого supabase.update().
 */
export const employeeChangesService = {
  /**
   * Изменение оклада → salary_history + employees.current_salary snapshot
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

    // Обновляем salary snapshot только из самой поздней записи
    const { data: latest } = await supabase
      .from('salary_history')
      .select('salary')
      .eq('employee_id', employeeId)
      .order('effective_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (latest) {
      await syncEmployeeSalarySnapshot(employeeId, latest.salary);
    }

    employeeCache.invalidate(employeeId);
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

    await syncEmployeeAssignmentSnapshot(employeeId);

    employeeCache.invalidate(employeeId);
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

    const assignments = await getEmployeeAssignments(employeeId);
    const previousDay = formatDateShift(date, -1);
    const nextAssignment = assignments.find(assignment => assignment.effective_from > date) || null;
    const sameDayAssignment = assignments.find(assignment => assignment.effective_from === date) || null;
    const activeAssignment = assignments.find(assignment => isAssignmentActiveOnDateInclusive(
      assignment.effective_from,
      assignment.effective_to,
      date,
    )) || null;

    if (activeAssignment && activeAssignment.id !== sameDayAssignment?.id) {
      const { error: closeError } = await supabase
        .from('employee_assignments')
        .update({
          effective_to: previousDay,
          updated_at: new Date().toISOString(),
        })
        .eq('id', activeAssignment.id)
        .eq('employee_id', employeeId);

      if (closeError) throw closeError;
    }

    const nextEffectiveTo = nextAssignment ? formatDateShift(nextAssignment.effective_from, -1) : null;

    if (sameDayAssignment) {
      const { error: updateError } = await supabase
        .from('employee_assignments')
        .update({
          org_department_id: departmentId,
          position_id: emp?.position_id || null,
          effective_to: nextEffectiveTo,
          is_primary: true,
          assignment_type: 'main',
          change_reason: opts.reason || 'Перевод в другой отдел',
          created_by: opts.createdBy || null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', sameDayAssignment.id)
        .eq('employee_id', employeeId);

      if (updateError) throw updateError;
    } else {
      const { error: insertError } = await supabase
        .from('employee_assignments')
        .insert({
          employee_id: employeeId,
          org_department_id: departmentId,
          position_id: emp?.position_id || null,
          effective_from: date,
          effective_to: nextEffectiveTo,
          is_primary: true,
          assignment_type: 'main',
          change_reason: opts.reason || 'Перевод в другой отдел',
          created_by: opts.createdBy || null,
        });

      if (insertError) throw insertError;
    }

    const updateData: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (opts.lockDepartment !== undefined) {
      updateData.department_locked = opts.lockDepartment;
    }

    const { error: employeeError } = await supabase
      .from('employees')
      .update(updateData)
      .eq('id', employeeId);
    if (employeeError) throw employeeError;

    await syncEmployeeAssignmentSnapshot(employeeId);

    employeeCache.invalidate(employeeId);
  },

  /**
   * Обновить запись salary_history
   */
  async updateSalaryHistory(
    historyId: number,
    employeeId: number,
    updates: { salary?: number; effective_date?: string; change_reason?: string; note?: string },
  ): Promise<void> {
    const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (updates.salary !== undefined) updateData.salary = updates.salary;
    if (updates.effective_date !== undefined) updateData.effective_date = updates.effective_date;
    if (updates.change_reason !== undefined) updateData.change_reason = updates.change_reason;
    if (updates.note !== undefined) updateData.note = updates.note;

    const { data: updated, error } = await supabase
      .from('salary_history')
      .update(updateData)
      .eq('id', historyId)
      .eq('employee_id', employeeId)
      .select('id');
    if (error) throw error;
    if (!updated || updated.length === 0) {
      throw new Error('Salary history record not found');
    }

    // Пересчитать актуальный оклад
    const { data: latest } = await supabase
      .from('salary_history')
      .select('salary')
      .eq('employee_id', employeeId)
      .order('effective_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (latest) {
      await syncEmployeeSalarySnapshot(employeeId, latest.salary);
    }

    employeeCache.invalidate(employeeId);
  },

  /**
   * Удалить запись salary_history
   */
  async deleteSalaryHistory(historyId: number, employeeId: number): Promise<void> {
    const { data: deleted, error } = await supabase
      .from('salary_history')
      .delete()
      .eq('id', historyId)
      .eq('employee_id', employeeId)
      .select('id');
    if (error) throw error;
    if (!deleted || deleted.length === 0) {
      throw new Error('Salary history record not found');
    }

    const { data: latest } = await supabase
      .from('salary_history')
      .select('salary')
      .eq('employee_id', employeeId)
      .order('effective_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    await syncEmployeeSalarySnapshot(employeeId, latest?.salary || null);
    employeeCache.invalidate(employeeId);
  },

  /**
   * Обновить запись employee_assignments
   */
  async updateAssignment(
    assignmentId: string,
    employeeId: number,
    updates: { position_id?: string; org_department_id?: string; effective_from?: string; change_reason?: string },
  ): Promise<void> {
    const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (updates.position_id !== undefined) updateData.position_id = updates.position_id;
    if (updates.org_department_id !== undefined) updateData.org_department_id = updates.org_department_id;
    if (updates.effective_from !== undefined) updateData.effective_from = updates.effective_from;
    if (updates.change_reason !== undefined) updateData.change_reason = updates.change_reason;

    const { data: updated, error } = await supabase
      .from('employee_assignments')
      .update(updateData)
      .eq('id', assignmentId)
      .eq('employee_id', employeeId)
      .select('id');
    if (error) throw error;
    if (!updated || updated.length === 0) {
      throw new Error('Assignment record not found');
    }

    await syncEmployeeAssignmentSnapshot(employeeId);

    employeeCache.invalidate(employeeId);
  },

  /**
   * Удалить запись employee_assignments.
   * Нельзя удалять последнее открытое назначение у активного сотрудника — иначе он
   * остаётся «без отдела», табель ломается, а Sigur sync через час создаёт запись
   * задним числом today() и образуется gap в днях.
   */
  async deleteAssignment(assignmentId: string, employeeId: number): Promise<void> {
    const { data: target, error: loadErr } = await supabase
      .from('employee_assignments')
      .select('id, effective_to')
      .eq('id', assignmentId)
      .eq('employee_id', employeeId)
      .maybeSingle();
    if (loadErr) throw loadErr;
    if (!target) throw new Error('Assignment record not found');

    if (target.effective_to == null) {
      const { data: emp } = await supabase
        .from('employees')
        .select('employment_status, is_archived')
        .eq('id', employeeId)
        .maybeSingle();
      const isActive = emp && emp.employment_status === 'active' && !emp.is_archived;
      if (isActive) {
        const { count, error: cntErr } = await supabase
          .from('employee_assignments')
          .select('id', { count: 'exact', head: true })
          .eq('employee_id', employeeId)
          .is('effective_to', null);
        if (cntErr) throw cntErr;
        if ((count ?? 0) <= 1) {
          throw new Error(
            'Нельзя удалить единственное открытое назначение у активного сотрудника. '
            + 'Сначала создайте новое назначение или уволите/архивируйте сотрудника.',
          );
        }
      }
    }

    const { data: deleted, error } = await supabase
      .from('employee_assignments')
      .delete()
      .eq('id', assignmentId)
      .eq('employee_id', employeeId)
      .select('id');
    if (error) throw error;
    if (!deleted || deleted.length === 0) {
      throw new Error('Assignment record not found');
    }

    await syncEmployeeAssignmentSnapshot(employeeId);

    employeeCache.invalidate(employeeId);
  },
};
