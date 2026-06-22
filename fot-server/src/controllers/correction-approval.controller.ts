import type { Response } from 'express';
import { query, queryOne } from '../config/postgres.js';
import type { AuthenticatedRequest } from '../types/index.js';
import {
  resolveAccessibleDepartmentIds,
  resolveEditableDepartmentIds,
  resolveScopedDepartmentId,
} from '../services/data-scope.service.js';
import { listDirectSubordinates } from '../services/employee-direct-reports.service.js';
import { resolveResponsibleEmployeeIdsForRows } from '../services/approval-routing.service.js';
import { auditService, AUDIT_ACTIONS } from '../services/audit.service.js';
import { correctionApprovalSettingsService } from '../services/correction-approval-settings.service.js';
import { reapproveAdjustmentsForRange } from './timesheet.controller.js';
import { emitDomainChange } from '../services/realtime-broadcast.service.js';
import { getLeaveRequestRecipients, getUserIdsByEmployeeIds } from '../services/recipients.service.js';

async function emitCorrectionChanged(params: {
  employeeIds: number[];
  reviewerUserId: string;
  action: 'approve' | 'reject' | 'revert' | 'bulk_approve' | 'bulk_reject' | 'bulk_revert';
  entityId?: number;
}): Promise<void> {
  try {
    const userIds = await getUserIdsByEmployeeIds(params.employeeIds);
    const targetUserIds = [...new Set([...userIds, params.reviewerUserId])];
    if (targetUserIds.length === 0) return;
    emitDomainChange({
      event: 'correction:changed',
      targetUserIds,
      payload: { action: params.action, ...(params.entityId != null ? { entityId: params.entityId } : {}) },
    });
  } catch (e) {
    console.error('[correction-approval] emit realtime error:', e);
  }
}

const DIRECT_REPORTS_GROUP_ID = '__direct_reports__';
const DIRECT_REPORTS_GROUP_NAME = 'Непосредственные подчинённые';

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
  is_direct_reports?: boolean;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

