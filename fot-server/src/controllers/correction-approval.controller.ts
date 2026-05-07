import type { Response } from 'express';
import { supabase } from '../config/database.js';
import type { AuthenticatedRequest } from '../types/index.js';
import {
  resolveAccessibleDepartmentIds,
  resolveScopedDepartmentId,
} from '../services/data-scope.service.js';
import { auditService, AUDIT_ACTIONS } from '../services/audit.service.js';

interface IPendingItem {
  id: number;
  employee_id: number;
  employee_name: string | null;
  work_date: string;
  status: string;
  hours_override: number | null;
  notes: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  approval_status?: 'pending' | 'approved' | 'rejected' | 'auto_approved';
  approved_by?: string | null;
  approved_by_name?: string | null;
  approved_at?: string | null;
  approval_comment?: string | null;
}

interface IDepartmentGroup {
  department_id: string;
  department_name: string;
  pending_count: number;
  employees_count: number;
  items: IPendingItem[];
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** Возвращает pending корректировки, сгруппированные по отделам сотрудников. */
const getPendingByDepartment = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const startDate = isIsoDate(req.query.start_date) ? req.query.start_date : null;
    const endDate = isIsoDate(req.query.end_date) ? req.query.end_date : null;
    if (!startDate || !endDate || endDate < startDate) {
      res.status(400).json({ success: false, error: 'start_date и end_date обязательны (YYYY-MM-DD)' });
      return;
    }

    const accessible = await resolveAccessibleDepartmentIds(req);
    if (accessible !== 'all' && accessible.length === 0) {
      res.json({ success: true, data: [] });
      return;
    }

    const { data: pendingRows, error: pendingErr } = await supabase
      .from('attendance_adjustments')
      .select('id, employee_id, work_date, status, hours_override, reason, created_by, created_at')
      .eq('approval_status', 'pending')
      .gte('work_date', startDate)
      .lte('work_date', endDate)
      .order('work_date', { ascending: true });
    if (pendingErr) throw pendingErr;
    const adjustments = pendingRows || [];
    if (adjustments.length === 0) {
      res.json({ success: true, data: [] });
      return;
    }

    const employeeIds = [...new Set(adjustments.map(a => Number(a.employee_id)))];
    const { data: employeesRows, error: empErr } = await supabase
      .from('employees')
      .select('id, full_name, org_department_id')
      .in('id', employeeIds);
    if (empErr) throw empErr;
    const employees = employeesRows || [];

    const allowedDeptIds = accessible === 'all' ? null : new Set(accessible);
    const filteredEmployees = employees.filter(e => {
      if (!allowedDeptIds) return true;
      const deptId = e.org_department_id ? String(e.org_department_id) : null;
      return deptId !== null && allowedDeptIds.has(deptId);
    });
    if (filteredEmployees.length === 0) {
      res.json({ success: true, data: [] });
      return;
    }

    const employeeMap = new Map(filteredEmployees.map(e => [Number(e.id), {
      full_name: (e.full_name as string | null) ?? null,
      department_id: e.org_department_id ? String(e.org_department_id) : null,
    }]));

    const deptIds = [...new Set([...employeeMap.values()]
      .map(e => e.department_id)
      .filter((id): id is string => id !== null))];
    const deptNamesMap = new Map<string, string>();
    if (deptIds.length > 0) {
      const { data: deptRows, error: deptErr } = await supabase
        .from('org_departments')
        .select('id, name')
        .in('id', deptIds);
      if (deptErr) throw deptErr;
      for (const row of deptRows || []) {
        deptNamesMap.set(String(row.id), String(row.name ?? ''));
      }
    }

    const userIds = [...new Set(adjustments.map(a => a.created_by).filter((v): v is string => Boolean(v)))];
    const userNamesMap = new Map<string, string>();
    if (userIds.length > 0) {
      const { data: userRows, error: userErr } = await supabase
        .from('user_profiles')
        .select('id, full_name')
        .in('id', userIds);
      if (userErr) throw userErr;
      for (const row of userRows || []) {
        userNamesMap.set(String(row.id), String(row.full_name ?? ''));
      }
    }

