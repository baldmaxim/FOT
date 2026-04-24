import type { Response } from 'express';
import { supabase } from '../config/database.js';
import type {
  AuthenticatedRequest,
  TimesheetApproval,
  TimesheetApprovalEventAction,
  TimesheetApprovalStatus,
} from '../types/index.js';
import {
  resolveManagedDepartmentIds,
  resolveRequestDataScope,
  resolveScopedDepartmentId,
} from '../services/data-scope.service.js';
import { notificationService } from '../services/notification.service.js';
import { pushService } from '../services/push.service.js';
import { auditService, AUDIT_ACTIONS } from '../services/audit.service.js';
import {
  formatTimesheetRangeLabel,
  isIsoDate,
  type ITimesheetDateRange,
} from '../services/timesheet-range.service.js';
import { timesheetResponsiblesService } from '../services/timesheet-responsibles.service.js';
import { timesheetApprovalHistoryService } from '../services/timesheet-approval-history.service.js';
import { listTimesheetWorkflowRecipientIds } from '../services/timesheet-workflow-recipients.service.js';

type ReviewStatus = 'approved' | 'rejected' | 'returned';

const LISTABLE_STATUSES = new Set<TimesheetApprovalStatus>([
  'draft',
  'submitted',
  'approved',
  'rejected',
  'returned',
]);

function normalizeComment(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseRangeFromBody(body: unknown): ITimesheetDateRange | null {
  if (!body || typeof body !== 'object') return null;
  const { start_date, end_date } = body as Record<string, unknown>;
  if (!isIsoDate(start_date) || !isIsoDate(end_date)) return null;
  if (end_date < start_date) return null;
  return { startDate: start_date, endDate: end_date };
}

function parseRangeFromQuery(query: Record<string, unknown>): ITimesheetDateRange | null {
  const startDate = query.start_date ?? query.from;
  const endDate = query.end_date ?? query.to;
  if (!isIsoDate(startDate) || !isIsoDate(endDate)) return null;
  if (endDate < startDate) return null;
  return { startDate, endDate };
}

function buildRangeRedirectPath(root: string, range: ITimesheetDateRange): string {
  return `${root}?from=${range.startDate}&to=${range.endDate}`;
}

async function loadDepartmentName(departmentId: string): Promise<string> {
  const { data } = await supabase
    .from('org_departments')
    .select('name')
    .eq('id', departmentId)
    .maybeSingle();

  return (data?.name as string | undefined) || departmentId;
}

async function loadApprovalById(id: string): Promise<TimesheetApproval | null> {
  const { data, error } = await supabase
    .from('timesheet_approvals')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return (data as TimesheetApproval | null) ?? null;
}

async function ensureApprovalDepartmentAccess(
  req: AuthenticatedRequest,
  departmentId: string,
): Promise<boolean> {
  const scopedDepartmentId = await resolveScopedDepartmentId(req, departmentId);
  return !!scopedDepartmentId && scopedDepartmentId === departmentId;
}

async function logApprovalAudit(
  req: AuthenticatedRequest,
  approvalId: number,
  action: keyof typeof AUDIT_ACTIONS,
  details: Record<string, unknown>,
): Promise<void> {
  let enrichedDetails = details;
  const deptId = details.department_id;
  if (typeof deptId === 'string' && deptId && details.department_name === undefined) {
    try {
      const { data } = await supabase
        .from('org_departments')
        .select('name')
        .eq('id', deptId)
        .maybeSingle();
      enrichedDetails = { ...details, department_name: (data?.name as string | null) ?? null };
    } catch {
      // best-effort enrichment; keep original details
    }
  }
  await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS[action], {
    entityType: 'timesheet_approval',
    entityId: String(approvalId),
    details: enrichedDetails,
  });
}

async function notifyHrAboutSubmittedApproval(
  departmentId: string,
  range: ITimesheetDateRange,
): Promise<void> {
  const recipients = await listTimesheetWorkflowRecipientIds(departmentId, ['review', 'monitor']);
  if (recipients.length === 0) return;

  const departmentName = await loadDepartmentName(departmentId);
  const rangeLabel = formatTimesheetRangeLabel(range.startDate, range.endDate);
  const title = 'Табель отправлен на проверку';
  const body = `Отдел ${departmentName}: табель за ${rangeLabel} отправлен на проверку HR.`;
  const path = buildRangeRedirectPath('/timesheet-hr', range);

  await notificationService.createMany(recipients.map(userId => ({
    userId,
    type: 'timesheet_approval_submitted',
    title,
    body,
    metadata: {
      departmentId,
      start_date: range.startDate,
      end_date: range.endDate,
      path,
    },
  })));
  await pushService.sendGenericNotification(
    recipients,
    title,
    body,
    { path, start_date: range.startDate, end_date: range.endDate },
  );
}

