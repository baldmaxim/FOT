import type { Response } from 'express';
import { query, queryOne } from '../config/postgres.js';
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
import {
  checkManagerObjWeekendMemoRequirement,
  checkWeekendWorkRequirement,
} from '../services/timesheet-approval-weekend-check.service.js';
import { validateCorrectionAttachments } from '../services/timesheet-approval-correction-validation.service.js';
import { getAllowedSubmissionRange, isRangeSubmittable } from '../services/timesheet-period.service.js';
import { resolveEffectivePageAccess } from '../services/access-control.service.js';
import {
  APPROVAL_ATTACHMENT_CATEGORY,
  createAttachmentRecord,
  deleteAttachmentRecord,
  findOrCreateDraftApproval,
  listApprovalAttachments,
} from '../services/timesheet-approval-attachments.service.js';
import { r2Service } from '../services/r2.service.js';
import path from 'path';
import { randomUUID } from 'crypto';

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

function buildRangeRedirectPath(root: string, range: ITimesheetDateRange, departmentId?: string): string {
  const base = `${root}?from=${range.startDate}&to=${range.endDate}`;
  return departmentId ? `${base}&dept=${departmentId}` : base;
}

async function loadDepartmentName(departmentId: string): Promise<string> {
  const data = await queryOne<{ name: string | null }>(
    `SELECT name FROM org_departments WHERE id = $1 LIMIT 1`,
    [departmentId],
  );
  return (data?.name as string | undefined) || departmentId;
}