    const groups = new Map<string, IDepartmentGroup>();
    for (const adj of adjustments) {
      const empInfo = employeeMap.get(Number(adj.employee_id));
      if (!empInfo || !empInfo.department_id) continue;
      const deptId = empInfo.department_id;
      let group = groups.get(deptId);
      if (!group) {
        group = {
          department_id: deptId,
          department_name: deptNamesMap.get(deptId) ?? deptId,
          pending_count: 0,
          employees_count: 0,
          items: [],
        };
        groups.set(deptId, group);
      }
      group.items.push({
        id: Number(adj.id),
        employee_id: Number(adj.employee_id),
        employee_name: empInfo.full_name,
        work_date: String(adj.work_date),
        status: String(adj.status),
        hours_override: typeof adj.hours_override === 'number' ? adj.hours_override : null,
        notes: (adj.reason as string | null) ?? null,
        created_by: adj.created_by ? String(adj.created_by) : null,
        created_by_name: adj.created_by ? userNamesMap.get(String(adj.created_by)) ?? null : null,
        created_at: String(adj.created_at),
      });
    }

    for (const group of groups.values()) {
      group.pending_count = group.items.length;
      group.employees_count = new Set(group.items.map(i => i.employee_id)).size;
    }

    const result = [...groups.values()].sort((a, b) => a.department_name.localeCompare(b.department_name, 'ru'));
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('correction-approval.getPendingByDepartment error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения списка корректировок' });
  }
};

async function loadAdjustmentForApproval(adjustmentId: number): Promise<{
  id: number;
  employee_id: number;
  work_date: string;
  approval_status: string;
} | null> {
  const { data, error } = await supabase
    .from('attendance_adjustments')
    .select('id, employee_id, work_date, approval_status')
    .eq('id', adjustmentId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    id: Number(data.id),
    employee_id: Number(data.employee_id),
    work_date: String(data.work_date),
    approval_status: String(data.approval_status),
  };
}

async function ensureAdjustmentDepartmentAccess(
  req: AuthenticatedRequest,
  employeeId: number,
): Promise<boolean> {
  const accessible = await resolveAccessibleDepartmentIds(req);
  if (accessible === 'all') return true;
  const { data, error } = await supabase
    .from('employees')
    .select('org_department_id')
    .eq('id', employeeId)
    .maybeSingle();
  if (error || !data) return false;
  const deptId = data.org_department_id ? String(data.org_department_id) : null;
  return deptId !== null && accessible.includes(deptId);
}

async function changeAdjustmentApproval(
  req: AuthenticatedRequest,
  res: Response,
  adjustmentId: number,
  nextStatus: 'approved' | 'rejected',
  comment: string | null,
): Promise<void> {
  const adj = await loadAdjustmentForApproval(adjustmentId);
  if (!adj) {
    res.status(404).json({ success: false, error: 'Корректировка не найдена' });
    return;
  }
  if (adj.approval_status !== 'pending') {
    res.status(409).json({ success: false, error: 'Корректировка уже не в статусе pending' });
    return;
  }
  if (!(await ensureAdjustmentDepartmentAccess(req, adj.employee_id))) {
    res.status(403).json({ success: false, error: 'Нет доступа к корректировке' });
    return;
  }

  const now = new Date().toISOString();
  const { data: updatedRows, error } = await supabase
    .from('attendance_adjustments')
    .update({
      approval_status: nextStatus,
      approved_by: req.user.id,
      approved_at: now,
      approval_comment: comment,
    })
    .eq('id', adjustmentId)
    .eq('approval_status', 'pending')
    .select('id');
  if (error) throw error;
  if (!updatedRows || updatedRows.length === 0) {
    res.status(409).json({
      success: false,
      error: 'Корректировка уже не в статусе pending',
      code: 'ALREADY_PROCESSED',
    });
    return;
  }

  await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.UPDATE_TIMESHEET_ENTRY, {
    entityType: 'attendance_adjustment',
    entityId: String(adjustmentId),
    details: {
      employee_id: adj.employee_id,
      work_date: adj.work_date,
      approval_status: nextStatus,
    },
  });

  res.json({ success: true, data: { id: adjustmentId, approval_status: nextStatus } });
}

const approveOne = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ success: false, error: 'Некорректный id' });
      return;
    }
    await changeAdjustmentApproval(req, res, id, 'approved', null);
  } catch (err) {
    console.error('correction-approval.approveOne error:', err);
    res.status(500).json({ success: false, error: 'Ошибка согласования' });
  }
};

const rejectOne = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ success: false, error: 'Некорректный id' });
      return;
    }
    const comment = typeof req.body?.comment === 'string' ? req.body.comment.trim() || null : null;
    await changeAdjustmentApproval(req, res, id, 'rejected', comment);
  } catch (err) {
    console.error('correction-approval.rejectOne error:', err);
    res.status(500).json({ success: false, error: 'Ошибка отклонения' });
  }
};