async function notifyDepartmentAboutReview(
  departmentId: string,
  range: ITimesheetDateRange,
  status: ReviewStatus,
  submittedBy: string | null,
  comment: string | null,
): Promise<void> {
  const recipients = new Set<string>();
  const submitRecipients = await listTimesheetWorkflowRecipientIds(departmentId, ['submit']);

  for (const userId of submitRecipients) recipients.add(userId);
  if (submittedBy) recipients.add(submittedBy);

  if (recipients.size === 0) return;

  const departmentName = await loadDepartmentName(departmentId);
  const rangeLabel = formatTimesheetRangeLabel(range.startDate, range.endDate);
  const commentSuffix = comment ? ` Комментарий: ${comment}` : '';
  const path = buildRangeRedirectPath('/timesheet', range);

  let title = 'Статус табеля изменён';
  let body = `Отдел ${departmentName}: статус табеля за ${rangeLabel} изменён.${commentSuffix}`;
  let type = 'timesheet_approval_reviewed';

  if (status === 'approved') {
    title = 'Табель утверждён';
    body = `Отдел ${departmentName}: табель за ${rangeLabel} утверждён.${commentSuffix}`;
    type = 'timesheet_approval_approved';
  }

  if (status === 'rejected') {
    title = 'Табель отклонён';
    body = `Отдел ${departmentName}: табель за ${rangeLabel} отклонён, нужна переподача.${commentSuffix}`;
    type = 'timesheet_approval_rejected';
  }

  if (status === 'returned') {
    title = 'Табель возвращён на доработку';
    body = `Отдел ${departmentName}: утверждённый табель за ${rangeLabel} возвращён на доработку.${commentSuffix}`;
    type = 'timesheet_approval_returned';
  }

  const recipientIds = [...recipients];

  await notificationService.createMany(recipientIds.map(userId => ({
    userId,
    type,
    title,
    body,
    metadata: {
      departmentId,
      start_date: range.startDate,
      end_date: range.endDate,
      status,
      path,
    },
  })));
  await pushService.sendGenericNotification(
    recipientIds,
    title,
    body,
    { path, start_date: range.startDate, end_date: range.endDate, status },
  );
}

async function persistApprovalTransition(input: {
  approvalId: number;
  departmentId: string;
  range: ITimesheetDateRange;
  fromStatus: TimesheetApprovalStatus | null;
  toStatus: Exclude<TimesheetApprovalStatus, 'draft'>;
  action: TimesheetApprovalEventAction;
  actorUserId: string;
  comment?: string | null;
}): Promise<void> {
  await timesheetApprovalHistoryService.appendEvent({
    approvalId: input.approvalId,
    departmentId: input.departmentId,
    startDate: input.range.startDate,
    endDate: input.range.endDate,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    action: input.action,
    actorUserId: input.actorUserId,
    comment: input.comment ?? null,
  });
}

