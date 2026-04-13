import type { Response } from 'express';
import { supabase } from '../config/database.js';
import type {
  AuthenticatedRequest,
  TimesheetApproval,
  TimesheetApprovalEventAction,
  TimesheetApprovalStatus,
} from '../types/index.js';
import { resolveRequestDataScope, resolveScopedDepartmentId } from '../services/data-scope.service.js';
import { notificationService } from '../services/notification.service.js';
import { pushService } from '../services/push.service.js';
import { auditService, AUDIT_ACTIONS } from '../services/audit.service.js';
import { parseTimesheetApprovalPeriod, formatTimesheetHalfLabel } from '../services/timesheet-period.service.js';
import { timesheetResponsiblesService } from '../services/timesheet-responsibles.service.js';
import { timesheetApprovalHistoryService } from '../services/timesheet-approval-history.service.js';

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
  await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS[action], {
    entityType: 'timesheet_approval',
    entityId: String(approvalId),
    details,
  });
}

async function notifyHrAboutSubmittedApproval(departmentId: string, period: string): Promise<void> {
  const recipients = await timesheetResponsiblesService.getHrRecipientsForDepartment(departmentId);
  if (recipients.length === 0) return;

  const parsed = parseTimesheetApprovalPeriod(period);
  const departmentName = await loadDepartmentName(departmentId);
  const periodLabel = parsed ? formatTimesheetHalfLabel(parsed.half, parsed.year, parsed.month) : period;
  const title = 'Табель отправлен на проверку';
  const body = `Отдел ${departmentName}: табель за период ${periodLabel} отправлен на проверку HR.`;
  const path = parsed
    ? `/timesheet-hr?month=${parsed.year}-${String(parsed.month).padStart(2, '0')}&half=${parsed.half}`
    : '/timesheet-hr';

  await notificationService.createMany(recipients.map(userId => ({
    userId,
    type: 'timesheet_approval_submitted',
    title,
    body,
    metadata: {
      departmentId,
      period,
      path,
    },
  })));
  await pushService.sendGenericNotification(recipients, title, body, { path, period });
}

async function notifyDepartmentAboutReview(
  departmentId: string,
  period: string,
  status: ReviewStatus,
  submittedBy: string | null,
  comment: string | null,
): Promise<void> {
  const reminderRecipients = await timesheetResponsiblesService.getReminderRecipientsByDepartment(departmentId);
  const recipients = new Set<string>();

  for (const userId of reminderRecipients.primary) recipients.add(userId);
  for (const userId of reminderRecipients.backup) recipients.add(userId);
  if (submittedBy) recipients.add(submittedBy);

  if (recipients.size === 0) return;

  const parsed = parseTimesheetApprovalPeriod(period);
  const departmentName = await loadDepartmentName(departmentId);
  const periodLabel = parsed ? formatTimesheetHalfLabel(parsed.half, parsed.year, parsed.month) : period;
  const commentSuffix = comment ? ` Комментарий: ${comment}` : '';
  const path = parsed
    ? `/timesheet?month=${parsed.year}-${String(parsed.month).padStart(2, '0')}&half=${parsed.half}`
    : '/timesheet';

  let title = 'Статус табеля изменён';
  let body = `Отдел ${departmentName}: статус табеля за период ${periodLabel} изменён.${commentSuffix}`;
  let type = 'timesheet_approval_reviewed';

  if (status === 'approved') {
    title = 'Табель утверждён';
    body = `Отдел ${departmentName}: табель за период ${periodLabel} утверждён.${commentSuffix}`;
    type = 'timesheet_approval_approved';
  }

  if (status === 'rejected') {
    title = 'Табель отклонён';
    body = `Отдел ${departmentName}: табель за период ${periodLabel} отклонён, нужна переподача.${commentSuffix}`;
    type = 'timesheet_approval_rejected';
  }

  if (status === 'returned') {
    title = 'Табель возвращён на доработку';
    body = `Отдел ${departmentName}: утверждённый табель за период ${periodLabel} возвращён на доработку.${commentSuffix}`;
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
      period,
      status,
      path,
    },
  })));
  await pushService.sendGenericNotification(recipientIds, title, body, { path, period, status });
}