async function bulkChangeByIds(
  req: AuthenticatedRequest,
  res: Response,
  rawIds: unknown,
  nextStatus: 'approved' | 'rejected',
  comment: string | null,
): Promise<void> {
  if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.length > 500) {
    res.status(400).json({ success: false, error: 'ids: непустой массив (до 500 значений)' });
    return;
  }
  const ids: number[] = [];
  for (const v of rawIds) {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) {
      res.status(400).json({ success: false, error: 'Некорректный id в списке' });
      return;
    }
    ids.push(n);
  }
  const uniqueIds = [...new Set(ids)];

  const { data: rows, error: loadErr } = await supabase
    .from('attendance_adjustments')
    .select('id, employee_id, approval_status')
    .in('id', uniqueIds);
  if (loadErr) throw loadErr;
  const adjustments = rows || [];

  const pending = adjustments.filter(a => String(a.approval_status) === 'pending');
  const skippedNotPending = uniqueIds.length - pending.length;

  if (pending.length === 0) {
    res.json({
      success: true,
      data: { processed_count: 0, skipped_not_pending: skippedNotPending, skipped_no_access: 0 },
    });
    return;
  }

  const accessible = await resolveAccessibleDepartmentIds(req);
  let allowedIds: number[] = pending.map(a => Number(a.id));
  let skippedNoAccess = 0;

  if (accessible !== 'all') {
    const allowedDeptSet = new Set(accessible);
    const employeeIds = [...new Set(pending.map(a => Number(a.employee_id)))];
    const { data: empRows, error: empErr } = await supabase
      .from('employees')
      .select('id, org_department_id')
      .in('id', employeeIds);
    if (empErr) throw empErr;
    const allowedEmpSet = new Set<number>();
    for (const row of empRows || []) {
      const deptId = row.org_department_id ? String(row.org_department_id) : null;
      if (deptId && allowedDeptSet.has(deptId)) allowedEmpSet.add(Number(row.id));
    }
    const filteredIds: number[] = [];
    for (const a of pending) {
      if (allowedEmpSet.has(Number(a.employee_id))) filteredIds.push(Number(a.id));
    }
    skippedNoAccess = pending.length - filteredIds.length;
    allowedIds = filteredIds;
  }

  if (allowedIds.length === 0) {
    res.json({
      success: true,
      data: {
        processed_count: 0,
        skipped_not_pending: skippedNotPending,
        skipped_no_access: skippedNoAccess,
      },
    });
    return;
  }

  const now = new Date().toISOString();
  const { data: updated, error: updErr } = await supabase
    .from('attendance_adjustments')
    .update({
      approval_status: nextStatus,
      approved_by: req.user.id,
      approved_at: now,
      approval_comment: comment,
    })
    .in('id', allowedIds)
    .eq('approval_status', 'pending')
    .select('id');
  if (updErr) throw updErr;

  const processedCount = (updated || []).length;

  await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.UPDATE_TIMESHEET_ENTRY, {
    entityType: 'attendance_adjustment',
    entityId: 'bulk',
    details: {
      bulk_by_ids: true,
      ids: allowedIds,
      status: nextStatus,
      processed_count: processedCount,
    },
  });

  res.json({
    success: true,
    data: {
      processed_count: processedCount,
      skipped_not_pending: skippedNotPending,
      skipped_no_access: skippedNoAccess,
    },
  });
}

const bulkApproveByIds = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    await bulkChangeByIds(req, res, req.body?.ids, 'approved', null);
  } catch (err) {
    console.error('correction-approval.bulkApproveByIds error:', err);
    res.status(500).json({ success: false, error: 'Ошибка массового согласования' });
  }
};

const bulkRejectByIds = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const comment = typeof req.body?.comment === 'string' ? req.body.comment.trim() || null : null;
    await bulkChangeByIds(req, res, req.body?.ids, 'rejected', comment);
  } catch (err) {
    console.error('correction-approval.bulkRejectByIds error:', err);
    res.status(500).json({ success: false, error: 'Ошибка массового отклонения' });
  }
};