/** Руководитель подаёт табель отдела за произвольный диапазон дат. */
const submit = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const deptId = await resolveScopedDepartmentId(req, req.body.department_id || null);
    const range = parseRangeFromBody(req.body);

    if (!deptId) {
      res.status(400).json({ success: false, error: 'department_id обязателен' });
      return;
    }

    if (!range) {
      res.status(400).json({
        success: false,
        error: 'start_date и end_date обязательны (формат YYYY-MM-DD, end_date >= start_date)',
      });
      return;
    }

    const { data: exactRow, error: exactError } = await supabase
      .from('timesheet_approvals')
      .select('*')
      .eq('department_id', deptId)
      .eq('start_date', range.startDate)
      .eq('end_date', range.endDate)
      .maybeSingle();

    if (exactError) throw exactError;

    const existing = (exactRow as TimesheetApproval | null) ?? null;
    if (existing?.status === 'approved') {
      res.status(409).json({
        success: false,
        error: 'Утверждённый табель нельзя переподать напрямую. Сначала верните его на доработку через HR.',
      });
      return;
    }

    if (existing?.status === 'submitted') {
      res.json({ success: true, data: existing });
      return;
    }

    const now = new Date().toISOString();
    let approval: TimesheetApproval | null = null;

    try {
      if (existing) {
        const { data, error } = await supabase
          .from('timesheet_approvals')
          .update({
            status: 'submitted',
            submitted_by: req.user.id,
            submitted_at: now,
            reviewed_by: null,
            reviewed_at: null,
            review_comment: null,
            updated_at: now,
          })
          .eq('id', existing.id)
          .select()
          .single();

        if (error) throw error;
        approval = data as TimesheetApproval;
      } else {
        const { data, error } = await supabase
          .from('timesheet_approvals')
          .insert({
            department_id: deptId,
            start_date: range.startDate,
            end_date: range.endDate,
            status: 'submitted',
            submitted_by: req.user.id,
            submitted_at: now,
            reviewed_by: null,
            reviewed_at: null,
            review_comment: null,
            updated_at: now,
          })
          .select()
          .single();

        if (error) throw error;
        approval = data as TimesheetApproval;
      }
    } catch (dbErr) {
      const code = (dbErr as { code?: string } | null)?.code;
      if (code === '23P01') {
        res.status(409).json({
          success: false,
          error: 'Выбранный диапазон пересекается с уже поданным или утверждённым табелем этого отдела.',
        });
        return;
      }
      throw dbErr;
    }

    if (!approval) {
      res.status(500).json({ success: false, error: 'Ошибка подтверждения табеля' });
      return;
    }

    await persistApprovalTransition({
      approvalId: approval.id,
      departmentId: deptId,
      range,
      fromStatus: existing?.status ?? null,
      toStatus: 'submitted',
      action: 'submitted',
      actorUserId: req.user.id,
    });

    await logApprovalAudit(req, approval.id, 'TIMESHEET_APPROVAL_SUBMITTED', {
      department_id: deptId,
      start_date: range.startDate,
      end_date: range.endDate,
      from_status: existing?.status ?? null,
      to_status: 'submitted',
    });

    void notifyHrAboutSubmittedApproval(deptId, range).catch(notifyError => {
      console.error('timesheet-approval.submit notify error:', notifyError);
    });

    res.json({ success: true, data: approval });
  } catch (err) {
    console.error('timesheet-approval.submit error:', err);
    res.status(500).json({ success: false, error: 'Ошибка подтверждения табеля' });
  }
};

/** Статус согласования по отделу и конкретному диапазону. */
const getStatus = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const department_id = await resolveScopedDepartmentId(
      req,
      typeof req.query.department_id === 'string' ? req.query.department_id : null,
    );
    const range = parseRangeFromQuery(req.query as Record<string, unknown>);

    if (!department_id || !range) {
      res.json({ success: true, data: null });
      return;
    }

    const { data, error } = await supabase
      .from('timesheet_approvals')
      .select('*')
      .eq('department_id', department_id)
      .eq('start_date', range.startDate)
      .eq('end_date', range.endDate)
      .maybeSingle();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    console.error('timesheet-approval.getStatus error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения статуса' });
  }
};

/**
 * Список согласований отдела, пересекающихся с указанным диапазоном (или с месяцем,
 * если передан month=YYYY-MM). Используется фронтом для показа всех заблокированных
 * и поданных диапазонов вокруг текущей выборки.
 */
const listDepartmentApprovals = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const department_id = await resolveScopedDepartmentId(
      req,
      typeof req.query.department_id === 'string' ? req.query.department_id : null,
    );

    if (!department_id) {
      res.status(400).json({ success: false, error: 'department_id обязателен' });
      return;
    }

    let rangeStart: string | null = null;
    let rangeEnd: string | null = null;
    const monthParam = typeof req.query.month === 'string' ? req.query.month : null;
    if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
      const [y, m] = monthParam.split('-').map(Number);
      const lastDay = new Date(y, m, 0).getDate();
      rangeStart = `${monthParam}-01`;
      rangeEnd = `${monthParam}-${String(lastDay).padStart(2, '0')}`;
    } else {
      const queryRange = parseRangeFromQuery(req.query as Record<string, unknown>);
      if (queryRange) {
        rangeStart = queryRange.startDate;
        rangeEnd = queryRange.endDate;
      }
    }

    let query = supabase
      .from('timesheet_approvals')
      .select('*')
      .eq('department_id', department_id)
      .order('start_date', { ascending: true });

    if (rangeStart && rangeEnd) {
      query = query.lte('start_date', rangeEnd).gte('end_date', rangeStart);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json({ success: true, data: data || [] });
  } catch (err) {
    console.error('timesheet-approval.listDepartmentApprovals error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения согласований' });
  }
};

