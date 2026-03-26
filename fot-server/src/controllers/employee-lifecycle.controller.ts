import { Response } from 'express';
import { supabase } from '../config/database.js';
import { auditService } from '../services/audit.service.js';
import { getOrgId } from '../utils/org.utils.js';
import { loadStructureCache, decryptEmployee } from '../services/employee-mapper.service.js';
import type { AuthenticatedRequest, EmployeeEncrypted } from '../types/index.js';

/**
 * POST /api/employees/:id/archive
 */
export async function archive(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const organizationId = getOrgId(req);

    if (!organizationId) {
      res.status(400).json({ success: false, error: 'Organization required. Super admin: передайте ?organization_id=uuid' });
      return;
    }

    const { data, error } = await supabase
      .from('employees')
      .update({ is_archived: true, archived_at: new Date().toISOString() })
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select()
      .single();

    if (error || !data) {
      res.status(404).json({ success: false, error: 'Employee not found' });
      return;
    }

    await auditService.logFromRequest(req, req.user.id, 'ARCHIVE_EMPLOYEE', {
      entityType: 'employee',
      entityId: id,
    });

    const structureCache = await loadStructureCache(organizationId);
    const employee = decryptEmployee(data as EmployeeEncrypted, structureCache);
    res.json({ success: true, data: employee });
  } catch (error) {
    console.error('Archive employee error:', error);
    res.status(500).json({ success: false, error: 'Failed to archive employee' });
  }
}

/**
 * POST /api/employees/:id/restore
 */
export async function restore(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const organizationId = getOrgId(req);

    if (!organizationId) {
      res.status(400).json({ success: false, error: 'Organization required. Super admin: передайте ?organization_id=uuid' });
      return;
    }

    const { data, error } = await supabase
      .from('employees')
      .update({ is_archived: false, archived_at: null })
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select()
      .single();

    if (error || !data) {
      res.status(404).json({ success: false, error: 'Employee not found' });
      return;
    }

    const structureCache = await loadStructureCache(organizationId);
    const employee = decryptEmployee(data as EmployeeEncrypted, structureCache);

    await auditService.logFromRequest(req, req.user.id, 'RESTORE_EMPLOYEE', {
      entityType: 'employee',
      entityId: id,
    });

    res.json({ success: true, data: employee });
  } catch (error) {
    console.error('Restore employee error:', error);
    res.status(500).json({ success: false, error: 'Failed to restore employee' });
  }
}

/**
 * POST /api/employees/:id/fire — уволить сотрудника
 */
export async function fire(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('employees')
      .update({ employment_status: 'fired' })
      .eq('id', id)
      .select()
      .single();

    if (error || !data) {
      res.status(404).json({ success: false, error: 'Employee not found' });
      return;
    }

    // Закрываем все активные назначения при увольнении
    const today = new Date().toISOString().slice(0, 10);
    await supabase
      .from('employee_assignments')
      .update({ effective_to: today })
      .eq('employee_id', id)
      .is('effective_to', null);

    await auditService.logFromRequest(req, req.user.id, 'FIRE_EMPLOYEE', {
      entityType: 'employee',
      entityId: id,
    });

    const structureCache = await loadStructureCache(data.organization_id);
    const employee = decryptEmployee(data as EmployeeEncrypted, structureCache);
    res.json({ success: true, data: employee });
  } catch (error) {
    console.error('Fire employee error:', error);
    res.status(500).json({ success: false, error: 'Failed to fire employee' });
  }
}

/**
 * POST /api/employees/:id/rehire — восстановить на работу
 */
export async function rehire(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('employees')
      .update({ employment_status: 'active' })
      .eq('id', id)
      .select()
      .single();

    if (error || !data) {
      res.status(404).json({ success: false, error: 'Employee not found' });
      return;
    }

    // Создаём новое назначение при восстановлении
    const today = new Date().toISOString().slice(0, 10);
    await supabase
      .from('employee_assignments')
      .insert({
        employee_id: Number(id),
        org_department_id: data.org_department_id || null,
        org_company_id: data.org_company_id || null,
        position_id: data.position_id || null,
        effective_from: today,
        is_primary: true,
        assignment_type: 'main',
        change_reason: 'Восстановление на работу',
        created_by: req.user.id,
      });

    await auditService.logFromRequest(req, req.user.id, 'REHIRE_EMPLOYEE', {
      entityType: 'employee',
      entityId: id,
    });

    const structureCache = await loadStructureCache(data.organization_id);
    const employee = decryptEmployee(data as EmployeeEncrypted, structureCache);
    res.json({ success: true, data: employee });
  } catch (error) {
    console.error('Rehire employee error:', error);
    res.status(500).json({ success: false, error: 'Failed to rehire employee' });
  }
}