async function loadApprovalById(id: string): Promise<TimesheetApproval | null> {
  return queryOne<TimesheetApproval>(
    `SELECT * FROM timesheet_approvals WHERE id = $1 LIMIT 1`,
    [id],
  );
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
      const data = await queryOne<{ name: string | null }>(
        `SELECT name FROM org_departments WHERE id = $1 LIMIT 1`,
        [deptId],
      );
      enrichedDetails = { ...details, department_name: data?.name ?? null };
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
  const path = buildRangeRedirectPath('/timesheet', range, departmentId);

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
    const requestedDeptId = typeof req.body.department_id === 'string' && req.body.department_id ? req.body.department_id : null;
    const deptId = await resolveScopedDepartmentId(req, requestedDeptId);
    const range = parseRangeFromBody(req.body);

    if (requestedDeptId && !deptId) {
      res.status(403).json({ success: false, error: 'Access denied to this department', code: 'DEPARTMENT_ACCESS_DENIED' });
      return;
    }
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

    // Блокировка периода подачи: только последний завершённый полупериод (МСК).
    // system_admin / HR (доступ к /timesheet-hr) блокировку обходят.
    const submissionExempt = await resolveEffectivePageAccess(req, '/timesheet-hr', 'view');
    if (!submissionExempt && !isRangeSubmittable(range.startDate, range.endDate)) {
      const allowed = getAllowedSubmissionRange();
      res.status(409).json({
        success: false,
        code: 'SUBMISSION_PERIOD_LOCKED',
        error: allowed
          ? `Подать табель можно только за период ${formatTimesheetRangeLabel(allowed.startDate, allowed.endDate)} (последний завершённый расчётный период). Подача за выбранный период недоступна.`
          : 'Подача табеля за выбранный период недоступна.',
        allowed_start_date: allowed?.startDate ?? null,
        allowed_end_date: allowed?.endDate ?? null,
      });
      return;
    }

    const existing = await queryOne<TimesheetApproval>(
      `SELECT * FROM timesheet_approvals
         WHERE department_id = $1 AND start_date = $2 AND end_date = $3
         LIMIT 1`,
      [deptId, range.startDate, range.endDate],
    );

    const correctionCheck = await validateCorrectionAttachments(deptId, range);
    if (!correctionCheck.ok) {
      res.status(400).json({
        success: false,
        error: 'Есть несогласованные корректировки или незакрытые работы в выходные — подача невозможна',
        code: 'CORRECTION_VALIDATION_FAILED',
        missing_days: correctionCheck.missing,
      });
      return;
    }

    const memoCheck = await checkManagerObjWeekendMemoRequirement({
      submitterRoleCode: req.user.role_code,
      departmentId: deptId,
      startDate: range.startDate,
      endDate: range.endDate,
      approvalId: existing?.id ?? null,
    });
    if (memoCheck.required && !memoCheck.satisfied) {
      res.status(400).json({
        success: false,
        error: 'Подача с работой в выходные требует подписанной служебной записки. Сформируйте, подпишите и приложите файл перед подачей.',
        code: 'WEEKEND_MEMO_REQUIRED',
        weekend_work_dates: memoCheck.weekendWorkDates,
      });
      return;
    }

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
        approval = await queryOne<TimesheetApproval>(
          `UPDATE timesheet_approvals
             SET status = 'submitted',
                 submitted_by = $1,
                 submitted_at = $2,
                 reviewed_by = NULL,
                 reviewed_at = NULL,
                 review_comment = NULL,
                 updated_at = $3
             WHERE id = $4
             RETURNING *`,
          [req.user.id, now, now, existing.id],
        );
      } else {
        approval = await queryOne<TimesheetApproval>(
          `INSERT INTO timesheet_approvals
             (department_id, start_date, end_date, status, submitted_by, submitted_at,
              reviewed_by, reviewed_at, review_comment, updated_at)
             VALUES ($1, $2, $3, 'submitted', $4, $5, NULL, NULL, NULL, $6)
             RETURNING *`,
          [deptId, range.startDate, range.endDate, req.user.id, now, now],
        );
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

/**
 * Руководитель отзывает поданный табель назад в draft, пока HR его не рассмотрел.
 * Доступно только из статуса 'submitted' — после approve/reject это домен HR.
 */
const recall = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const requestedDeptId = typeof req.body.department_id === 'string' && req.body.department_id ? req.body.department_id : null;
    const deptId = await resolveScopedDepartmentId(req, requestedDeptId);
    const range = parseRangeFromBody(req.body);

    if (requestedDeptId && !deptId) {
      res.status(403).json({ success: false, error: 'Access denied to this department', code: 'DEPARTMENT_ACCESS_DENIED' });
      return;
    }
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

    const existing = await queryOne<TimesheetApproval>(
      `SELECT * FROM timesheet_approvals
         WHERE department_id = $1 AND start_date = $2 AND end_date = $3
         LIMIT 1`,
      [deptId, range.startDate, range.endDate],
    );

    if (!existing || existing.status !== 'submitted') {
      res.status(409).json({
        success: false,
        error: 'Отозвать можно только поданный, ещё не рассмотренный табель',
      });
      return;
    }

    const now = new Date().toISOString();
    const approval = await queryOne<TimesheetApproval>(
      `UPDATE timesheet_approvals
         SET status = 'draft',
             submitted_by = NULL,
             submitted_at = NULL,
             reviewed_by = NULL,
             reviewed_at = NULL,
             review_comment = NULL,
             updated_at = $1
         WHERE id = $2
         RETURNING *`,
      [now, existing.id],
    );

    if (!approval) {
      res.status(500).json({ success: false, error: 'Ошибка отзыва табеля' });
      return;
    }

    await logApprovalAudit(req, approval.id, 'TIMESHEET_APPROVAL_RECALLED', {
      department_id: deptId,
      start_date: range.startDate,
      end_date: range.endDate,
      from_status: existing.status,
      to_status: 'draft',
    });

    res.json({ success: true, data: approval });
  } catch (err) {
    console.error('timesheet-approval.recall error:', err);
    res.status(500).json({ success: false, error: 'Ошибка отзыва табеля' });
  }
};