async function persistApprovalTransition(input: {
  approvalId: number;
  departmentId: string;
  period: string;
  fromStatus: TimesheetApprovalStatus | null;
  toStatus: Exclude<TimesheetApprovalStatus, 'draft'>;
  action: TimesheetApprovalEventAction;
  actorUserId: string;
  comment?: string | null;
}): Promise<void> {
  await timesheetApprovalHistoryService.appendEvent({
    approvalId: input.approvalId,
    departmentId: input.departmentId,
    period: input.period,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    action: input.action,
    actorUserId: input.actorUserId,
    comment: input.comment ?? null,
  });
}

/** Header подтверждает табель отдела за период */
const submit = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { department_id, period } = req.body;
    const deptId = await resolveScopedDepartmentId(req, department_id || null);

    if (!deptId || !period) {
      res.status(400).json({ success: false, error: 'department_id и period обязательны' });
      return;
    }

    if (typeof period !== 'string' || !parseTimesheetApprovalPeriod(period)) {
      res.status(400).json({ success: false, error: 'period должен быть в формате YYYY-MM-H1 или YYYY-MM-H2' });
      return;
    }

    const { data: existingApproval, error: existingError } = await supabase
      .from('timesheet_approvals')
      .select('*')
      .eq('department_id', deptId)
      .eq('period', period)
      .maybeSingle();

    if (existingError) throw existingError;

    const existing = (existingApproval as TimesheetApproval | null) ?? null;
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
          period,
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

    await persistApprovalTransition({
      approvalId: approval.id,
      departmentId: deptId,
      period,
      fromStatus: existing?.status ?? null,
      toStatus: 'submitted',
      action: 'submitted',
      actorUserId: req.user.id,
    });

    await logApprovalAudit(req, approval.id, 'TIMESHEET_APPROVAL_SUBMITTED', {
      department_id: deptId,
      period,
      from_status: existing?.status ?? null,
      to_status: 'submitted',
    });

    void notifyHrAboutSubmittedApproval(deptId, period).catch(notifyError => {
      console.error('timesheet-approval.submit notify error:', notifyError);
    });

    res.json({ success: true, data: approval });
  } catch (err) {
    console.error('timesheet-approval.submit error:', err);
    res.status(500).json({ success: false, error: 'Ошибка подтверждения табеля' });
  }
};

/** Статус согласования по отделу и периоду */
const getStatus = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const department_id = await resolveScopedDepartmentId(
      req,
      typeof req.query.department_id === 'string' ? req.query.department_id : null,
    );
    const period = req.query.period as string;

    if (!department_id || !period) {
      res.json({ success: true, data: null });
      return;
    }

    if (!parseTimesheetApprovalPeriod(period)) {
      res.status(400).json({ success: false, error: 'period должен быть в формате YYYY-MM-H1 или YYYY-MM-H2' });
      return;
    }

    const { data, error } = await supabase
      .from('timesheet_approvals')
      .select('*')
      .eq('department_id', department_id)
      .eq('period', period)
      .maybeSingle();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    console.error('timesheet-approval.getStatus error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения статуса' });
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

    await persistApprovalTransition({
      approvalId: updatedApproval.id,
      departmentId: updatedApproval.department_id,
      period: updatedApproval.period,
      fromStatus: approval.status,
      toStatus: input.nextStatus,
      action: input.action,
      actorUserId: req.user.id,
      comment,
    });

    await logApprovalAudit(req, updatedApproval.id, input.auditAction, {
      department_id: updatedApproval.department_id,
      period: updatedApproval.period,
      from_status: approval.status,
      to_status: input.nextStatus,
      comment,
    });

    void notifyDepartmentAboutReview(
      approval.department_id,
      approval.period,
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

/** HR утверждает табель */
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

/** HR отклоняет табель */
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

/** HR возвращает утверждённый табель на доработку */
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

/** История согласования по конкретному табелю */
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

/** HR: все неутверждённые табели */
const getPending = async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const scope = await resolveRequestDataScope(_req);
    let query = supabase
      .from('timesheet_approvals')
      .select('*')
      .eq('status', 'submitted')
      .order('submitted_at', { ascending: false });

    if (scope === 'department' && _req.user.department_id) {
      query = query.eq('department_id', _req.user.department_id);
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

/** HR: список табелей по статусу */
const getByStatus = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const requestedStatus = req.query.status as string | undefined;
    const status = requestedStatus as TimesheetApprovalStatus | undefined;

    if (status && !LISTABLE_STATUSES.has(status)) {
      res.status(400).json({ success: false, error: 'Некорректный статус tabеля' });
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

    if (scope === 'department' && req.user.department_id) {
      query = query.eq('department_id', req.user.department_id);
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