async function changeApprovalReviewState(
  req: AuthenticatedRequest,
  res: Response,
  input: {
    allowedFrom: TimesheetApprovalStatus;
    nextStatus: ReviewStatus;
    action: TimesheetApprovalEventAction;
    auditAction:
      | 'TIMESHEET_APPROVAL_APPROVED'
      | 'TIMESHEET_APPROVAL_REJECTED'
      | 'TIMESHEET_APPROVAL_RETURNED_TO_REWORK';
    invalidStatusMessage: string;
    successErrorMessage: string;
  },
): Promise<void> {
  try {
    const { id } = req.params;
    const comment = normalizeComment(req.body.comment);
    const approval = await loadApprovalById(id);

    if (!approval) {
      res.status(404).json({ success: false, error: 'Запись не найдена' });
      return;
    }

    if (approval.status !== input.allowedFrom) {
      res.status(400).json({ success: false, error: input.invalidStatusMessage });
      return;
    }

    if (!(await ensureApprovalDepartmentAccess(req, approval.department_id))) {
      res.status(403).json({ success: false, error: 'Нет доступа к табелю этого отдела' });
      return;
    }

    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from('timesheet_approvals')
      .update({
        status: input.nextStatus,
        reviewed_by: req.user.id,
        reviewed_at: now,
        review_comment: comment,
        updated_at: now,
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    const updatedApproval = data as TimesheetApproval;
    const range: ITimesheetDateRange = {
      startDate: updatedApproval.start_date,
      endDate: updatedApproval.end_date,
    };

    await persistApprovalTransition({
      approvalId: updatedApproval.id,
      departmentId: updatedApproval.department_id,
      range,
      fromStatus: approval.status,
      toStatus: input.nextStatus,
      action: input.action,
      actorUserId: req.user.id,
      comment,
    });

    await logApprovalAudit(req, updatedApproval.id, input.auditAction, {
      department_id: updatedApproval.department_id,
      start_date: range.startDate,
      end_date: range.endDate,
      from_status: approval.status,
      to_status: input.nextStatus,
      comment,
    });

    void notifyDepartmentAboutReview(
      approval.department_id,
      range,
      input.nextStatus,
      approval.submitted_by,
      comment,
    ).catch(notifyError => {
      console.error(`timesheet-approval.${input.action} notify error:`, notifyError);
    });

    res.json({ success: true, data: updatedApproval });
  } catch (err) {
    console.error(`timesheet-approval.${input.action} error:`, err);
    res.status(500).json({ success: false, error: input.successErrorMessage });
  }
}

/** HR утверждает табель. */
const approve = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  await changeApprovalReviewState(req, res, {
    allowedFrom: 'submitted',
    nextStatus: 'approved',
    action: 'approved',
    auditAction: 'TIMESHEET_APPROVAL_APPROVED',
    invalidStatusMessage: 'Табель не находится на проверке',
    successErrorMessage: 'Ошибка утверждения',
  });
};

/** HR отклоняет табель. */
const reject = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  await changeApprovalReviewState(req, res, {
    allowedFrom: 'submitted',
    nextStatus: 'rejected',
    action: 'rejected',
    auditAction: 'TIMESHEET_APPROVAL_REJECTED',
    invalidStatusMessage: 'Табель не находится на проверке',
    successErrorMessage: 'Ошибка отклонения',
  });
};

/** HR возвращает утверждённый табель на доработку. */
const returnToRework = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  await changeApprovalReviewState(req, res, {
    allowedFrom: 'approved',
    nextStatus: 'returned',
    action: 'returned_to_rework',
    auditAction: 'TIMESHEET_APPROVAL_RETURNED_TO_REWORK',
    invalidStatusMessage: 'На доработку можно вернуть только уже утверждённый табель',
    successErrorMessage: 'Ошибка возврата табеля на доработку',
  });
};

/** История согласования по конкретному табелю. */
const getHistory = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const approval = await loadApprovalById(id);

    if (!approval) {
      res.status(404).json({ success: false, error: 'Запись не найдена' });
      return;
    }

    if (!(await ensureApprovalDepartmentAccess(req, approval.department_id))) {
      res.status(403).json({ success: false, error: 'Нет доступа к табелю этого отдела' });
      return;
    }

    const data = await timesheetApprovalHistoryService.listByApprovalId(approval.id);
    res.json({ success: true, data });
  } catch (err) {
    console.error('timesheet-approval.getHistory error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения истории согласования' });
  }
};