/** Статус согласования по отделу и конкретному диапазону. */
const getStatus = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const requestedDepartmentId = typeof req.query.department_id === 'string' ? req.query.department_id : null;
    const department_id = await resolveScopedDepartmentId(req, requestedDepartmentId);
    const range = parseRangeFromQuery(req.query as Record<string, unknown>);

    // Раньше при недоступном отделе тихо возвращали data: null — клиент думал «согласования
    // нет», хотя на деле просто нет прав смотреть. Делаем явный 403, чтобы не маскировать.
    if (requestedDepartmentId && !department_id) {
      res.status(403).json({ success: false, error: 'Access denied to this department', code: 'DEPARTMENT_ACCESS_DENIED' });
      return;
    }
    if (!department_id || !range) {
      res.json({ success: true, data: null });
      return;
    }

    const data = await queryOne<TimesheetApproval>(
      `SELECT * FROM timesheet_approvals
         WHERE department_id = $1 AND start_date = $2 AND end_date = $3
         LIMIT 1`,
      [department_id, range.startDate, range.endDate],
    );
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
    const requestedDepartmentId = typeof req.query.department_id === 'string' ? req.query.department_id : null;
    const department_id = await resolveScopedDepartmentId(req, requestedDepartmentId);

    if (requestedDepartmentId && !department_id) {
      res.status(403).json({ success: false, error: 'Access denied to this department', code: 'DEPARTMENT_ACCESS_DENIED' });
      return;
    }
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

    const whereParts: string[] = ['department_id = $1'];
    const params: unknown[] = [department_id];
    if (rangeStart && rangeEnd) {
      params.push(rangeEnd);
      whereParts.push(`start_date <= $${params.length}`);
      params.push(rangeStart);
      whereParts.push(`end_date >= $${params.length}`);
    }
    const data = await query<TimesheetApproval>(
      `SELECT * FROM timesheet_approvals
         WHERE ${whereParts.join(' AND ')}
         ORDER BY start_date ASC`,
      params,
    );

    res.json({ success: true, data });
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
    const data = await queryOne<TimesheetApproval>(
      `UPDATE timesheet_approvals
         SET status = $1,
             reviewed_by = $2,
             reviewed_at = $3,
             review_comment = $4,
             updated_at = $5
         WHERE id = $6
         RETURNING *`,
      [input.nextStatus, req.user.id, now, comment, now, id],
    );

    if (!data) {
      throw new Error('Approval not found after update');
    }
    const updatedApproval = data;
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

/** HR утверждает табель. Блокируется, если в периоде остались pending корректировки. */
const approve = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const approval = await loadApprovalById(req.params.id);
    if (approval) {
      const employeeIds = await import('../services/timesheet-department-assignments.service.js').then(m =>
        m.listEmployeeIdsAssignedToDepartmentPeriod(approval.department_id, approval.start_date, approval.end_date),
      );
      let count = 0;
      if (employeeIds.length > 0) {
        const row = await queryOne<{ count: number | string }>(
          `SELECT COUNT(*)::int AS count FROM attendance_adjustments
             WHERE approval_status = 'pending'
               AND employee_id = ANY($1::int[])
               AND work_date >= $2
               AND work_date <= $3`,
          [employeeIds, approval.start_date, approval.end_date],
        );
        count = row ? Number(row.count) : 0;
      }
      if (count > 0) {
        res.status(409).json({
          success: false,
          error: 'Сначала согласуйте корректировки в выходные дни',
          code: 'PENDING_CORRECTIONS_EXIST',
          pending_count: count,
        });
        return;
      }
    }
  } catch (err) {
    console.error('timesheet-approval.approve precheck error:', err);
    res.status(500).json({ success: false, error: 'Ошибка проверки корректировок' });
    return;
  }

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
    const whereParts: string[] = [`status = 'submitted'`];
    const params: unknown[] = [];

    if (scope === 'department') {
      const managedDepartmentIds = await resolveManagedDepartmentIds(_req);
      if (managedDepartmentIds.length === 0) {
        res.json({ success: true, data: [] });
        return;
      }
      params.push(managedDepartmentIds);
      whereParts.push(`department_id = ANY($${params.length}::uuid[])`);
    } else if (scope === 'self') {
      res.json({ success: true, data: [] });
      return;
    }

    const data = await query<TimesheetApproval>(
      `SELECT * FROM timesheet_approvals
         WHERE ${whereParts.join(' AND ')}
         ORDER BY submitted_at DESC`,
      params,
    );
    res.json({ success: true, data });
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
    const whereParts: string[] = [];
    const params: unknown[] = [];

    if (status === 'rejected') {
      whereParts.push(`status IN ('rejected', 'returned')`);
    } else if (status) {
      params.push(status);
      whereParts.push(`status = $${params.length}`);
    }

    if (scope === 'department') {
      const managedDepartmentIds = await resolveManagedDepartmentIds(req);
      if (managedDepartmentIds.length === 0) {
        res.json({ success: true, data: [] });
        return;
      }
      params.push(managedDepartmentIds);
      whereParts.push(`department_id = ANY($${params.length}::uuid[])`);
    } else if (scope === 'self') {
      res.json({ success: true, data: [] });
      return;
    }

    const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';
    const data = await query<TimesheetApproval>(
      `SELECT * FROM timesheet_approvals
         ${whereSql}
         ORDER BY updated_at DESC`,
      params,
    );
    res.json({ success: true, data });
  } catch (err) {
    console.error('timesheet-approval.getByStatus error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения списка' });
  }
};