async function syncWorkLeaveRequestsForAdjustmentIds(
  adjustmentIds: number[],
  reviewerUserId: string,
  reviewComment: string | null = null,
): Promise<void> {
  const ids = [...new Set(adjustmentIds.filter(id => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return;

  const changed = await query<{ id: number; employee_id: number; status: string }>(
    `WITH target_requests AS (
       SELECT DISTINCT lr.id
         FROM attendance_adjustments aa
         JOIN leave_requests lr
           ON lr.id::text = aa.source_id
          AND lr.request_type = 'work'
        WHERE aa.id = ANY($1::bigint[])
          AND aa.source_type = 'leave_request'
          AND aa.source_id ~ '^[0-9]+$'
     ),
     request_state AS (
       SELECT tr.id,
              BOOL_OR(aa.approval_status = 'rejected') AS has_rejected,
              BOOL_OR(aa.approval_status = 'pending') AS has_pending,
              BOOL_OR(aa.approval_status IN ('approved', 'auto_approved')) AS has_accepted
         FROM target_requests tr
         JOIN attendance_adjustments aa
           ON aa.source_type = 'leave_request'
          AND aa.source_id = tr.id::text
        GROUP BY tr.id
     ),
     next_state AS (
       SELECT id,
              CASE
                WHEN has_rejected THEN 'rejected'
                WHEN has_pending THEN 'pending'
                WHEN has_accepted THEN 'approved'
                ELSE 'pending'
              END AS status
         FROM request_state
     )
     UPDATE leave_requests lr
        SET status = ns.status,
            reviewer_id = CASE WHEN ns.status IN ('approved', 'rejected') THEN $2::uuid ELSE NULL END,
            reviewed_at = CASE WHEN ns.status IN ('approved', 'rejected') THEN now() ELSE NULL END,
            -- На approved комментарий не трогаем: заявка могла быть одобрена
            -- на 1-м этапе в «Заявлениях» — его комментарий сохраняем.
            review_comment = CASE
              WHEN ns.status = 'rejected' THEN $3::text
              WHEN ns.status = 'pending' THEN NULL
              ELSE lr.review_comment
            END,
            updated_at = now()
       FROM next_state ns
      WHERE lr.id = ns.id
        AND (
          lr.status IS DISTINCT FROM ns.status
          OR (ns.status = 'rejected' AND lr.review_comment IS DISTINCT FROM $3::text)
        )
      RETURNING lr.id, lr.employee_id, lr.status`,
    [ids, reviewerUserId, reviewComment],
  );

  for (const row of changed) {
    getLeaveRequestRecipients(Number(row.employee_id), reviewerUserId)
      .then((recipients) => {
        emitDomainChange({
          event: 'leave_request:changed',
          targetUserIds: recipients,
          payload: {
            entityId: Number(row.id),
            employeeId: Number(row.employee_id),
            action: row.status === 'approved' ? 'approve' : row.status === 'rejected' ? 'reject' : 'revert',
          },
        });
      })
      .catch((e) => console.error('[correction-approval] emit leave_request sync error:', e));
  }
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
    const directReportIds = req.user.employee_id
      ? await listDirectSubordinates(req.user.employee_id)
      : [];
    const directReportsSet = new Set(directReportIds);
    const viewerEmployeeId = req.user.employee_id ?? null;

    if (accessible !== 'all' && accessible.length === 0 && directReportIds.length === 0 && viewerEmployeeId == null) {
      res.json({ success: true, data: [] });
      return;
    }

    const adjustments = await query<{
      id: number;
      employee_id: number;
      work_date: string;
      status: string;
      hours_override: number | null;
      reason: string | null;
      created_by: string | null;
      created_at: string;
    }>(
      `SELECT id, employee_id, work_date::text AS work_date, status, hours_override, reason, created_by, created_at
         FROM attendance_adjustments
        WHERE approval_status = 'pending'
          AND work_date >= $1::date
          AND work_date <= $2::date
        ORDER BY work_date ASC`,
      [startDate, endDate],
    );

    if (adjustments.length === 0) {
      res.json({ success: true, data: [] });
      return;
    }

    const employeeIds = [...new Set(adjustments.map(a => Number(a.employee_id)))];
    const employees = await query<{ id: number; full_name: string | null; org_department_id: string | null }>(
      `SELECT e.id, e.full_name, e.org_department_id
         FROM employees e
        WHERE e.id = ANY($1::bigint[])`,
      [employeeIds],
    );

    const isAllScope = accessible === 'all';
    const allowedDeptIds = isAllScope ? null : new Set(accessible);
    const requiredDepartments = await correctionApprovalSettingsService.getRequiredDepartmentIds();

    // Сотрудники в whitelist-отделах — только им требуется согласование.
    const empInfoMap = new Map<number, { full_name: string | null; department_id: string | null }>();
    for (const e of employees) {
      const deptId = e.org_department_id ? String(e.org_department_id) : null;
      if (!deptId || !requiredDepartments.has(deptId)) continue;
      empInfoMap.set(Number(e.id), { full_name: e.full_name ?? null, department_id: deptId });
    }
    if (empInfoMap.size === 0) {
      res.json({ success: true, data: [] });
      return;
    }

    // Адресная маршрутизация: ответственный(е) за каждую pending-строку.
    const routableRows = adjustments
      .filter(a => empInfoMap.has(Number(a.employee_id)))
      .map(a => ({
        id: Number(a.id),
        employee_id: Number(a.employee_id),
        work_date: String(a.work_date),
        org_department_id: empInfoMap.get(Number(a.employee_id))!.department_id,
      }));
    const responsiblesMap = await resolveResponsibleEmployeeIdsForRows(routableRows);

    // Видимость строки: если есть назначенный ответственный, строку видит только он.
    // Admin/all видит только нерутированные строки, чтобы адресная маршрутизация
    // выходных не раскрывала очередь всем администраторам.
    const decide = (adjId: number, empId: number, deptId: string | null): { visible: boolean; directOnly: boolean } => {
      const responsibles = responsiblesMap.get(adjId) ?? [];
      if (responsibles.length > 0) {
        const visible = viewerEmployeeId != null && responsibles.includes(viewerEmployeeId);
        return { visible, directOnly: false };
      }
      if (isAllScope) return { visible: true, directOnly: false };
      const inDeptSubtree = deptId !== null && !!allowedDeptIds && allowedDeptIds.has(deptId);
      const isDirectReport = directReportsSet.has(empId);
      return { visible: inDeptSubtree || isDirectReport, directOnly: !inDeptSubtree && isDirectReport };
    };

    const visibleDeptIds = new Set<string>();
    const visibleUserIds = new Set<string>();
    const decisions = new Map<number, { directOnly: boolean }>();
    for (const adj of adjustments) {
      const empInfo = empInfoMap.get(Number(adj.employee_id));
      if (!empInfo) continue;
      const d = decide(Number(adj.id), Number(adj.employee_id), empInfo.department_id);
      if (!d.visible) continue;
      decisions.set(Number(adj.id), { directOnly: d.directOnly });
      if (!d.directOnly && empInfo.department_id) visibleDeptIds.add(empInfo.department_id);
      if (adj.created_by) visibleUserIds.add(String(adj.created_by));
    }

    const deptNamesMap = new Map<string, string>();
    if (visibleDeptIds.size > 0) {
      const deptRows = await query<{ id: string; name: string | null }>(
        `SELECT id, name FROM org_departments WHERE id = ANY($1::uuid[])`,
        [[...visibleDeptIds]],
      );
      for (const row of deptRows) deptNamesMap.set(String(row.id), String(row.name ?? ''));
    }

    const userNamesMap = new Map<string, string>();
    if (visibleUserIds.size > 0) {
      const userRows = await query<{ id: string; full_name: string | null }>(
        `SELECT id, full_name FROM user_profiles WHERE id = ANY($1::uuid[])`,
        [[...visibleUserIds]],
      );
      for (const row of userRows) userNamesMap.set(String(row.id), String(row.full_name ?? ''));
    }

    const groups = new Map<string, IDepartmentGroup>();
    for (const adj of adjustments) {
      const decision = decisions.get(Number(adj.id));
      if (!decision) continue;
      const empInfo = empInfoMap.get(Number(adj.employee_id))!;
      const isDirectOnly = decision.directOnly;
      const deptId = isDirectOnly ? DIRECT_REPORTS_GROUP_ID : empInfo.department_id;
      if (!deptId) continue;
      let group = groups.get(deptId);
      if (!group) {
        group = {
          department_id: deptId,
          department_name: isDirectOnly
            ? DIRECT_REPORTS_GROUP_NAME
            : (deptNamesMap.get(deptId) ?? deptId),
          pending_count: 0,
          employees_count: 0,
          items: [],
          is_direct_reports: isDirectOnly,
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
        notes: adj.reason ?? null,
        created_by: adj.created_by ? String(adj.created_by) : null,
        created_by_name: adj.created_by ? userNamesMap.get(String(adj.created_by)) ?? null : null,
        created_at: String(adj.created_at),
      });
    }

    for (const group of groups.values()) {
      group.pending_count = group.items.length;
      group.employees_count = new Set(group.items.map(i => i.employee_id)).size;
    }

    const result = [...groups.values()].sort((a, b) => {
      // Группа «Непосредственные подчинённые» — всегда в конце списка.
      if (a.is_direct_reports && !b.is_direct_reports) return 1;
      if (!a.is_direct_reports && b.is_direct_reports) return -1;
      return a.department_name.localeCompare(b.department_name, 'ru');
    });
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
  const data = await queryOne<{
    id: number;
    employee_id: number;
    work_date: string;
    approval_status: string;
  }>(
    `SELECT id, employee_id, work_date::text AS work_date, approval_status
       FROM attendance_adjustments
      WHERE id = $1`,
    [adjustmentId],
  );
  if (!data) return null;
  return {
    id: Number(data.id),
    employee_id: Number(data.employee_id),
    work_date: String(data.work_date),
    approval_status: String(data.approval_status),
  };
}

/**
 * Из набора pending/обрабатываемых строк возвращает id, которые текущий
 * пользователь вправе согласовать/отклонить/откатить — с учётом адресной
 * маршрутизации (decision 10):
 *  - назначенный ответственный — свои строки (даже вне editable-скоупа);
 *  - полный доступ (editable='all', т.е. админ) — только нерутированные строки;
 *  - нерутированные строки — по editable-скоупу/прямому подчинению («как раньше»).
 */
async function filterApprovableIds(
  req: AuthenticatedRequest,
  rows: Array<{ id: number; employee_id: number; work_date: string }>,
): Promise<Set<number>> {
  if (rows.length === 0) return new Set();
  const accessible = await resolveEditableDepartmentIds(req);

  const empIds = [...new Set(rows.map(r => Number(r.employee_id)))];
  const empRows = await query<{ id: number; org_department_id: string | null }>(
    `SELECT id, org_department_id FROM employees WHERE id = ANY($1::bigint[])`,
    [empIds],
  );
  const deptByEmp = new Map<number, string | null>(
    empRows.map(e => [Number(e.id), e.org_department_id ? String(e.org_department_id) : null]),
  );
  const isAllScope = accessible === 'all';
  const allowedDeptSet = isAllScope ? null : new Set(accessible);
  const directReports = req.user.employee_id
    ? new Set(await listDirectSubordinates(req.user.employee_id))
    : new Set<number>();
  const viewerEmployeeId = req.user.employee_id ?? null;

  const routable = rows.map(r => ({
    id: Number(r.id),
    employee_id: Number(r.employee_id),
    work_date: String(r.work_date),
    org_department_id: deptByEmp.get(Number(r.employee_id)) ?? null,
  }));
  const responsiblesMap = await resolveResponsibleEmployeeIdsForRows(routable);

  const allowed = new Set<number>();
  for (const r of rows) {
    const responsibles = responsiblesMap.get(Number(r.id)) ?? [];
    if (responsibles.length > 0) {
      // Маршрутизированная строка — только её ответственному.
      if (viewerEmployeeId != null && responsibles.includes(viewerEmployeeId)) allowed.add(Number(r.id));
      continue;
    }
    if (isAllScope) {
      allowed.add(Number(r.id));
      continue;
    }
    const dept = deptByEmp.get(Number(r.employee_id)) ?? null;
    const inDept = dept !== null && !!allowedDeptSet && allowedDeptSet.has(dept);
    if (inDept || directReports.has(Number(r.employee_id))) allowed.add(Number(r.id));
  }
  return allowed;
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
  const approvable = await filterApprovableIds(req, [
    { id: adj.id, employee_id: adj.employee_id, work_date: adj.work_date },
  ]);
  if (!approvable.has(adj.id)) {
    res.status(403).json({ success: false, error: 'Нет доступа к корректировке' });
    return;
  }

  const now = new Date().toISOString();
  const updatedRows = await query<{ id: number }>(
    `UPDATE attendance_adjustments SET
       approval_status = $1,
       approved_by = $2,
       approved_at = $3,
       approval_comment = $4
     WHERE id = $5 AND approval_status = 'pending'
     RETURNING id`,
    [nextStatus, req.user.id, now, comment, adjustmentId],
  );

  if (updatedRows.length === 0) {
    res.status(409).json({
      success: false,
      error: 'Корректировка уже не в статусе pending',
      code: 'ALREADY_PROCESSED',
    });
    return;
  }

  await syncWorkLeaveRequestsForAdjustmentIds([adjustmentId], req.user.id, nextStatus === 'rejected' ? comment : null);

  await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.UPDATE_TIMESHEET_ENTRY, {
    entityType: 'attendance_adjustment',
    entityId: String(adjustmentId),
    details: {
      employee_id: adj.employee_id,
      work_date: adj.work_date,
      approval_status: nextStatus,
    },
  });

  void emitCorrectionChanged({
    employeeIds: [adj.employee_id],
    reviewerUserId: req.user.id,
    action: nextStatus === 'approved' ? 'approve' : 'reject',
    entityId: adjustmentId,
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

  const adjustments = await query<{ id: number; employee_id: number; work_date: string; approval_status: string }>(
    `SELECT id, employee_id, work_date::text AS work_date, approval_status
       FROM attendance_adjustments
      WHERE id = ANY($1::bigint[])`,
    [uniqueIds],
  );

  const pending = adjustments.filter(a => String(a.approval_status) === 'pending');
  const skippedNotPending = uniqueIds.length - pending.length;

  if (pending.length === 0) {
    res.json({
      success: true,
      data: { processed_count: 0, skipped_not_pending: skippedNotPending, skipped_no_access: 0 },
    });
    return;
  }

  const allowedSet = await filterApprovableIds(
    req,
    pending.map(a => ({ id: Number(a.id), employee_id: Number(a.employee_id), work_date: String(a.work_date) })),
  );
  const allowedIds: number[] = pending.filter(a => allowedSet.has(Number(a.id))).map(a => Number(a.id));
  const skippedNoAccess = pending.length - allowedIds.length;

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
  const updated = await query<{ id: number }>(
    `UPDATE attendance_adjustments SET
       approval_status = $1,
       approved_by = $2,
       approved_at = $3,
       approval_comment = $4
     WHERE id = ANY($5::bigint[]) AND approval_status = 'pending'
     RETURNING id`,
    [nextStatus, req.user.id, now, comment, allowedIds],
  );

  const processedCount = updated.length;
  const processedIds = updated.map((r) => Number(r.id));

  if (processedIds.length > 0) {
    await syncWorkLeaveRequestsForAdjustmentIds(processedIds, req.user.id, nextStatus === 'rejected' ? comment : null);
  }

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

  if (processedCount > 0) {
    const processedSet = new Set(processedIds);
    const affectedEmployeeIds = [...new Set(
      pending.filter((a) => processedSet.has(Number(a.id))).map((a) => Number(a.employee_id)),
    )];
    void emitCorrectionChanged({
      employeeIds: affectedEmployeeIds,
      reviewerUserId: req.user.id,
      action: nextStatus === 'approved' ? 'bulk_approve' : 'bulk_reject',
    });
  }

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

async function bulkRevertByIdsImpl(
  req: AuthenticatedRequest,
  res: Response,
  rawIds: unknown,
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

  const adjustments = await query<{ id: number; employee_id: number; work_date: string; approval_status: string }>(
    `SELECT id, employee_id, work_date::text AS work_date, approval_status
       FROM attendance_adjustments
      WHERE id = ANY($1::bigint[])`,
    [uniqueIds],
  );

  const revertable = adjustments.filter(
    a => String(a.approval_status) === 'approved' || String(a.approval_status) === 'rejected',
  );
  const skippedNotPending = uniqueIds.length - revertable.length;

  if (revertable.length === 0) {
    res.json({
      success: true,
      data: { processed_count: 0, skipped_not_pending: skippedNotPending, skipped_no_access: 0 },
    });
    return;
  }

  const allowedSet = await filterApprovableIds(
    req,
    revertable.map(a => ({ id: Number(a.id), employee_id: Number(a.employee_id), work_date: String(a.work_date) })),
  );
  const allowedIds: number[] = revertable.filter(a => allowedSet.has(Number(a.id))).map(a => Number(a.id));
  const skippedNoAccess = revertable.length - allowedIds.length;

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

  const updated = await query<{ id: number }>(
    `UPDATE attendance_adjustments SET
       approval_status = 'pending',
       approved_by = NULL,
       approved_at = NULL,
       approval_comment = NULL
     WHERE id = ANY($1::bigint[]) AND approval_status = ANY($2::text[])
     RETURNING id`,
    [allowedIds, ['approved', 'rejected']],
  );

  const processedCount = updated.length;
  const processedIds = updated.map((r) => Number(r.id));

  if (processedIds.length > 0) {
    await syncWorkLeaveRequestsForAdjustmentIds(processedIds, req.user.id, null);
  }

  await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.UPDATE_TIMESHEET_ENTRY, {
    entityType: 'attendance_adjustment',
    entityId: 'bulk',
    details: {
      bulk_by_ids: true,
      action: 'revert_to_pending',
      ids: allowedIds,
      to_status: 'pending',
      processed_count: processedCount,
    },
  });

  if (processedCount > 0) {
    const processedSet = new Set(processedIds);
    const affectedEmployeeIds = [...new Set(
      revertable.filter((a) => processedSet.has(Number(a.id))).map((a) => Number(a.employee_id)),
    )];
    void emitCorrectionChanged({
      employeeIds: affectedEmployeeIds,
      reviewerUserId: req.user.id,
      action: 'bulk_revert',
    });
  }

  res.json({
    success: true,
    data: {
      processed_count: processedCount,
      skipped_not_pending: skippedNotPending,
      skipped_no_access: skippedNoAccess,
    },
  });
}

const bulkRevertByIds = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    await bulkRevertByIdsImpl(req, res, req.body?.ids);
  } catch (err) {
    console.error('correction-approval.bulkRevertByIds error:', err);
    res.status(500).json({ success: false, error: 'Ошибка массового отката' });
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
    // Согласование — write: view-отдел (миграция 167) виден, но согласовывать нельзя.
    const editableForBulk = await resolveEditableDepartmentIds(req);
    if (editableForBulk !== 'all' && !editableForBulk.includes(deptId)) {
      res.status(403).json({ success: false, error: 'Нет доступа к отделу' });
      return;
    }

    const empRows = await query<{ id: number }>(
      `SELECT id FROM employees WHERE org_department_id = $1`,
      [deptId],
    );
    const employeeIds = empRows.map(r => Number(r.id));
    if (employeeIds.length === 0) {
      res.json({ success: true, data: { approved_count: 0 } });
      return;
    }

    const candidates = await query<{ id: number; employee_id: number; work_date: string }>(
      `SELECT id, employee_id, work_date::text AS work_date
         FROM attendance_adjustments
        WHERE approval_status = 'pending'
          AND employee_id = ANY($1::bigint[])
          AND work_date >= $2::date
          AND work_date <= $3::date`,
      [employeeIds, startDate, endDate],
    );
    const allowedSet = await filterApprovableIds(
      req,
      candidates.map(a => ({ id: Number(a.id), employee_id: Number(a.employee_id), work_date: String(a.work_date) })),
    );
    const allowedIds = candidates.filter(a => allowedSet.has(Number(a.id))).map(a => Number(a.id));

    const now = new Date().toISOString();
    const updated = allowedIds.length > 0
      ? await query<{ id: number }>(
        `UPDATE attendance_adjustments SET
           approval_status = 'approved',
           approved_by = $1,
           approved_at = $2,
           approval_comment = NULL
         WHERE id = ANY($3::bigint[])
           AND approval_status = 'pending'
         RETURNING id`,
        [req.user.id, now, allowedIds],
      )
      : [];

    const approvedIds = updated.map((r) => Number(r.id));
    if (approvedIds.length > 0) {
      await syncWorkLeaveRequestsForAdjustmentIds(approvedIds, req.user.id, null);
    }

    const approvedCount = updated.length;

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

    if (approvedCount > 0) {
      const approvedSet = new Set(approvedIds);
      const affectedEmployeeIds = [...new Set(
        candidates.filter((a) => approvedSet.has(Number(a.id))).map((a) => Number(a.employee_id)),
      )];
      void emitCorrectionChanged({
        employeeIds: affectedEmployeeIds,
        reviewerUserId: req.user.id,
        action: 'bulk_approve',
      });
    }

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
    const directReportIds = req.user.employee_id
      ? await listDirectSubordinates(req.user.employee_id)
      : [];
    const directReportsSet = new Set(directReportIds);
    const viewerEmployeeId = req.user.employee_id ?? null;

    if (accessible !== 'all' && accessible.length === 0 && directReportIds.length === 0 && viewerEmployeeId == null) {
      res.json({ success: true, data: [] });
      return;
    }

    const adjustments = await query<{
      id: number;
      employee_id: number;
      work_date: string;
      status: string;
      hours_override: number | null;
      reason: string | null;
      created_by: string | null;
      created_at: string;
      approval_status: string;
      approved_by: string | null;
      approved_at: string | null;
      approval_comment: string | null;
    }>(
      `SELECT id, employee_id, work_date::text AS work_date, status, hours_override, reason, created_by, created_at,
              approval_status, approved_by, approved_at, approval_comment
         FROM attendance_adjustments
        WHERE approval_status = ANY($1::text[])
          AND work_date >= $2::date
          AND work_date <= $3::date
        ORDER BY approved_at DESC`,
      [statuses, startDate, endDate],
    );

    if (adjustments.length === 0) {
      res.json({ success: true, data: [] });
      return;
    }

    const employeeIds = [...new Set(adjustments.map(a => Number(a.employee_id)))];
    const employees = await query<{ id: number; full_name: string | null; org_department_id: string | null }>(
      `SELECT e.id, e.full_name, e.org_department_id
         FROM employees e
        WHERE e.id = ANY($1::bigint[])`,
      [employeeIds],
    );

    const isAllScope = accessible === 'all';
    const allowedDeptIds = isAllScope ? null : new Set(accessible);
    const requiredDepartments = await correctionApprovalSettingsService.getRequiredDepartmentIds();

    // История согласований — только по отделам из настройки (whitelist).
    const empInfoMap = new Map<number, { full_name: string | null; department_id: string | null }>();
    for (const e of employees) {
      const deptId = e.org_department_id ? String(e.org_department_id) : null;
      if (!deptId || !requiredDepartments.has(deptId)) continue;
      empInfoMap.set(Number(e.id), { full_name: e.full_name ?? null, department_id: deptId });
    }
    if (empInfoMap.size === 0) {
      res.json({ success: true, data: [] });
      return;
    }

    const routableRows = adjustments
      .filter(a => empInfoMap.has(Number(a.employee_id)))
      .map(a => ({
        id: Number(a.id),
        employee_id: Number(a.employee_id),
        work_date: String(a.work_date),
        org_department_id: empInfoMap.get(Number(a.employee_id))!.department_id,
      }));
    const responsiblesMap = await resolveResponsibleEmployeeIdsForRows(routableRows);

    const decisions = new Map<number, { directOnly: boolean }>();
    for (const adj of adjustments) {
      const empInfo = empInfoMap.get(Number(adj.employee_id));
      if (!empInfo) continue;
      const responsibles = responsiblesMap.get(Number(adj.id)) ?? [];
      if (responsibles.length > 0) {
        if (viewerEmployeeId != null && responsibles.includes(viewerEmployeeId)) {
          decisions.set(Number(adj.id), { directOnly: false });
        }
        continue;
      }
      if (isAllScope) {
        decisions.set(Number(adj.id), { directOnly: false });
        continue;
      }
      const inDeptSubtree = empInfo.department_id !== null && !!allowedDeptIds && allowedDeptIds.has(empInfo.department_id);
      const isDirectReport = directReportsSet.has(Number(adj.employee_id));
      if (inDeptSubtree || isDirectReport) {
        decisions.set(Number(adj.id), { directOnly: !inDeptSubtree && isDirectReport });
      }
    }
    if (decisions.size === 0) {
      res.json({ success: true, data: [] });
      return;
    }

    const deptIds = [...new Set([...decisions.entries()]
      .filter(([, d]) => !d.directOnly)
      .map(([adjId]) => {
        const adj = adjustments.find(a => Number(a.id) === adjId);
        return adj ? empInfoMap.get(Number(adj.employee_id))?.department_id ?? null : null;
      })
      .filter((id): id is string => id !== null))];
    const deptNamesMap = new Map<string, string>();
    if (deptIds.length > 0) {
      const deptRows = await query<{ id: string; name: string | null }>(
        `SELECT id, name FROM org_departments WHERE id = ANY($1::uuid[])`,
        [deptIds],
      );
      for (const row of deptRows) {
        deptNamesMap.set(String(row.id), String(row.name ?? ''));
      }
    }

    const userIds = [...new Set([
      ...adjustments.map(a => a.created_by).filter((v): v is string => Boolean(v)),
      ...adjustments.map(a => a.approved_by).filter((v): v is string => Boolean(v)),
    ])];
    const userNamesMap = new Map<string, string>();
    if (userIds.length > 0) {
      const userRows = await query<{ id: string; full_name: string | null }>(
        `SELECT id, full_name FROM user_profiles WHERE id = ANY($1::uuid[])`,
        [userIds],
      );
      for (const row of userRows) {
        userNamesMap.set(String(row.id), String(row.full_name ?? ''));
      }
    }

    const groups = new Map<string, IDepartmentGroup>();
    for (const adj of adjustments) {
      const decision = decisions.get(Number(adj.id));
      if (!decision) continue;
      const empInfo = empInfoMap.get(Number(adj.employee_id));
      if (!empInfo) continue;
      const isDirectOnly = decision.directOnly;
      const deptId = isDirectOnly ? DIRECT_REPORTS_GROUP_ID : empInfo.department_id;
      if (!deptId) continue;
      let group = groups.get(deptId);
      if (!group) {
        group = {
          department_id: deptId,
          department_name: isDirectOnly
            ? DIRECT_REPORTS_GROUP_NAME
            : (deptNamesMap.get(deptId) ?? deptId),
          pending_count: 0,
          employees_count: 0,
          items: [],
          is_direct_reports: isDirectOnly,
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
        notes: adj.reason ?? null,
        created_by: adj.created_by ? String(adj.created_by) : null,
        created_by_name: adj.created_by ? userNamesMap.get(String(adj.created_by)) ?? null : null,
        created_at: String(adj.created_at),
        approval_status: String(adj.approval_status) as 'approved' | 'rejected',
        approved_by: adj.approved_by ? String(adj.approved_by) : null,
        approved_by_name: adj.approved_by ? userNamesMap.get(String(adj.approved_by)) ?? null : null,
        approved_at: adj.approved_at ? String(adj.approved_at) : null,
        approval_comment: adj.approval_comment ?? null,
      });
    }

    for (const group of groups.values()) {
      group.pending_count = group.items.length;
      group.employees_count = new Set(group.items.map(i => i.employee_id)).size;
    }

    const result = [...groups.values()].sort((a, b) => {
      if (a.is_direct_reports && !b.is_direct_reports) return 1;
      if (!a.is_direct_reports && b.is_direct_reports) return -1;
      return a.department_name.localeCompare(b.department_name, 'ru');
    });
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('correction-approval.getHistoryByDepartment error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения истории корректировок' });
  }
};

/** Группа заявок одного ответственного: внутри — те же карточки отделов, что видит он сам. */
interface IResponsibleGroup {
  responsible_employee_id: number | null;
  responsible_name: string | null;
  items_count: number;
  employees_count: number;
  departments: IDepartmentGroup[];
  is_unassigned?: boolean;
}

/** Сентинель-ключ bucket'а «Без назначенного ответственного» (employee_id всегда > 0). */
const UNASSIGNED_RESPONSIBLE_KEY = 0;

/** Строит карточки отделов из набора уже готовых item'ов (группировка по отделу сотрудника). */
function buildDepartmentGroups(
  items: IPendingItem[],
  deptByEmp: Map<number, string | null>,
  deptNamesMap: Map<string, string>,
): IDepartmentGroup[] {
  const groups = new Map<string, IDepartmentGroup>();
  for (const item of items) {
    const deptId = deptByEmp.get(Number(item.employee_id)) ?? null;
    if (!deptId) continue;
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
    group.items.push(item);
  }
  for (const group of groups.values()) {
    group.pending_count = group.items.length;
    group.employees_count = new Set(group.items.map(i => i.employee_id)).size;
  }
  return [...groups.values()].sort((a, b) => a.department_name.localeCompare(b.department_name, 'ru'));
}

/**
 * Админ-обзор очереди согласований выходных, сгруппированный по ответственным
 * лицам (read-only). В отличие от getPendingByDepartment, НЕ скрывает
 * маршрутизированные строки — показывает их под их ответственным, чтобы
 * админ видел раздел «глазами» каждого ответственного.
 *
 * Скоуп: system-admin (`'all'`) — все строки whitelist-отделов; company-admin —
 * только в пределах своего scope (без добавления direct-reports). Пустой scope
 * у админа → []. Не-админ → 403.
 */
const getAllByResponsible = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!req.user.is_admin) {
      res.status(403).json({ success: false, error: 'Insufficient permissions' });
      return;
    }

    const startDate = isIsoDate(req.query.start_date) ? req.query.start_date : null;
    const endDate = isIsoDate(req.query.end_date) ? req.query.end_date : null;
    if (!startDate || !endDate || endDate < startDate) {
      res.status(400).json({ success: false, error: 'start_date и end_date обязательны (YYYY-MM-DD)' });
      return;
    }
    const mode: 'pending' | 'history' = req.query.mode === 'history' ? 'history' : 'pending';

    const accessible = await resolveAccessibleDepartmentIds(req);
    // Админ с пустым scope (company-admin без доступа) → пустой список, не 403.
    if (accessible !== 'all' && accessible.length === 0) {
      res.json({ success: true, data: [] });
      return;
    }
    const isAllScope = accessible === 'all';
    const allowedDeptIds = isAllScope ? null : new Set(accessible);

    const adjustments = await query<{
      id: number;
      employee_id: number;
      work_date: string;
      status: string;
      hours_override: number | null;
      reason: string | null;
      created_by: string | null;
      created_at: string;
      approval_status: string;
      approved_by: string | null;
      approved_at: string | null;
      approval_comment: string | null;
    }>(
      // Обе ветки используют $1::text[] (статусы), $2/$3 — даты. Текст pending-ветки
      // ОБЯЗАН ссылаться на $1, иначе PostgreSQL падает на Parse: "could not determine
      // data type of parameter $1" (мокнутые тесты этого не ловят).
      mode === 'history'
        ? `SELECT id, employee_id, work_date::text AS work_date, status, hours_override, reason, created_by, created_at,
                  approval_status, approved_by, approved_at, approval_comment
             FROM attendance_adjustments
            WHERE approval_status = ANY($1::text[])
              AND work_date >= $2::date
              AND work_date <= $3::date
            ORDER BY approved_at DESC`
        : `SELECT id, employee_id, work_date::text AS work_date, status, hours_override, reason, created_by, created_at,
                  approval_status, approved_by, approved_at, approval_comment
             FROM attendance_adjustments
            WHERE approval_status = ANY($1::text[])
              AND work_date >= $2::date
              AND work_date <= $3::date
            ORDER BY work_date ASC`,
      mode === 'history' ? [['approved', 'rejected'], startDate, endDate] : [['pending'], startDate, endDate],
    );

    if (adjustments.length === 0) {
      res.json({ success: true, data: [] });
      return;
    }

    const employeeIds = [...new Set(adjustments.map(a => Number(a.employee_id)))];
    const employees = await query<{ id: number; full_name: string | null; org_department_id: string | null }>(
      `SELECT e.id, e.full_name, e.org_department_id
         FROM employees e
        WHERE e.id = ANY($1::bigint[])`,
      [employeeIds],
    );

    const requiredDepartments = await correctionApprovalSettingsService.getRequiredDepartmentIds();

    // Только whitelist-отделы и только в пределах scope (без direct-reports).
    const empInfoMap = new Map<number, { full_name: string | null; department_id: string | null }>();
    for (const e of employees) {
      const deptId = e.org_department_id ? String(e.org_department_id) : null;
      if (!deptId || !requiredDepartments.has(deptId)) continue;
      if (!isAllScope && !allowedDeptIds!.has(deptId)) continue;
      empInfoMap.set(Number(e.id), { full_name: e.full_name ?? null, department_id: deptId });
    }
    if (empInfoMap.size === 0) {
      res.json({ success: true, data: [] });
      return;
    }

    const visibleAdjustments = adjustments.filter(a => empInfoMap.has(Number(a.employee_id)));
    const routableRows = visibleAdjustments.map(a => ({
      id: Number(a.id),
      employee_id: Number(a.employee_id),
      work_date: String(a.work_date),
      org_department_id: empInfoMap.get(Number(a.employee_id))!.department_id,
    }));
    const responsiblesMap = await resolveResponsibleEmployeeIdsForRows(routableRows);

    // Имена отделов и авторов/проверяющих — одним проходом по видимым строкам.
    const deptNamesMap = new Map<string, string>();
    const deptByEmp = new Map<number, string | null>();
    const visibleDeptIds = new Set<string>();
    for (const [empId, info] of empInfoMap) {
      deptByEmp.set(empId, info.department_id);
      if (info.department_id) visibleDeptIds.add(info.department_id);
    }
    if (visibleDeptIds.size > 0) {
      const deptRows = await query<{ id: string; name: string | null }>(
        `SELECT id, name FROM org_departments WHERE id = ANY($1::uuid[])`,
        [[...visibleDeptIds]],
      );
      for (const row of deptRows) deptNamesMap.set(String(row.id), String(row.name ?? ''));
    }

    const userIds = [...new Set([
      ...visibleAdjustments.map(a => a.created_by).filter((v): v is string => Boolean(v)),
      ...visibleAdjustments.map(a => a.approved_by).filter((v): v is string => Boolean(v)),
    ])];
    const userNamesMap = new Map<string, string>();
    if (userIds.length > 0) {
      const userRows = await query<{ id: string; full_name: string | null }>(
        `SELECT id, full_name FROM user_profiles WHERE id = ANY($1::uuid[])`,
        [userIds],
      );
      for (const row of userRows) userNamesMap.set(String(row.id), String(row.full_name ?? ''));
    }

    // Один item на строку (переиспользуется во всех bucket'ах ответственных).
    const itemByAdjId = new Map<number, IPendingItem>();
    for (const adj of visibleAdjustments) {
      const empInfo = empInfoMap.get(Number(adj.employee_id))!;
      itemByAdjId.set(Number(adj.id), {
        id: Number(adj.id),
        employee_id: Number(adj.employee_id),
        employee_name: empInfo.full_name,
        work_date: String(adj.work_date),
        status: String(adj.status),
        hours_override: typeof adj.hours_override === 'number' ? adj.hours_override : null,
        notes: adj.reason ?? null,
        created_by: adj.created_by ? String(adj.created_by) : null,
        created_by_name: adj.created_by ? userNamesMap.get(String(adj.created_by)) ?? null : null,
        created_at: String(adj.created_at),
        approval_status: String(adj.approval_status) as IPendingItem['approval_status'],
        approved_by: adj.approved_by ? String(adj.approved_by) : null,
        approved_by_name: adj.approved_by ? userNamesMap.get(String(adj.approved_by)) ?? null : null,
        approved_at: adj.approved_at ? String(adj.approved_at) : null,
        approval_comment: adj.approval_comment ?? null,
      });
    }

    // Раскладка строк по ответственным (строка может попасть к нескольким).
    const buckets = new Map<number, IPendingItem[]>();
    for (const adj of visibleAdjustments) {
      const item = itemByAdjId.get(Number(adj.id))!;
      const responsibles = responsiblesMap.get(Number(adj.id)) ?? [];
      const keys = responsibles.length > 0 ? responsibles : [UNASSIGNED_RESPONSIBLE_KEY];
      for (const key of keys) {
        const list = buckets.get(key) ?? [];
        list.push(item);
        buckets.set(key, list);
      }
    }

    // Имена ответственных.
    const responsibleIds = [...buckets.keys()].filter(k => k !== UNASSIGNED_RESPONSIBLE_KEY);
    const responsibleNames = new Map<number, string | null>();
    if (responsibleIds.length > 0) {
      const rows = await query<{ id: number; full_name: string | null }>(
        `SELECT id, full_name FROM employees WHERE id = ANY($1::bigint[])`,
        [responsibleIds],
      );
      for (const row of rows) responsibleNames.set(Number(row.id), row.full_name ?? null);
    }

    const result: IResponsibleGroup[] = [];
    for (const [key, items] of buckets) {
      const departments = buildDepartmentGroups(items, deptByEmp, deptNamesMap);
      result.push({
        responsible_employee_id: key === UNASSIGNED_RESPONSIBLE_KEY ? null : key,
        responsible_name: key === UNASSIGNED_RESPONSIBLE_KEY ? null : (responsibleNames.get(key) ?? null),
        items_count: items.length,
        employees_count: new Set(items.map(i => i.employee_id)).size,
        departments,
        is_unassigned: key === UNASSIGNED_RESPONSIBLE_KEY,
      });
    }

    result.sort((a, b) => {
      if (a.is_unassigned && !b.is_unassigned) return 1;
      if (!a.is_unassigned && b.is_unassigned) return -1;
      return (a.responsible_name ?? '').localeCompare(b.responsible_name ?? '', 'ru');
    });

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('correction-approval.getAllByResponsible error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения обзора по ответственным' });
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
    const approvable = await filterApprovableIds(req, [
      { id: adj.id, employee_id: adj.employee_id, work_date: adj.work_date },
    ]);
    if (!approvable.has(adj.id)) {
      res.status(403).json({ success: false, error: 'Нет доступа к корректировке' });
      return;
    }

    const prevStatus = adj.approval_status;
    const updatedRows = await query<{ id: number }>(
      `UPDATE attendance_adjustments SET
         approval_status = 'pending',
         approved_by = NULL,
         approved_at = NULL,
         approval_comment = NULL
       WHERE id = $1 AND approval_status = ANY($2::text[])
       RETURNING id`,
      [id, ['approved', 'rejected']],
    );

    if (updatedRows.length === 0) {
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

    void emitCorrectionChanged({
      employeeIds: [adj.employee_id],
      reviewerUserId: req.user.id,
      action: 'revert',
      entityId: id,
    });

    res.json({ success: true, data: { id, approval_status: 'pending' } });
  } catch (err) {
    console.error('correction-approval.revertOne error:', err);
    res.status(500).json({ success: false, error: 'Ошибка отката утверждения' });
  }
};