/**
 * POST /api/employees/:id/move-department — переместить в другой отдел
 */
export async function moveDepartment(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { org_department_id } = req.body as { org_department_id: string };

    if (!org_department_id) {
      res.status(400).json({ success: false, error: 'org_department_id required' });
      return;
    }

    // Получаем текущие данные сотрудника для переноса в назначение
    const { data: empBefore } = await supabase
      .from('employees')
      .select('position_id, org_company_id')
      .eq('id', id)
      .single();

    const today = new Date().toISOString().slice(0, 10);

    // Закрываем все активные назначения
    await supabase
      .from('employee_assignments')
      .update({ effective_to: today })
      .eq('employee_id', id)
      .is('effective_to', null);

    // Создаём новое назначение с новым отделом
    await supabase
      .from('employee_assignments')
      .insert({
        employee_id: Number(id),
        org_department_id,
        org_company_id: empBefore?.org_company_id || null,
        position_id: empBefore?.position_id || null,
        effective_from: today,
        is_primary: true,
        assignment_type: 'main',
        change_reason: 'Перевод в другой отдел',
        created_by: req.user.id,
      });

    const { data, error } = await supabase
      .from('employees')
      .update({ org_department_id, department_locked: true })
      .eq('id', id)
      .select()
      .single();

    if (error || !data) {
      res.status(404).json({ success: false, error: 'Employee not found' });
      return;
    }

    await auditService.logFromRequest(req, req.user.id, 'MOVE_EMPLOYEE_DEPARTMENT', {
      entityType: 'employee',
      entityId: id,
      details: { org_department_id },
    });

    const structureCache = await loadStructureCache(data.organization_id);
    const employee = decryptEmployee(data as EmployeeEncrypted, structureCache);
    res.json({ success: true, data: employee });
  } catch (error) {
    console.error('Move department error:', error);
    res.status(500).json({ success: false, error: 'Failed to move employee' });
  }
}

/**
 * GET /api/employees/:id/history
 */
export async function getHistory(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const organizationId = req.user.organization_id;

    // Проверяем что сотрудник принадлежит организации
    let empQ = supabase.from('employees').select('id').eq('id', id);
    if (organizationId) empQ = empQ.eq('organization_id', organizationId);

    const { data: emp } = await empQ.single();

    if (!emp) {
      res.status(404).json({ success: false, error: 'Employee not found' });
      return;
    }

    const { data, error } = await supabase
      .from('employee_history')
      .select('*')
      .eq('employee_id', id)
      .order('event_date', { ascending: false });

    if (error) {
      console.error('Get employee history error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch history' });
      return;
    }

    const structureCache = await loadStructureCache(organizationId || undefined);

    const events = (data || []).map((row: Record<string, unknown>) => {
      const eventData = row.event_data as Record<string, unknown> || {};
      let decryptedData: Record<string, unknown> = {};

      if (row.event_type === 'salary') {
        decryptedData = {
          salary: eventData.salary ? parseFloat(String(eventData.salary)) : null,
          reason: eventData.reason,
          order_number: eventData.order_number,
          note: eventData.note || null,
        };
      } else if (row.event_type === 'assignment') {
        decryptedData = {
          department: eventData.department_id ? structureCache.departments.get(eventData.department_id as string) || null : null,
          department_id: eventData.department_id,
          position: eventData.position_id ? structureCache.positions.get(eventData.position_id as string) || null : null,
          position_id: eventData.position_id,
          site_id: eventData.site_id,
          is_primary: eventData.is_primary,
          type: eventData.type,
          reason: eventData.reason,
          order_number: eventData.order_number,
        };
      }

      return {
        employee_id: row.employee_id,
        event_type: row.event_type,
        event_id: row.event_id,
        event_date: row.event_date,
        event_end_date: row.event_end_date,
        event_data: decryptedData,
        created_at: row.created_at,
        created_by: row.created_by,
      };
    });

    res.json({ success: true, data: events });
  } catch (error) {
    console.error('Get employee history error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch history' });
  }
}
