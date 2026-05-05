import { supabase } from '../config/database.js';
import { employeeCache } from './employee-cache.service.js';
import { settingsService } from './settings.service.js';
import {
  formatDateShift,
  getEmployeeAssignments,
  isAssignmentActiveOnDateInclusive,
} from './timesheet-department-assignments.service.js';
import { tryDeleteTransfer, type IDeleteTransferResult } from './timesheet-transfers.service.js';

/**
 * Доменная ошибка валидации: бизнес-правило не выполнено, не серверный сбой.
 * Контроллер должен мапить такие ошибки в HTTP 400, а не 500.
 */
export class DomainValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainValidationError';
  }
}

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

/**
 * Режим заморозки истории переводов: вместо «закрыть старое + создать новое» обновляем
 * единственное открытое назначение сотрудника. Если открытого нет — создаём одно с
 * effective_from = hire_date (или 2020-01-01). Применяется во время чистки списков; после
 * финализации настройка выключается, и переводы снова пишут полноценную историю.
 */
const applyFrozenAssignment = async (
  employeeId: number,
  patch: { org_department_id?: string | null; position_id?: string | null },
  reason: string,
): Promise<void> => {
  const { data: emp } = await supabase
    .from('employees')
    .select('org_department_id, position_id, hire_date')
    .eq('id', employeeId)
    .single();

  const nextDeptId = patch.org_department_id !== undefined
    ? patch.org_department_id
    : emp?.org_department_id ?? null;
  const nextPositionId = patch.position_id !== undefined
    ? patch.position_id
    : emp?.position_id ?? null;

  const { data: openRows } = await supabase
    .from('employee_assignments')
    .select('id, effective_from')
    .eq('employee_id', employeeId)
    .is('effective_to', null)
    .order('effective_from', { ascending: true });

  const open = (openRows || [])[0] || null;
  const nowIso = new Date().toISOString();

  if (open) {
    const { error: updateError } = await supabase
      .from('employee_assignments')
      .update({
        org_department_id: nextDeptId,
        position_id: nextPositionId,
        is_primary: true,
        assignment_type: 'main',
        change_reason: reason,
        updated_at: nowIso,
      })
      .eq('id', open.id)
      .eq('employee_id', employeeId);
    if (updateError) throw updateError;

    if ((openRows || []).length > 1) {
      const extraIds = (openRows || []).slice(1).map(r => r.id);
      const { error: closeExtraError } = await supabase
        .from('employee_assignments')
        .update({ effective_to: open.effective_from, updated_at: nowIso })
        .in('id', extraIds)
        .eq('employee_id', employeeId);
      if (closeExtraError) throw closeExtraError;
    }
  } else {
    const effectiveFrom = (emp?.hire_date as string | null) || '2020-01-01';
    const { error: insertError } = await supabase
      .from('employee_assignments')
      .insert({
        employee_id: employeeId,
        org_department_id: nextDeptId,
        position_id: nextPositionId,
        effective_from: effectiveFrom,
        is_primary: true,
        assignment_type: 'main',
        change_reason: reason,
      });
    if (insertError) throw insertError;
  }
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
    const { freezeHistory } = await settingsService.getEmployeeTransferConfig();

    if (freezeHistory) {
      await applyFrozenAssignment(employeeId, { position_id: positionId }, opts.reason || 'Заморозка истории переводов');
      await supabase
        .from('employees')
        .update({ position_id: positionId, updated_at: new Date().toISOString() })
        .eq('id', employeeId);
      employeeCache.invalidate(employeeId);
      return;
    }

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
    const { freezeHistory } = await settingsService.getEmployeeTransferConfig();

    if (freezeHistory) {
      await applyFrozenAssignment(employeeId, { org_department_id: departmentId }, opts.reason || 'Заморозка истории переводов');

      const updateData: Record<string, unknown> = {
        org_department_id: departmentId,
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

      employeeCache.invalidate(employeeId);
      return;
    }

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
      throw new DomainValidationError('Salary history record not found');
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
      throw new DomainValidationError('Assignment record not found');
    }

    await syncEmployeeAssignmentSnapshot(employeeId);

    employeeCache.invalidate(employeeId);
  },

  /**
   * Удалить запись employee_assignments.
   *
   * Логика:
   * 1. Если удаляем закрытое назначение — просто удаляем.
   * 2. Если удаляем открытое и оно НЕ единственное открытое (теоретически, схема блокирует
   *    оверлап через триггер) — просто удаляем.
   * 3. Если удаляем единственное открытое у активного сотрудника:
   *    - Пробуем «откат перевода»: переоткрыть последнее закрытое назначение и удалить
   *      это (то же, что делает страница «Переводы и исключения»).
   *    - Если парного закрытого нет (свежий найм без истории) — кидаем DomainValidationError:
   *      сотрудник останется «без отдела», табель ломается, Sigur sync создаст gap.
   */
  async deleteAssignment(
    assignmentId: string,
    employeeId: number,
  ): Promise<{ reverted: IDeleteTransferResult | null }> {
    const { data: target, error: loadErr } = await supabase
      .from('employee_assignments')
      .select('id, effective_to')
      .eq('id', assignmentId)
      .eq('employee_id', employeeId)
      .maybeSingle();
    if (loadErr) throw loadErr;
    if (!target) throw new DomainValidationError('Assignment record not found');

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
          const reverted = await tryDeleteTransfer(assignmentId);
          if (!reverted) {
            throw new DomainValidationError(
              'Нельзя удалить единственное открытое назначение у активного сотрудника. '
              + 'Сначала создайте новое назначение или уволите/архивируйте сотрудника.',
            );
          }
          await syncEmployeeAssignmentSnapshot(employeeId);
          employeeCache.invalidate(employeeId);
          return { reverted };
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
      throw new DomainValidationError('Assignment record not found');
    }

    await syncEmployeeAssignmentSnapshot(employeeId);

    employeeCache.invalidate(employeeId);
    return { reverted: null };
  },
};