const bulkApprove = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const requestedDeptId = typeof req.body?.department_id === 'string' ? req.body.department_id : null;
    const startDate = isIsoDate(req.body?.start_date) ? req.body.start_date : null;
    const endDate = isIsoDate(req.body?.end_date) ? req.body.end_date : null;
    if (!requestedDeptId || !startDate || !endDate || endDate < startDate) {
      res.status(400).json({ success: false, error: 'department_id, start_date, end_date обязательны' });
      return;
    }
    const deptId = await resolveScopedDepartmentId(req, requestedDeptId);
    if (!deptId) {
      res.status(403).json({ success: false, error: 'Нет доступа к отделу' });
      return;
    }

    const { data: empRows, error: empErr } = await supabase
      .from('employees')
      .select('id')
      .eq('org_department_id', deptId);
    if (empErr) throw empErr;
    const employeeIds = (empRows || []).map(r => Number(r.id));
    if (employeeIds.length === 0) {
      res.json({ success: true, data: { approved_count: 0 } });
      return;
    }

    const now = new Date().toISOString();
    const { data: updated, error: updErr } = await supabase
      .from('attendance_adjustments')
      .update({
        approval_status: 'approved',
        approved_by: req.user.id,
        approved_at: now,
        approval_comment: null,
      })
      .eq('approval_status', 'pending')
      .in('employee_id', employeeIds)
      .gte('work_date', startDate)
      .lte('work_date', endDate)
      .select('id');
    if (updErr) throw updErr;

    const approvedCount = (updated || []).length;

    await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.UPDATE_TIMESHEET_ENTRY, {
      entityType: 'attendance_adjustment',
      entityId: String(deptId),
      details: {
        bulk: true,
        department_id: deptId,
        start_date: startDate,
        end_date: endDate,
        approved_count: approvedCount,
      },
    });

    res.json({ success: true, data: { approved_count: approvedCount } });
  } catch (err) {
    console.error('correction-approval.bulkApprove error:', err);
    res.status(500).json({ success: false, error: 'Ошибка массового согласования' });
  }
};

/** Возвращает историю (approved/rejected) корректировок, сгруппированную по отделам. */
const getHistoryByDepartment = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const startDate = isIsoDate(req.query.start_date) ? req.query.start_date : null;
    const endDate = isIsoDate(req.query.end_date) ? req.query.end_date : null;
    if (!startDate || !endDate || endDate < startDate) {
      res.status(400).json({ success: false, error: 'start_date и end_date обязательны (YYYY-MM-DD)' });
      return;
    }
    const statusesParam = typeof req.query.statuses === 'string' ? req.query.statuses : 'approved,rejected';
    const allowedStatuses = statusesParam
      .split(',')
      .map(s => s.trim())
      .filter(s => s === 'approved' || s === 'rejected');
    const statuses = allowedStatuses.length > 0 ? allowedStatuses : ['approved', 'rejected'];

    const accessible = await resolveAccessibleDepartmentIds(req);
    if (accessible !== 'all' && accessible.length === 0) {
      res.json({ success: true, data: [] });
      return;
    }

    const { data: rows, error: loadErr } = await supabase
      .from('attendance_adjustments')
      .select('id, employee_id, work_date, status, hours_override, reason, created_by, created_at, approval_status, approved_by, approved_at, approval_comment')
      .in('approval_status', statuses)
      .gte('work_date', startDate)
      .lte('work_date', endDate)
      .order('approved_at', { ascending: false });
    if (loadErr) throw loadErr;
    const adjustments = rows || [];
    if (adjustments.length === 0) {
      res.json({ success: true, data: [] });
      return;
    }

    const employeeIds = [...new Set(adjustments.map(a => Number(a.employee_id)))];
    const { data: employeesRows, error: empErr } = await supabase
      .from('employees')
      .select('id, full_name, org_department_id')
      .in('id', employeeIds);
    if (empErr) throw empErr;
    const employees = employeesRows || [];

    const allowedDeptIds = accessible === 'all' ? null : new Set(accessible);
    const filteredEmployees = employees.filter(e => {
      if (!allowedDeptIds) return true;
      const deptId = e.org_department_id ? String(e.org_department_id) : null;
      return deptId !== null && allowedDeptIds.has(deptId);
    });
    if (filteredEmployees.length === 0) {
      res.json({ success: true, data: [] });
      return;
    }

    const employeeMap = new Map(filteredEmployees.map(e => [Number(e.id), {
      full_name: (e.full_name as string | null) ?? null,
      department_id: e.org_department_id ? String(e.org_department_id) : null,
    }]));

    const deptIds = [...new Set([...employeeMap.values()]
      .map(e => e.department_id)
      .filter((id): id is string => id !== null))];
    const deptNamesMap = new Map<string, string>();
    if (deptIds.length > 0) {
      const { data: deptRows, error: deptErr } = await supabase
        .from('org_departments')
        .select('id, name')
        .in('id', deptIds);
      if (deptErr) throw deptErr;
      for (const row of deptRows || []) {
        deptNamesMap.set(String(row.id), String(row.name ?? ''));
      }
    }

    const userIds = [...new Set([
      ...adjustments.map(a => a.created_by).filter((v): v is string => Boolean(v)),
      ...adjustments.map(a => a.approved_by).filter((v): v is string => Boolean(v)),
    ])];
    const userNamesMap = new Map<string, string>();
    if (userIds.length > 0) {
      const { data: userRows, error: userErr } = await supabase
        .from('user_profiles')
        .select('id, full_name')
        .in('id', userIds);
      if (userErr) throw userErr;
      for (const row of userRows || []) {
        userNamesMap.set(String(row.id), String(row.full_name ?? ''));
      }
    }

    const groups = new Map<string, IDepartmentGroup>();
    for (const adj of adjustments) {
      const empInfo = employeeMap.get(Number(adj.employee_id));
      if (!empInfo || !empInfo.department_id) continue;
      const deptId = empInfo.department_id;
      let group = groups.get(deptId);
      if (!group) {
        group = {
          department_id: deptId,
          department_name: deptNamesMap.get(deptId) ?? deptId,
          pending_count: 0,
          employees_count: 0,
          items: [],
        };
        groups.set(deptId, group);
      }
      group.items.push({
        id: Number(adj.id),
        employee_id: Number(adj.employee_id),
        employee_name: empInfo.full_name,
        work_date: String(adj.work_date),
        status: String(adj.status),
        hours_override: typeof adj.hours_override === 'number' ? adj.hours_override : null,
        notes: (adj.reason as string | null) ?? null,
        created_by: adj.created_by ? String(adj.created_by) : null,
        created_by_name: adj.created_by ? userNamesMap.get(String(adj.created_by)) ?? null : null,
        created_at: String(adj.created_at),
        approval_status: String(adj.approval_status) as 'approved' | 'rejected',
        approved_by: adj.approved_by ? String(adj.approved_by) : null,
        approved_by_name: adj.approved_by ? userNamesMap.get(String(adj.approved_by)) ?? null : null,
        approved_at: adj.approved_at ? String(adj.approved_at) : null,
        approval_comment: (adj.approval_comment as string | null) ?? null,
      });
    }

    for (const group of groups.values()) {
      group.pending_count = group.items.length;
      group.employees_count = new Set(group.items.map(i => i.employee_id)).size;
    }

    const result = [...groups.values()].sort((a, b) => a.department_name.localeCompare(b.department_name, 'ru'));
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('correction-approval.getHistoryByDepartment error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения истории корректировок' });
  }
};