/** HR: все неутверждённые табели. */
const getPending = async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const scope = await resolveRequestDataScope(_req);
    let query = supabase
      .from('timesheet_approvals')
      .select('*')
      .eq('status', 'submitted')
      .order('submitted_at', { ascending: false });

    if (scope === 'department') {
      const managedDepartmentIds = await resolveManagedDepartmentIds(_req);
      if (managedDepartmentIds.length === 0) {
        res.json({ success: true, data: [] });
        return;
      }
      query = query.in('department_id', managedDepartmentIds);
    } else if (scope === 'self') {
      res.json({ success: true, data: [] });
      return;
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err) {
    console.error('timesheet-approval.getPending error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения списка' });
  }
};

/** HR: список табелей по статусу. */
const getByStatus = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const requestedStatus = req.query.status as string | undefined;
    const status = requestedStatus as TimesheetApprovalStatus | undefined;

    if (status && !LISTABLE_STATUSES.has(status)) {
      res.status(400).json({ success: false, error: 'Некорректный статус табеля' });
      return;
    }

    const scope = await resolveRequestDataScope(req);
    let query = supabase
      .from('timesheet_approvals')
      .select('*');

    if (status === 'rejected') {
      query = query.in('status', ['rejected', 'returned']);
    } else if (status) {
      query = query.eq('status', status);
    }

    if (scope === 'department') {
      const managedDepartmentIds = await resolveManagedDepartmentIds(req);
      if (managedDepartmentIds.length === 0) {
        res.json({ success: true, data: [] });
        return;
      }
      query = query.in('department_id', managedDepartmentIds);
    } else if (scope === 'self') {
      res.json({ success: true, data: [] });
      return;
    }

    query = query.order('updated_at', { ascending: false });

    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err) {
    console.error('timesheet-approval.getByStatus error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения списка' });
  }
};

const getResponsibles = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const requestedDepartmentId = typeof req.query.department_id === 'string' ? req.query.department_id : null;
    const departmentId = await resolveScopedDepartmentId(req, requestedDepartmentId);

    if (!departmentId) {
      res.status(400).json({ success: false, error: 'department_id обязателен' });
      return;
    }

    const data = await timesheetResponsiblesService.getByDepartment(departmentId);
    res.json({ success: true, data });
  } catch (err) {
    console.error('timesheet-approval.getResponsibles error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения ответственных по табелю' });
  }
};

const getResponsibleCandidates = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const requestedDepartmentId = typeof req.query.department_id === 'string' ? req.query.department_id : null;
    const departmentId = await resolveScopedDepartmentId(req, requestedDepartmentId);

    if (!departmentId) {
      res.status(400).json({ success: false, error: 'department_id обязателен' });
      return;
    }

    const data = await timesheetResponsiblesService.getCandidateUsersByDepartment(departmentId);
    res.json({ success: true, data });
  } catch (err) {
    console.error('timesheet-approval.getResponsibleCandidates error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения кандидатов для ответственных по табелю' });
  }
};

const saveResponsibles = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const requestedDepartmentId = typeof req.body.department_id === 'string' ? req.body.department_id : null;
    const departmentId = await resolveScopedDepartmentId(req, requestedDepartmentId);
    const primaryUserId = typeof req.body.primary_user_id === 'string' && req.body.primary_user_id.trim()
      ? req.body.primary_user_id
      : null;
    const backupUserId = typeof req.body.backup_user_id === 'string' && req.body.backup_user_id.trim()
      ? req.body.backup_user_id
      : null;

    if (!departmentId) {
      res.status(400).json({ success: false, error: 'department_id обязателен' });
      return;
    }

    const data = await timesheetResponsiblesService.setDepartmentResponsibles({
      departmentId,
      primaryUserId,
      backupUserId,
    });

    res.json({ success: true, data });
  } catch (err) {
    console.error('timesheet-approval.saveResponsibles error:', err);
    const message = err instanceof Error ? err.message : 'Ошибка сохранения ответственных по табелю';
    const statusCode = err instanceof Error ? 400 : 500;
    res.status(statusCode).json({ success: false, error: message });
  }
};

export const timesheetApprovalController = {
  submit,
  getStatus,
  listDepartmentApprovals,
  approve,
  reject,
  returnToRework,
  getHistory,
  getPending,
  getByStatus,
  getResponsibles,
  getResponsibleCandidates,
  saveResponsibles,
};