const getResponsibles = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const requestedDepartmentId = typeof req.query.department_id === 'string' ? req.query.department_id : null;
    const departmentId = await resolveScopedDepartmentId(req, requestedDepartmentId);

    if (requestedDepartmentId && !departmentId) {
      res.status(403).json({ success: false, error: 'Access denied to this department', code: 'DEPARTMENT_ACCESS_DENIED' });
      return;
    }
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

    if (requestedDepartmentId && !departmentId) {
      res.status(403).json({ success: false, error: 'Access denied to this department', code: 'DEPARTMENT_ACCESS_DENIED' });
      return;
    }
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

    if (requestedDepartmentId && !departmentId) {
      res.status(403).json({ success: false, error: 'Access denied to this department', code: 'DEPARTMENT_ACCESS_DENIED' });
      return;
    }
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

/** Руководитель: получить presigned URL для загрузки вложения к подаче табеля. */
const getAttachmentUploadUrl = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const requestedDeptId = typeof req.body.department_id === 'string' && req.body.department_id ? req.body.department_id : null;
    const deptId = await resolveScopedDepartmentId(req, requestedDeptId);
    const range = parseRangeFromBody(req.body);
    if (requestedDeptId && !deptId) {
      res.status(403).json({ success: false, error: 'Access denied to this department', code: 'DEPARTMENT_ACCESS_DENIED' });
      return;
    }
    if (!deptId) {
      res.status(400).json({ success: false, error: 'department_id обязателен' });
      return;
    }
    if (!range) {
      res.status(400).json({ success: false, error: 'start_date и end_date обязательны' });
      return;
    }

    const fileName = typeof req.body.file_name === 'string' ? req.body.file_name : null;
    const contentType = typeof req.body.content_type === 'string' ? req.body.content_type : null;
    if (!fileName || !contentType) {
      res.status(400).json({ success: false, error: 'file_name и content_type обязательны' });
      return;
    }

    if (!(await r2Service.isEnabledAsync())) {
      res.status(503).json({ success: false, error: 'Хранилище файлов не настроено' });
      return;
    }

    const draft = await findOrCreateDraftApproval({
      departmentId: deptId,
      startDate: range.startDate,
      endDate: range.endDate,
      userId: req.user.id,
    });
    if (draft.status !== 'draft' && draft.status !== 'rejected' && draft.status !== 'returned') {
      res.status(409).json({ success: false, error: 'Период уже на проверке или утверждён — загрузка недоступна' });
      return;
    }

    const ext = path.extname(fileName) || '.bin';
    const key = `documents/timesheet-approvals/${draft.id}/${randomUUID()}${ext}`;
    const { url, headers } = await r2Service.generateUploadUrl(key, contentType);

    res.json({
      success: true,
      data: {
        upload_url: url,
        upload_headers: headers,
        r2_key: key,
        approval_id: draft.id,
        category: APPROVAL_ATTACHMENT_CATEGORY,
      },
    });
  } catch (err) {
    console.error('timesheet-approval.getAttachmentUploadUrl error:', err);
    res.status(500).json({ success: false, error: 'Ошибка подготовки загрузки файла' });
  }
};