/** Возвращает уже утверждённую/отклонённую корректировку обратно в pending. */
const revertOne = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ success: false, error: 'Некорректный id' });
      return;
    }

    const adj = await loadAdjustmentForApproval(id);
    if (!adj) {
      res.status(404).json({ success: false, error: 'Корректировка не найдена' });
      return;
    }
    if (adj.approval_status !== 'approved' && adj.approval_status !== 'rejected') {
      res.status(409).json({
        success: false,
        error: 'Откат возможен только для утверждённых или отклонённых записей',
      });
      return;
    }
    if (!(await ensureAdjustmentDepartmentAccess(req, adj.employee_id))) {
      res.status(403).json({ success: false, error: 'Нет доступа к корректировке' });
      return;
    }

    const prevStatus = adj.approval_status;
    const { data: updatedRows, error } = await supabase
      .from('attendance_adjustments')
      .update({
        approval_status: 'pending',
        approved_by: null,
        approved_at: null,
        approval_comment: null,
      })
      .eq('id', id)
      .in('approval_status', ['approved', 'rejected'])
      .select('id');
    if (error) throw error;
    if (!updatedRows || updatedRows.length === 0) {
      res.status(409).json({
        success: false,
        error: 'Не удалось откатить — статус изменился',
        code: 'STATE_CHANGED',
      });
      return;
    }

    await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.UPDATE_TIMESHEET_ENTRY, {
      entityType: 'attendance_adjustment',
      entityId: String(id),
      details: {
        action: 'revert_to_pending',
        employee_id: adj.employee_id,
        work_date: adj.work_date,
        from_status: prevStatus,
        to_status: 'pending',
      },
    });

    res.json({ success: true, data: { id, approval_status: 'pending' } });
  } catch (err) {
    console.error('correction-approval.revertOne error:', err);
    res.status(500).json({ success: false, error: 'Ошибка отката утверждения' });
  }
};

export const correctionApprovalController = {
  getPendingByDepartment,
  getHistoryByDepartment,
  approveOne,
  rejectOne,
  revertOne,
  bulkApprove,
  bulkApproveByIds,
  bulkRejectByIds,
};