/** Окно пересчёта approval_status после смены настройки: 12 мес. назад … конец текущего месяца. */
function settingsRecomputeWindow(): { start: string; end: string } {
  const now = new Date();
  const startD = new Date(now.getFullYear(), now.getMonth() - 12, 1);
  const endD = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const iso = (d: Date): string =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { start: iso(startD), end: iso(endD) };
}

/** GET /settings — список отделов, которым требуется согласование выходных дней. */
const getSettings = async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const requiredDepartments = await correctionApprovalSettingsService.getRequiredDepartmentIds();
    res.json({ success: true, data: { requiredDepartmentIds: [...requiredDepartments] } });
  } catch (err) {
    console.error('correction-approval.getSettings error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения настроек согласования' });
  }
};

/**
 * PUT /settings — сохранить whitelist отделов. После сохранения пересчитывает
 * approval_status корректировок (auto_approved/pending) у сотрудников отделов,
 * чей флаг изменился — записи появляются/исчезают из очереди сразу.
 */
const saveSettings = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const raw = req.body?.requiredDepartmentIds;
    if (!Array.isArray(raw)) {
      res.status(400).json({ success: false, error: 'requiredDepartmentIds: ожидается массив' });
      return;
    }
    const ids = raw.filter((v): v is string => typeof v === 'string');

    const before = await correctionApprovalSettingsService.getRequiredDepartmentIds();
    const saved = await correctionApprovalSettingsService.setRequiredDepartmentIds(ids, req.user.id);
    const after = new Set(saved);

    // Отделы, у которых флаг «требуется согласование» изменился.
    const changedDeptIds: string[] = [];
    for (const id of before) if (!after.has(id)) changedDeptIds.push(id);
    for (const id of after) if (!before.has(id)) changedDeptIds.push(id);

    let recomputed = 0;
    if (changedDeptIds.length > 0) {
      const empRows = await query<{ id: number }>(
        `SELECT id FROM employees WHERE org_department_id = ANY($1::uuid[])`,
        [changedDeptIds],
      );
      const employeeIds = empRows.map(r => Number(r.id));
      if (employeeIds.length > 0) {
        const { start, end } = settingsRecomputeWindow();
        recomputed = await reapproveAdjustmentsForRange(employeeIds, start, end);
      }
    }

    await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.CORRECTION_APPROVAL_SETTINGS_CHANGED, {
      entityType: 'system_setting',
      entityId: 'correction_approval_required_department_ids',
      details: {
        required_count: saved.length,
        changed_departments: changedDeptIds.length,
        recomputed_adjustments: recomputed,
      },
    });

    res.json({ success: true, data: { requiredDepartmentIds: saved } });
  } catch (err) {
    console.error('correction-approval.saveSettings error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения настроек согласования' });
  }
};

export const correctionApprovalController = {
  getPendingByDepartment,
  getHistoryByDepartment,
  getAllByResponsible,
  approveOne,
  rejectOne,
  revertOne,
  bulkApprove,
  bulkApproveByIds,
  bulkRejectByIds,
  bulkRevertByIds,
  getSettings,
  saveSettings,
};