/** Руководитель: подтвердить загрузку после PUT в R2. */
const confirmAttachmentUpload = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const approvalId = Number(req.body.approval_id);
    const fileName = typeof req.body.file_name === 'string' ? req.body.file_name : null;
    const fileSize = Number(req.body.file_size);
    const mimeType = typeof req.body.mime_type === 'string' ? req.body.mime_type : null;
    const r2Key = typeof req.body.r2_key === 'string' ? req.body.r2_key : null;

    if (!approvalId || !fileName || !fileSize || !mimeType || !r2Key) {
      res.status(400).json({ success: false, error: 'Некорректные параметры загрузки' });
      return;
    }

    const approval = await loadApprovalById(String(approvalId));
    if (!approval) {
      res.status(404).json({ success: false, error: 'Подача табеля не найдена' });
      return;
    }
    if (!(await ensureApprovalDepartmentAccess(req, approval.department_id))) {
      res.status(403).json({ success: false, error: 'Нет доступа к отделу' });
      return;
    }
    if (approval.status !== 'draft' && approval.status !== 'rejected' && approval.status !== 'returned') {
      res.status(409).json({ success: false, error: 'Период уже на проверке или утверждён — загрузка недоступна' });
      return;
    }

    const created = await createAttachmentRecord({
      approvalId: approval.id,
      fileName,
      fileSize,
      mimeType,
      r2Key,
      uploadedBy: req.user.id,
    });

    await logApprovalAudit(req, approval.id, 'TIMESHEET_APPROVAL_ATTACHMENT_UPLOADED', {
      department_id: approval.department_id,
      start_date: approval.start_date,
      end_date: approval.end_date,
      document_id: created.document_id,
      file_name: created.file_name,
    });

    res.json({ success: true, data: created });
  } catch (err) {
    console.error('timesheet-approval.confirmAttachmentUpload error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения файла' });
  }
};

/** Руководитель / HR: список вложений подачи табеля. */
const listAttachments = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    let approvalId: number | null = null;
    const approvalIdRaw = req.query.approval_id;
    if (approvalIdRaw && typeof approvalIdRaw === 'string') {
      approvalId = Number(approvalIdRaw);
    } else {
      const deptIdRaw = typeof req.query.department_id === 'string' ? req.query.department_id : null;
      const deptId = await resolveScopedDepartmentId(req, deptIdRaw);
      const range = parseRangeFromQuery(req.query as Record<string, unknown>);
      if (deptIdRaw && !deptId) {
        res.status(403).json({ success: false, error: 'Access denied to this department', code: 'DEPARTMENT_ACCESS_DENIED' });
        return;
      }
      if (!deptId || !range) {
        res.status(400).json({ success: false, error: 'approval_id или department_id+start_date+end_date обязательны' });
        return;
      }
      const match = await queryOne<{ id: number | string; department_id: string }>(
        `SELECT id, department_id FROM timesheet_approvals
           WHERE department_id = $1 AND start_date = $2 AND end_date = $3
           LIMIT 1`,
        [deptId, range.startDate, range.endDate],
      );
      if (!match) {
        res.json({ success: true, data: [] });
        return;
      }
      approvalId = Number(match.id);
    }

    if (!approvalId) {
      res.json({ success: true, data: [] });
      return;
    }

    const approval = await loadApprovalById(String(approvalId));
    if (!approval) {
      res.json({ success: true, data: [] });
      return;
    }
    if (!(await ensureApprovalDepartmentAccess(req, approval.department_id))) {
      res.status(403).json({ success: false, error: 'Нет доступа к отделу' });
      return;
    }

    const data = await listApprovalAttachments(approvalId);
    res.json({ success: true, data });
  } catch (err) {
    console.error('timesheet-approval.listAttachments error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения вложений' });
  }
};

/** Руководитель: удалить вложение (только если подача в draft/rejected/returned). */
const deleteAttachment = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const documentId = Number(req.params.document_id);
    if (!Number.isFinite(documentId) || documentId <= 0) {
      res.status(400).json({ success: false, error: 'Некорректный id документа' });
      return;
    }

    const linkRow = await queryOne<{ entity_id: string }>(
      `SELECT entity_id FROM document_links
         WHERE document_id = $1
           AND entity_type = 'timesheet_approval'
           AND purpose = 'weekend_confirmation'
         LIMIT 1`,
      [documentId],
    );
    if (!linkRow) {
      res.status(404).json({ success: false, error: 'Вложение не найдено' });
      return;
    }

    const approvalId = Number(linkRow.entity_id);
    const approval = await loadApprovalById(String(approvalId));
    if (!approval) {
      res.status(404).json({ success: false, error: 'Подача не найдена' });
      return;
    }
    if (!(await ensureApprovalDepartmentAccess(req, approval.department_id))) {
      res.status(403).json({ success: false, error: 'Нет доступа к отделу' });
      return;
    }
    if (approval.status !== 'draft' && approval.status !== 'rejected' && approval.status !== 'returned') {
      res.status(409).json({ success: false, error: 'Период уже на проверке или утверждён — удаление недоступно' });
      return;
    }

    const result = await deleteAttachmentRecord(documentId);
    await logApprovalAudit(req, approval.id, 'TIMESHEET_APPROVAL_ATTACHMENT_DELETED', {
      department_id: approval.department_id,
      start_date: approval.start_date,
      end_date: approval.end_date,
      document_id: documentId,
      r2_key: result.r2Key,
    });

    res.json({ success: true });
  } catch (err) {
    console.error('timesheet-approval.deleteAttachment error:', err);
    res.status(500).json({ success: false, error: 'Ошибка удаления вложения' });
  }
};

/** HR / Admin: список подач с флагами проблемных дней и вложениями. */
const getReviewList = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const requestedStatus = typeof req.query.status === 'string' ? req.query.status : 'submitted';
    const status = requestedStatus as TimesheetApprovalStatus;
    if (!LISTABLE_STATUSES.has(status)) {
      res.status(400).json({ success: false, error: 'Некорректный статус табеля' });
      return;
    }

    const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
    const periodStart = typeof req.query.start_date === 'string' && ISO_DATE.test(req.query.start_date)
      ? req.query.start_date
      : null;
    const periodEnd = typeof req.query.end_date === 'string' && ISO_DATE.test(req.query.end_date)
      ? req.query.end_date
      : null;

    const scope = await resolveRequestDataScope(req);
    const whereParts: string[] = [];
    const params: unknown[] = [];

    if (status === 'rejected') {
      whereParts.push(`status IN ('rejected', 'returned')`);
    } else {
      params.push(status);
      whereParts.push(`status = $${params.length}`);
    }

    if (periodStart) {
      params.push(periodStart);
      whereParts.push(`end_date >= $${params.length}`);
    }
    if (periodEnd) {
      params.push(periodEnd);
      whereParts.push(`start_date <= $${params.length}`);
    }

    if (scope === 'department') {
      const managedDepartmentIds = await resolveManagedDepartmentIds(req);
      if (managedDepartmentIds.length === 0) {
        res.json({ success: true, data: [] });
        return;
      }
      params.push(managedDepartmentIds);
      whereParts.push(`department_id = ANY($${params.length}::uuid[])`);
    } else if (scope === 'self') {
      res.json({ success: true, data: [] });
      return;
    }

    const rows = await query<TimesheetApproval>(
      `SELECT * FROM timesheet_approvals
         WHERE ${whereParts.join(' AND ')}
         ORDER BY updated_at DESC`,
      params,
    );
    if (rows.length === 0) {
      res.json({ success: true, data: [] });
      return;
    }

    const deptIds = [...new Set(rows.map((r) => r.department_id))];
    const userIds = [...new Set(
      rows.flatMap((r) => [r.submitted_by, r.reviewed_by]).filter((id): id is string => Boolean(id)),
    )];

    const [deptRows, userRows] = await Promise.all([
      deptIds.length > 0
        ? query<{ id: string; name: string | null }>(
          `SELECT id, name FROM org_departments WHERE id = ANY($1::uuid[])`,
          [deptIds],
        )
        : Promise.resolve([] as Array<{ id: string; name: string | null }>),
      userIds.length > 0
        ? query<{ id: string; full_name: string | null }>(
          `SELECT id, full_name FROM user_profiles WHERE id = ANY($1::uuid[])`,
          [userIds],
        )
        : Promise.resolve([] as Array<{ id: string; full_name: string | null }>),
    ]);

    const deptNames = new Map(deptRows.map((row) => [String(row.id), String(row.name ?? '')]));
    const userNames = new Map(userRows.map((row) => [String(row.id), String(row.full_name ?? '')]));

    const enriched = await Promise.all(rows.map(async (row) => {
      const weekend = await checkWeekendWorkRequirement({
        departmentId: row.department_id,
        startDate: row.start_date,
        endDate: row.end_date,
      });

      const employeeIds = await import('../services/timesheet-department-assignments.service.js')
        .then((mod) => mod.listEmployeeIdsAssignedToDepartmentPeriod(row.department_id, row.start_date, row.end_date));

      let anyCorrection = false;
      let correctionExceedsSkud = false;
      let absentDays = false;
      let pendingWeekendDates: string[] = [];
      let approvedWeekendDates: string[] = [];
      let largeCorrectionDates: string[] = [];

      if (employeeIds.length > 0) {
        const adjustments = await query<{
          employee_id: number;
          work_date: string;
          status: string;
          hours_override: number | string | null;
          source_type: string;
          created_by: string | null;
          approval_status: string | null;
        }>(
          `SELECT employee_id, work_date, status, hours_override, source_type, created_by, approval_status
             FROM attendance_adjustments
             WHERE employee_id = ANY($1::int[])
               AND work_date >= $2
               AND work_date <= $3`,
          [employeeIds, row.start_date, row.end_date],
        );
        anyCorrection = adjustments.some((a) => String(a.source_type) === 'manual');
        absentDays = adjustments.some((a) => String(a.status) === 'absent');

        if (weekend.weekendWorkDates.length > 0) {
          const weekendSet = new Set(weekend.weekendWorkDates);
          pendingWeekendDates = [...new Set(
            adjustments
              .filter((a) => String(a.approval_status ?? '') === 'pending' && weekendSet.has(String(a.work_date)))
              .map((a) => String(a.work_date)),
          )].sort();
          approvedWeekendDates = [...new Set(
            adjustments
              .filter((a) => String(a.approval_status ?? '') === 'approved' && weekendSet.has(String(a.work_date)))
              .map((a) => String(a.work_date)),
          )].sort();
        }

        if (anyCorrection) {
          const workAdjustments = adjustments.filter((a) => String(a.source_type) === 'manual' && a.hours_override != null);
          if (workAdjustments.length > 0) {
            const dates = [...new Set(workAdjustments.map((a) => String(a.work_date)))];
            const skudRows = await query<{ employee_id: number; date: string; total_minutes: number | string | null }>(
              `SELECT employee_id, date, total_minutes
                 FROM skud_daily_summary
                 WHERE employee_id = ANY($1::int[])
                   AND date = ANY($2::date[])`,
              [employeeIds, dates],
            );
            const skudMap = new Map<string, number>();
            for (const s of skudRows) {
              skudMap.set(`${Number(s.employee_id)}_${String(s.date)}`, Number(s.total_minutes ?? 0));
            }
            const largeDates = new Set<string>();
            for (const adj of workAdjustments) {
              const skudMinutes = skudMap.get(`${Number(adj.employee_id)}_${String(adj.work_date)}`) ?? 0;
              const adjHours = Number(adj.hours_override ?? 0);
              if (adjHours * 60 > skudMinutes + 1) {
                correctionExceedsSkud = true;
                largeDates.add(String(adj.work_date));
              }
            }
            largeCorrectionDates = [...largeDates].sort();
          }
        }
      }

      return {
        ...row,
        department_name: deptNames.get(row.department_id) ?? null,
        submitted_by_name: row.submitted_by ? userNames.get(row.submitted_by) ?? null : null,
        reviewed_by_name: row.reviewed_by ? userNames.get(row.reviewed_by) ?? null : null,
        weekend_work_dates: weekend.weekendWorkDates,
        pending_weekend_dates: pendingWeekendDates,
        approved_weekend_dates: approvedWeekendDates,
        large_correction_dates: largeCorrectionDates,
        problem_flags: {
          any_correction: anyCorrection,
          correction_exceeds_skud: correctionExceedsSkud,
          absent_days: absentDays,
        },
      };
    }));

    res.json({ success: true, data: enriched });
  } catch (err) {
    console.error('timesheet-approval.getReviewList error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения списка согласований' });
  }
};

export const timesheetApprovalController = {
  submit,
  recall,
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
  getAttachmentUploadUrl,
  confirmAttachmentUpload,
  listAttachments,
  deleteAttachment,
  getReviewList,
};
