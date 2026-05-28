import type { Response } from 'express';
import { query, queryOne, withTransaction } from '../config/postgres.js';
import type {
  AuthenticatedRequest,
  TimesheetApproval,
  TimesheetApprovalEventAction,
  TimesheetApprovalStatus,
} from '../types/index.js';
import {
  resolveAccessibleDepartmentIds,
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
import { emitDomainChange } from '../services/realtime-broadcast.service.js';
import { IS_PRODUCTION } from '../config/features.js';

async function emitTimesheetApprovalChanged(params: {
  approvalId: string | number;
  departmentId?: string | null;
  submittedBy?: string | null;
  reviewerUserId?: string | null;
  action: string;
}): Promise<void> {
  try {
    const recipients = new Set<string>();
    if (params.submittedBy) recipients.add(params.submittedBy);
    if (params.reviewerUserId) recipients.add(params.reviewerUserId);
    if (params.departmentId) {
      const reviewers = await listTimesheetWorkflowRecipientIds(params.departmentId, ['review', 'monitor']);
      for (const uid of reviewers) recipients.add(uid);
    }
    if (recipients.size === 0) return;
    emitDomainChange({
      event: 'timesheet_approval:changed',
      targetUserIds: Array.from(recipients),
      payload: { entityId: params.approvalId, action: params.action },
    });
  } catch (e) {
    console.error('[timesheet-approval] emit realtime error:', e);
  }
}
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
  createAttachmentRecord,
  deleteAttachmentRecord,
  findOrCreateDraftApproval,
  listApprovalAttachments,
} from '../services/timesheet-approval-attachments.service.js';
import { r2Service } from '../services/r2.service.js';
import {
  listApprovalEmployees,
  snapshotApprovalEmployees,
} from '../services/timesheet-approval-employees-snapshot.service.js';
import {
  listDirectReportDepartmentIds,
  listDirectSubordinates,
} from '../services/employee-direct-reports.service.js';
import { sanitizeFileName } from '../utils/file-validation.utils.js';
import path from 'path';
import { randomUUID } from 'crypto';

interface MulterRequest extends AuthenticatedRequest {
  file?: Express.Multer.File;
}

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

async function loadEmployeeFullName(employeeId: number): Promise<string | null> {
  const row = await queryOne<{ full_name: string | null }>(
    `SELECT full_name FROM employees WHERE id = $1 LIMIT 1`,
    [employeeId],
  );
  return row?.full_name ?? null;
}

async function loadApprovalById(id: string): Promise<TimesheetApproval | null> {
  return queryOne<TimesheetApproval>(
    `SELECT * FROM timesheet_approvals WHERE id = $1 LIMIT 1`,
    [id],
  );
}

/**
 * HR-доступ к согласованию: для подачи отдела — обычная проверка по scope;
 * для персональной подачи (department_id NULL) — пускаем самого автора (manager)
 * и всех, у кого scope='all' (admin/HR с data.scope.all).
 */
async function ensureApprovalAccess(
  req: AuthenticatedRequest,
  approval: Pick<TimesheetApproval, 'department_id' | 'manager_employee_id'>,
): Promise<boolean> {
  if (approval.department_id) {
    const scopedDepartmentId = await resolveScopedDepartmentId(req, approval.department_id);
    return !!scopedDepartmentId && scopedDepartmentId === approval.department_id;
  }
  if (approval.manager_employee_id != null) {
    if (req.user.employee_id && req.user.employee_id === approval.manager_employee_id) {
      return true;
    }
    const scope = await resolveRequestDataScope(req);
    return scope === 'all';
  }
  return false;
}

/**
 * Доступ к подаче/вложениям табеля отдела. В отличие от строгого
 * ensureApprovalAccess (HR-эндпоинты), даёт доступ ещё и руководителю
 * «по людям»: если у пользователя есть активный прямой подчинённый
 * (employee_direct_reports) в этом отделе — он управляет его табелем, даже без
 * employee_department_access. Использовать ТОЛЬКО для /timesheet-эндпоинтов.
 */
async function resolveTimesheetActionDepartmentId(
  req: AuthenticatedRequest,
  requestedDepartmentId: string | null,
): Promise<string | null> {
  const scoped = await resolveScopedDepartmentId(req, requestedDepartmentId);
  if (scoped) return scoped;
  if (requestedDepartmentId && req.user.employee_id) {
    const drDepartmentIds = await listDirectReportDepartmentIds(req.user.employee_id);
    if (drDepartmentIds.includes(requestedDepartmentId)) return requestedDepartmentId;
  }
  return null;
}

async function ensureTimesheetActionDepartmentAccess(
  req: AuthenticatedRequest,
  departmentId: string,
): Promise<boolean> {
  const resolved = await resolveTimesheetActionDepartmentId(req, departmentId);
  return resolved === departmentId;
}

/**
 * Контекст персональной подачи для руководителя «по людям» (direct-reports-only).
 * Возвращает список активных подчинённых, объединение их отделов
 * (для адресации HR-уведомлений). Возвращает null, если у пользователя
 * нет employee_id или нет ни одного активного подчинённого с org_department_id.
 */
async function resolvePersonalSubmissionContext(req: AuthenticatedRequest): Promise<{
  managerEmployeeId: number;
  employeeIds: number[];
  affectedDepartmentIds: string[];
} | null> {
  if (!req.user.employee_id) return null;
  const managerEmployeeId = req.user.employee_id;
  const subordinateIds = await listDirectSubordinates(managerEmployeeId);
  if (subordinateIds.length === 0) return null;

  const rows = await query<{ id: number; org_department_id: string | null }>(
    `SELECT id, org_department_id
       FROM employees
      WHERE id = ANY($1::int[])
        AND (is_archived IS NULL OR is_archived = false)
        AND (employment_status IS NULL OR employment_status = 'active')`,
    [subordinateIds],
  );

  const employeeIds = rows.map(r => Number(r.id)).filter(id => Number.isInteger(id) && id > 0);
  if (employeeIds.length === 0) return null;

  const affectedDepartmentIds = [...new Set(
    rows
      .map(r => r.org_department_id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  )];

  return { managerEmployeeId, employeeIds, affectedDepartmentIds };
}

/**
 * Гарантирует, что у руководителя «по людям» за указанный диапазон есть persona-подача,
 * включающая его самого. Используется после успешной полной подачи отдела:
 * если руководитель сидит вне подаваемой бригады, его собственный табель иначе
 * не попадёт ни в одну подачу. Идемпотентно — повторные вызовы для того же диапазона
 * не создают дублей, partial EXCLUDE на manager_employee_id это поддерживает.
 *
 * Возвращает:
 *  - null, если подача не нужна (нет employee_id, нет direct reports, руководитель
 *    уже включён в snapshot какой-то существующей department-подачи за этот период,
 *    либо persona-подача уже в submitted/approved).
 *  - { approval, transitioned: true } — если подача создана или переведена в submitted
 *    (нужно отправить notify HR + событие в историю).
 */
async function ensureManagerSelfApprovalForRange(
  req: AuthenticatedRequest,
  range: ITimesheetDateRange,
): Promise<{ approval: TimesheetApproval; transitioned: boolean } | null> {
  const managerEmpId = req.user.employee_id;
  if (!managerEmpId) return null;

  const subordinates = await listDirectSubordinates(managerEmpId);
  if (subordinates.length === 0) return null;

  // Если руководитель уже сидит в snapshot какой-то submitted/approved/returned
  // department-подачи за этот период (т.е. он реально в этой бригаде) — отдельная
  // persona-подача не нужна, табель и так согласуется.
  const selfInDeptSnapshot = await queryOne<{ approval_id: number }>(
    `SELECT a.id AS approval_id
       FROM timesheet_approvals a
       JOIN timesheet_approval_employees s ON s.approval_id = a.id AND s.employee_id = $1
       WHERE a.start_date = $2 AND a.end_date = $3
         AND a.manager_employee_id IS NULL
         AND a.status IN ('submitted','approved','returned')
       LIMIT 1`,
    [managerEmpId, range.startDate, range.endDate],
  );
  if (selfInDeptSnapshot) return null;

  const now = new Date().toISOString();

  const existing = await queryOne<TimesheetApproval>(
    `SELECT * FROM timesheet_approvals
       WHERE manager_employee_id = $1 AND start_date = $2 AND end_date = $3
       LIMIT 1`,
    [managerEmpId, range.startDate, range.endDate],
  );

  if (existing) {
    // Если уже submitted/approved — подача актуальна, не трогаем. Гарантируем только,
    // что сам руководитель есть в snapshot (idempotent upsert на одной строке).
    if (existing.status === 'submitted' || existing.status === 'approved') {
      await withTransaction(async client => {
        await client.query(
          `INSERT INTO timesheet_approval_employees (approval_id, employee_id, full_name)
           SELECT $1, e.id, e.full_name FROM employees e WHERE e.id = $2
           ON CONFLICT (approval_id, employee_id) DO UPDATE SET full_name = EXCLUDED.full_name`,
          [existing.id, managerEmpId],
        );
      });
      return null;
    }
    // draft / returned / rejected → переводим в submitted и добавляем себя в snapshot.
    const updated = await withTransaction(async client => {
      const r = await client.query<TimesheetApproval>(
        `UPDATE timesheet_approvals
           SET status = 'submitted', submitted_by = $1, submitted_at = $2,
               reviewed_by = NULL, reviewed_at = NULL, review_comment = NULL,
               updated_at = $3
           WHERE id = $4
           RETURNING *`,
        [req.user.id, now, now, existing.id],
      );
      await client.query(
        `INSERT INTO timesheet_approval_employees (approval_id, employee_id, full_name)
         SELECT $1, e.id, e.full_name FROM employees e WHERE e.id = $2
         ON CONFLICT (approval_id, employee_id) DO UPDATE SET full_name = EXCLUDED.full_name`,
        [existing.id, managerEmpId],
      );
      return r.rows[0] ?? null;
    });
    return updated ? { approval: updated, transitioned: true } : null;
  }

  try {
    const created = await withTransaction(async client => {
      const r = await client.query<TimesheetApproval>(
        `INSERT INTO timesheet_approvals
           (department_id, manager_employee_id, start_date, end_date, status,
            submitted_by, submitted_at, reviewed_by, reviewed_at, review_comment, updated_at)
         VALUES (NULL, $1, $2, $3, 'submitted', $4, $5, NULL, NULL, NULL, $6)
         RETURNING *`,
        [managerEmpId, range.startDate, range.endDate, req.user.id, now, now],
      );
      const row = r.rows[0] ?? null;
      if (row) await snapshotApprovalEmployees(client, row.id, [managerEmpId]);
      return row;
    });
    return created ? { approval: created, transitioned: true } : null;
  } catch (err) {
    // Гонка двух submit'ов в один и тот же момент — partial EXCLUDE отшил один.
    // Тихо: другая попытка уже создала подачу.
    const code = (err as { code?: string } | null)?.code;
    if (code === '23P01') return null;
    throw err;
  }
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

async function notifyHrAboutSubmittedApproval(input: {
  departmentId: string | null;
  managerEmployeeId: number | null;
  affectedDepartmentIds: string[];
  employeeCount: number;
  range: ITimesheetDateRange;
}): Promise<void> {
  const { departmentId, managerEmployeeId, affectedDepartmentIds, employeeCount, range } = input;

  // Адресация: для полной подачи — получатели отдела; для персональной — объединение
  // получателей всех отделов, в которых сидят подчинённые руководителя.
  const recipientLists = await Promise.all(
    (departmentId ? [departmentId] : affectedDepartmentIds).map(dept =>
      listTimesheetWorkflowRecipientIds(dept, ['review', 'monitor']),
    ),
  );
  const recipients = [...new Set(recipientLists.flat())];
  if (recipients.length === 0) return;

  const rangeLabel = formatTimesheetRangeLabel(range.startDate, range.endDate);
  const title = 'Табель отправлен на проверку';
  let body: string;
  let path: string;
  let tag: string;

  if (managerEmployeeId != null) {
    const managerName = (await loadEmployeeFullName(managerEmployeeId)) ?? 'руководитель';
    body = `Персональная подача (${managerName}): табель за ${rangeLabel} — ${employeeCount} сотр. на проверке HR.`;
    path = buildRangeRedirectPath('/timesheet-hr', range);
    tag = `timesheet-submitted:personal:m${managerEmployeeId}:${range.startDate}:${range.endDate}`;
  } else if (departmentId) {
    const departmentName = await loadDepartmentName(departmentId);
    body = `Отдел ${departmentName}: табель за ${rangeLabel} отправлен на проверку HR.`;
    path = buildRangeRedirectPath('/timesheet-hr', range);
    tag = `timesheet-submitted:${departmentId}:${range.startDate}:${range.endDate}`;
  } else {
    return;
  }

  await notificationService.createMany(recipients.map(userId => ({
    userId,
    type: 'timesheet_approval_submitted',
    title,
    body,
    metadata: {
      departmentId,
      managerEmployeeId,
      start_date: range.startDate,
      end_date: range.endDate,
      path,
    },
  })));
  // Контентный tag: SW схлопывает push с одинаковым tag в одно уведомление —
  // страховка от случайного дубля; разные подачи друг друга не перетирают.
  await pushService.sendGenericNotification(
    recipients,
    title,
    body,
    {
      path,
      start_date: range.startDate,
      end_date: range.endDate,
      tag,
    },
  );
}

async function notifyDepartmentAboutReview(input: {
  departmentId: string | null;
  managerEmployeeId: number | null;
  affectedDepartmentIds: string[];
  range: ITimesheetDateRange;
  status: ReviewStatus;
  submittedBy: string | null;
  comment: string | null;
}): Promise<void> {
  const { departmentId, managerEmployeeId, affectedDepartmentIds, range, status, submittedBy, comment } = input;

  const recipients = new Set<string>();
  const submitRecipientLists = await Promise.all(
    (departmentId ? [departmentId] : affectedDepartmentIds).map(dept =>
      listTimesheetWorkflowRecipientIds(dept, ['submit']),
    ),
  );
  for (const list of submitRecipientLists) {
    for (const userId of list) recipients.add(userId);
  }
  if (submittedBy) recipients.add(submittedBy);

  if (recipients.size === 0) return;

  const rangeLabel = formatTimesheetRangeLabel(range.startDate, range.endDate);
  const commentSuffix = comment ? ` Комментарий: ${comment}` : '';
  const path = departmentId
    ? buildRangeRedirectPath('/timesheet', range, departmentId)
    : buildRangeRedirectPath('/timesheet', range);

  const subjectName = managerEmployeeId != null
    ? `Персональная подача (${(await loadEmployeeFullName(managerEmployeeId)) ?? 'руководитель'})`
    : departmentId
      ? `Отдел ${await loadDepartmentName(departmentId)}`
      : 'Табель';

  let title = 'Статус табеля изменён';
  let body = `${subjectName}: статус табеля за ${rangeLabel} изменён.${commentSuffix}`;
  let type = 'timesheet_approval_reviewed';

  if (status === 'approved') {
    title = 'Табель утверждён';
    body = `${subjectName}: табель за ${rangeLabel} утверждён.${commentSuffix}`;
    type = 'timesheet_approval_approved';
  }

  if (status === 'rejected') {
    title = 'Табель отклонён';
    body = `${subjectName}: табель за ${rangeLabel} отклонён, нужна переподача.${commentSuffix}`;
    type = 'timesheet_approval_rejected';
  }

  if (status === 'returned') {
    title = 'Табель возвращён на доработку';
    body = `${subjectName}: утверждённый табель за ${rangeLabel} возвращён на доработку.${commentSuffix}`;
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
      managerEmployeeId,
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
  departmentId: string | null;
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

/**
 * Руководитель подаёт табель за произвольный диапазон.
 * Два режима:
 *  - personal=true  → персональная подача руководителя «по людям»
 *                     (department_id=NULL, manager_employee_id=user.employee_id,
 *                      snapshot = его активные direct reports).
 *  - personal=false → полная подача отдела (как раньше).
 */
const submit = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const personal = req.body?.personal === true;
    const range = parseRangeFromBody(req.body);

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

    let deptId: string | null = null;
    let managerEmployeeId: number | null = null;
    let employeeIds: number[] = [];
    let affectedDepartmentIds: string[] = [];

    if (personal) {
      const ctx = await resolvePersonalSubmissionContext(req);
      if (!ctx) {
        res.status(403).json({
          success: false,
          error: 'Нет активных подчинённых для персональной подачи табеля',
          code: 'NO_DIRECT_REPORTS',
        });
        return;
      }
      managerEmployeeId = ctx.managerEmployeeId;
      employeeIds = ctx.employeeIds;
      affectedDepartmentIds = ctx.affectedDepartmentIds;
    } else {
      const requestedDeptId = typeof req.body.department_id === 'string' && req.body.department_id
        ? req.body.department_id
        : null;
      const resolvedDeptId = await resolveTimesheetActionDepartmentId(req, requestedDeptId);
      if (requestedDeptId && !resolvedDeptId) {
        res.status(403).json({ success: false, error: 'Access denied to this department', code: 'DEPARTMENT_ACCESS_DENIED' });
        return;
      }
      if (!resolvedDeptId) {
        res.status(400).json({ success: false, error: 'department_id обязателен' });
        return;
      }
      deptId = resolvedDeptId;
    }

    const existing = personal
      ? await queryOne<TimesheetApproval>(
          `SELECT * FROM timesheet_approvals
             WHERE manager_employee_id = $1 AND start_date = $2 AND end_date = $3
             LIMIT 1`,
          [managerEmployeeId, range.startDate, range.endDate],
        )
      : await queryOne<TimesheetApproval>(
          `SELECT * FROM timesheet_approvals
             WHERE department_id = $1 AND start_date = $2 AND end_date = $3
               AND manager_employee_id IS NULL
             LIMIT 1`,
          [deptId, range.startDate, range.endDate],
        );

    const correctionScope = personal
      ? { kind: 'personal' as const, employeeIds }
      : { kind: 'department' as const, departmentId: deptId! };
    const correctionCheck = await validateCorrectionAttachments(correctionScope, range);
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
      employeeIds: personal ? employeeIds : undefined,
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
      approval = await withTransaction(async client => {
        let row: TimesheetApproval | null;
        if (existing) {
          const result = await client.query<TimesheetApproval>(
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
          row = result.rows[0] ?? null;
        } else {
          const result = await client.query<TimesheetApproval>(
            `INSERT INTO timesheet_approvals
               (department_id, manager_employee_id, start_date, end_date, status,
                submitted_by, submitted_at, reviewed_by, reviewed_at, review_comment, updated_at)
               VALUES ($1, $2, $3, $4, 'submitted', $5, $6, NULL, NULL, NULL, $7)
               RETURNING *`,
            [deptId, managerEmployeeId, range.startDate, range.endDate, req.user.id, now, now],
          );
          row = result.rows[0] ?? null;
        }
        if (row) {
          const snapshotIds = personal
            ? employeeIds
            : await import('../services/timesheet-department-assignments.service.js').then(m =>
                m.listEmployeeIdsAssignedToDepartmentPeriod(deptId!, range.startDate, range.endDate),
              );
          await snapshotApprovalEmployees(client, row.id, snapshotIds);
        }
        return row;
      });
    } catch (dbErr) {
      const code = (dbErr as { code?: string } | null)?.code;
      if (code === '23P01') {
        res.status(409).json({
          success: false,
          error: personal
            ? 'У вас уже есть персональная подача за этот период.'
            : 'Выбранный диапазон пересекается с уже поданным или утверждённым табелем этого отдела.',
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
      manager_employee_id: managerEmployeeId,
      start_date: range.startDate,
      end_date: range.endDate,
      from_status: existing?.status ?? null,
      to_status: 'submitted',
    });

    const employeeCount = personal
      ? employeeIds.length
      : (await listApprovalEmployees(approval.id)).length;
    void notifyHrAboutSubmittedApproval({
      departmentId: deptId,
      managerEmployeeId,
      affectedDepartmentIds,
      employeeCount,
      range,
    }).catch(notifyError => {
      console.error('timesheet-approval.submit notify error:', notifyError);
    });

    void emitTimesheetApprovalChanged({
      approvalId: approval.id,
      departmentId: deptId,
      submittedBy: req.user.id,
      action: 'submit',
    });

    // Если это была полная подача отдела, а сам submitter сидит вне этой бригады —
    // его собственный табель иначе нигде не согласуется. Гарантируем persona-подачу
    // самого руководителя, чтобы он не «терялся» в UI согласований.
    if (!personal) {
      try {
        const selfResult = await ensureManagerSelfApprovalForRange(req, range);
        if (selfResult?.transitioned && req.user.employee_id) {
          const selfDeptRow = await queryOne<{ org_department_id: string | null }>(
            `SELECT org_department_id FROM employees WHERE id = $1 LIMIT 1`,
            [req.user.employee_id],
          );
          const selfAffectedDepartmentIds = selfDeptRow?.org_department_id
            ? [selfDeptRow.org_department_id]
            : [];
          await persistApprovalTransition({
            approvalId: selfResult.approval.id,
            departmentId: null,
            range,
            fromStatus: null,
            toStatus: 'submitted',
            action: 'submitted',
            actorUserId: req.user.id,
          });
          await logApprovalAudit(req, selfResult.approval.id, 'TIMESHEET_APPROVAL_SUBMITTED', {
            department_id: null,
            manager_employee_id: req.user.employee_id,
            start_date: range.startDate,
            end_date: range.endDate,
            from_status: null,
            to_status: 'submitted',
            auto_self_personal: true,
          });
          void notifyHrAboutSubmittedApproval({
            departmentId: null,
            managerEmployeeId: req.user.employee_id,
            affectedDepartmentIds: selfAffectedDepartmentIds,
            employeeCount: 1,
            range,
          }).catch(notifyError => {
            console.error('timesheet-approval.submit self-personal notify error:', notifyError);
          });
        }
      } catch (selfErr) {
        // Не валим основную подачу: persona-self — best-effort.
        console.error('timesheet-approval.submit ensureManagerSelfApproval error:', selfErr);
      }
    }

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
    const personal = req.body?.personal === true;
    const range = parseRangeFromBody(req.body);

    if (!range) {
      res.status(400).json({
        success: false,
        error: 'start_date и end_date обязательны (формат YYYY-MM-DD, end_date >= start_date)',
      });
      return;
    }

    let deptId: string | null = null;
    let managerEmployeeId: number | null = null;

    if (personal) {
      if (!req.user.employee_id) {
        res.status(403).json({ success: false, error: 'Нет привязки к сотруднику', code: 'NO_DIRECT_REPORTS' });
        return;
      }
      managerEmployeeId = req.user.employee_id;
    } else {
      const requestedDeptId = typeof req.body.department_id === 'string' && req.body.department_id
        ? req.body.department_id
        : null;
      const resolvedDeptId = await resolveTimesheetActionDepartmentId(req, requestedDeptId);
      if (requestedDeptId && !resolvedDeptId) {
        res.status(403).json({ success: false, error: 'Access denied to this department', code: 'DEPARTMENT_ACCESS_DENIED' });
        return;
      }
      if (!resolvedDeptId) {
        res.status(400).json({ success: false, error: 'department_id обязателен' });
        return;
      }
      deptId = resolvedDeptId;
    }

    const existing = personal
      ? await queryOne<TimesheetApproval>(
          `SELECT * FROM timesheet_approvals
             WHERE manager_employee_id = $1 AND start_date = $2 AND end_date = $3
             LIMIT 1`,
          [managerEmployeeId, range.startDate, range.endDate],
        )
      : await queryOne<TimesheetApproval>(
          `SELECT * FROM timesheet_approvals
             WHERE department_id = $1 AND start_date = $2 AND end_date = $3
               AND manager_employee_id IS NULL
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
      manager_employee_id: managerEmployeeId,
      start_date: range.startDate,
      end_date: range.endDate,
      from_status: existing.status,
      to_status: 'draft',
    });

    void emitTimesheetApprovalChanged({
      approvalId: approval.id,
      departmentId: deptId,
      submittedBy: existing.submitted_by ?? req.user.id,
      reviewerUserId: req.user.id,
      action: 'recall',
    });

    res.json({ success: true, data: approval });
  } catch (err) {
    console.error('timesheet-approval.recall error:', err);
    res.status(500).json({ success: false, error: 'Ошибка отзыва табеля' });
  }
};

/**
 * Статус согласования по отделу+диапазону (personal=false) или по персональной
 * подаче текущего пользователя+диапазону (personal=true).
 */
const getStatus = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const personal = req.query.personal === 'true' || req.query.personal === '1';
    const range = parseRangeFromQuery(req.query as Record<string, unknown>);
    if (!range) {
      res.json({ success: true, data: null });
      return;
    }

    if (personal) {
      if (!req.user.employee_id) {
        res.json({ success: true, data: null });
        return;
      }
      const data = await queryOne<TimesheetApproval>(
        `SELECT * FROM timesheet_approvals
           WHERE manager_employee_id = $1 AND start_date = $2 AND end_date = $3
           LIMIT 1`,
        [req.user.employee_id, range.startDate, range.endDate],
      );
      res.json({ success: true, data });
      return;
    }

    const requestedDepartmentId = typeof req.query.department_id === 'string' ? req.query.department_id : null;
    const department_id = await resolveTimesheetActionDepartmentId(req, requestedDepartmentId);

    // Раньше при недоступном отделе тихо возвращали data: null — клиент думал «согласования
    // нет», хотя на деле просто нет прав смотреть. Делаем явный 403, чтобы не маскировать.
    if (requestedDepartmentId && !department_id) {
      res.status(403).json({ success: false, error: 'Access denied to this department', code: 'DEPARTMENT_ACCESS_DENIED' });
      return;
    }
    if (!department_id) {
      res.json({ success: true, data: null });
      return;
    }

    const data = await queryOne<TimesheetApproval>(
      `SELECT * FROM timesheet_approvals
         WHERE department_id = $1 AND start_date = $2 AND end_date = $3
           AND manager_employee_id IS NULL
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
 * Список согласований, пересекающихся с указанным диапазоном (или с месяцем).
 * scope:
 *  - 'department' (по умолчанию) — полные подачи отдела (manager_employee_id IS NULL);
 *  - 'personal'                 — персональные подачи текущего пользователя;
 *  - 'all'                      — оба (для совмещённых ролей).
 */
const listDepartmentApprovals = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const scopeParam = typeof req.query.scope === 'string' ? req.query.scope : 'department';
    const scope = (scopeParam === 'personal' || scopeParam === 'all') ? scopeParam : 'department';

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

    const whereParts: string[] = [];
    const params: unknown[] = [];

    if (scope === 'department' || scope === 'all') {
      const requestedDepartmentId = typeof req.query.department_id === 'string' ? req.query.department_id : null;
      const department_id = await resolveTimesheetActionDepartmentId(req, requestedDepartmentId);
      if (requestedDepartmentId && !department_id) {
        res.status(403).json({ success: false, error: 'Access denied to this department', code: 'DEPARTMENT_ACCESS_DENIED' });
        return;
      }
      if (scope === 'department') {
        if (!department_id) {
          res.status(400).json({ success: false, error: 'department_id обязателен' });
          return;
        }
        params.push(department_id);
        whereParts.push(`(department_id = $${params.length} AND manager_employee_id IS NULL)`);
      } else {
        // 'all': объединение полной подачи отдела (если указан) и персональных подач юзера.
        const orParts: string[] = [];
        if (department_id) {
          params.push(department_id);
          orParts.push(`(department_id = $${params.length} AND manager_employee_id IS NULL)`);
        }
        if (req.user.employee_id) {
          params.push(req.user.employee_id);
          orParts.push(`manager_employee_id = $${params.length}`);
        }
        if (orParts.length === 0) {
          res.json({ success: true, data: [] });
          return;
        }
        whereParts.push(`(${orParts.join(' OR ')})`);
      }
    } else {
      // 'personal'
      if (!req.user.employee_id) {
        res.json({ success: true, data: [] });
        return;
      }
      params.push(req.user.employee_id);
      whereParts.push(`manager_employee_id = $${params.length}`);
    }

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

    if (!(await ensureApprovalAccess(req, approval))) {
      res.status(403).json({ success: false, error: 'Нет доступа к этому табелю' });
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
      manager_employee_id: updatedApproval.manager_employee_id,
      start_date: range.startDate,
      end_date: range.endDate,
      from_status: approval.status,
      to_status: input.nextStatus,
      comment,
    });

    let affectedDepartmentIds: string[] = [];
    if (approval.manager_employee_id != null) {
      const drDepts = await listDirectReportDepartmentIds(approval.manager_employee_id);
      affectedDepartmentIds = drDepts;
    }

    void notifyDepartmentAboutReview({
      departmentId: approval.department_id,
      managerEmployeeId: approval.manager_employee_id,
      affectedDepartmentIds,
      range,
      status: input.nextStatus,
      submittedBy: approval.submitted_by,
      comment,
    }).catch(notifyError => {
      console.error(`timesheet-approval.${input.action} notify error:`, notifyError);
    });

    void emitTimesheetApprovalChanged({
      approvalId: updatedApproval.id,
      departmentId: approval.department_id,
      submittedBy: approval.submitted_by,
      reviewerUserId: req.user.id,
      action: input.action,
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
      // Для персональной подачи берём состав из снимка — иначе подцепим чужих сотрудников отдела.
      let employeeIds: number[];
      if (approval.manager_employee_id != null) {
        const snap = await listApprovalEmployees(approval.id);
        employeeIds = snap.map(s => s.employee_id);
      } else if (approval.department_id) {
        employeeIds = await import('../services/timesheet-department-assignments.service.js').then(m =>
          m.listEmployeeIdsAssignedToDepartmentPeriod(approval.department_id!, approval.start_date, approval.end_date),
        );
      } else {
        employeeIds = [];
      }
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

    if (!(await ensureApprovalAccess(req, approval))) {
      res.status(403).json({ success: false, error: 'Нет доступа к этому табелю' });
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
      whereParts.push(`(department_id = ANY($${params.length}::uuid[]) AND manager_employee_id IS NULL)`);
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
      whereParts.push(`(department_id = ANY($${params.length}::uuid[]) AND manager_employee_id IS NULL)`);
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

/**
 * Руководитель: загрузить вложение к подаче табеля. Multipart через бэкенд
 * (как POST /api/documents/upload для Заявлений) — файл идёт в R2 серверно,
 * без браузерного PUT и CORS-проблем.
 */
const uploadAttachment = async (req: MulterRequest, res: Response): Promise<void> => {
  try {
    if (!(await r2Service.isEnabledAsync())) {
      res.status(503).json({ success: false, error: 'Хранилище файлов не настроено' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ success: false, error: 'Файл обязателен' });
      return;
    }

    const personal = req.body?.personal === true || req.body?.personal === 'true';
    const range = parseRangeFromBody(req.body);

    if (!range) {
      res.status(400).json({ success: false, error: 'start_date и end_date обязательны' });
      return;
    }

    let deptId: string | null = null;
    let managerEmployeeId: number | null = null;
    if (personal) {
      if (!req.user.employee_id) {
        res.status(403).json({ success: false, error: 'Нет привязки к сотруднику', code: 'NO_DIRECT_REPORTS' });
        return;
      }
      managerEmployeeId = req.user.employee_id;
    } else {
      const requestedDeptId = typeof req.body.department_id === 'string' && req.body.department_id
        ? req.body.department_id
        : null;
      const resolvedDeptId = await resolveTimesheetActionDepartmentId(req, requestedDeptId);
      if (requestedDeptId && !resolvedDeptId) {
        res.status(403).json({ success: false, error: 'Access denied to this department', code: 'DEPARTMENT_ACCESS_DENIED' });
        return;
      }
      if (!resolvedDeptId) {
        res.status(400).json({ success: false, error: 'department_id обязателен' });
        return;
      }
      deptId = resolvedDeptId;
    }

    const draft = await findOrCreateDraftApproval({
      departmentId: deptId,
      managerEmployeeId,
      startDate: range.startDate,
      endDate: range.endDate,
      userId: req.user.id,
    });
    if (draft.status !== 'draft' && draft.status !== 'rejected' && draft.status !== 'returned') {
      res.status(409).json({ success: false, error: 'Период уже на проверке или утверждён — загрузка недоступна' });
      return;
    }

    const file = req.file;
    const mimeType = file.mimetype || 'application/octet-stream';
    const safeFileName = sanitizeFileName(file.originalname);
    const ext = path.extname(safeFileName) || '.bin';
    const r2Key = `documents/timesheet-approvals/${draft.id}/${randomUUID()}${ext}`;

    await r2Service.uploadObject(r2Key, file.buffer, mimeType);

    let created;
    try {
      created = await createAttachmentRecord({
        approvalId: draft.id,
        fileName: safeFileName,
        fileSize: file.size,
        mimeType,
        r2Key,
        uploadedBy: req.user.id,
      });
    } catch (err) {
      try { await r2Service.deleteObject(r2Key); } catch { /* best-effort cleanup */ }
      throw err;
    }

    await logApprovalAudit(req, draft.id, 'TIMESHEET_APPROVAL_ATTACHMENT_UPLOADED', {
      department_id: deptId,
      manager_employee_id: managerEmployeeId,
      start_date: range.startDate,
      end_date: range.endDate,
      document_id: created.document_id,
      file_name: created.file_name,
    });

    res.json({ success: true, data: created });
  } catch (err) {
    console.error('timesheet-approval.uploadAttachment error:', err);
    res.status(500).json({ success: false, error: 'Ошибка загрузки файла' });
  }
};

/**
 * Подбор доступа к существующей подаче для attachment-операций:
 * - полная подача (manager_employee_id IS NULL): обычная проверка ensureTimesheetActionDepartmentAccess;
 * - персональная (manager_employee_id NOT NULL): автор подачи или HR со scope='all'.
 */
async function ensureAttachmentAccess(
  req: AuthenticatedRequest,
  approval: Pick<TimesheetApproval, 'department_id' | 'manager_employee_id'>,
): Promise<boolean> {
  if (approval.manager_employee_id != null) {
    if (req.user.employee_id && req.user.employee_id === approval.manager_employee_id) return true;
    const scope = await resolveRequestDataScope(req);
    return scope === 'all';
  }
  if (approval.department_id) {
    return ensureTimesheetActionDepartmentAccess(req, approval.department_id);
  }
  return false;
}

/** Руководитель / HR: список вложений подачи табеля. */
const listAttachments = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    let approvalId: number | null = null;
    const approvalIdRaw = req.query.approval_id;
    if (approvalIdRaw && typeof approvalIdRaw === 'string') {
      approvalId = Number(approvalIdRaw);
    } else {
      const personal = req.query.personal === 'true' || req.query.personal === '1';
      const range = parseRangeFromQuery(req.query as Record<string, unknown>);
      if (!range) {
        res.status(400).json({ success: false, error: 'approval_id или start_date+end_date обязательны' });
        return;
      }
      if (personal) {
        if (!req.user.employee_id) {
          res.json({ success: true, data: [] });
          return;
        }
        const match = await queryOne<{ id: number | string }>(
          `SELECT id FROM timesheet_approvals
             WHERE manager_employee_id = $1 AND start_date = $2 AND end_date = $3
             LIMIT 1`,
          [req.user.employee_id, range.startDate, range.endDate],
        );
        if (!match) {
          res.json({ success: true, data: [] });
          return;
        }
        approvalId = Number(match.id);
      } else {
        const deptIdRaw = typeof req.query.department_id === 'string' ? req.query.department_id : null;
        const deptId = await resolveTimesheetActionDepartmentId(req, deptIdRaw);
        if (deptIdRaw && !deptId) {
          res.status(403).json({ success: false, error: 'Access denied to this department', code: 'DEPARTMENT_ACCESS_DENIED' });
          return;
        }
        if (!deptId) {
          res.status(400).json({ success: false, error: 'approval_id или department_id+start_date+end_date обязательны' });
          return;
        }
        const match = await queryOne<{ id: number | string }>(
          `SELECT id FROM timesheet_approvals
             WHERE department_id = $1 AND start_date = $2 AND end_date = $3
               AND manager_employee_id IS NULL
             LIMIT 1`,
          [deptId, range.startDate, range.endDate],
        );
        if (!match) {
          res.json({ success: true, data: [] });
          return;
        }
        approvalId = Number(match.id);
      }
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
    if (!(await ensureAttachmentAccess(req, approval))) {
      res.status(403).json({ success: false, error: 'Нет доступа к этому табелю' });
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
    if (!(await ensureAttachmentAccess(req, approval))) {
      res.status(403).json({ success: false, error: 'Нет доступа к этому табелю' });
      return;
    }
    if (approval.status !== 'draft' && approval.status !== 'rejected' && approval.status !== 'returned') {
      res.status(409).json({ success: false, error: 'Период уже на проверке или утверждён — удаление недоступно' });
      return;
    }

    const result = await deleteAttachmentRecord(documentId);
    await logApprovalAudit(req, approval.id, 'TIMESHEET_APPROVAL_ATTACHMENT_DELETED', {
      department_id: approval.department_id,
      manager_employee_id: approval.manager_employee_id,
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

/** HR / Admin: подписанный URL для просмотра вложения подачи табеля. */
const getAttachmentDownloadUrl = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!(await r2Service.isEnabledAsync())) {
      res.status(503).json({ success: false, error: 'R2 хранилище не настроено' });
      return;
    }
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

    const approval = await loadApprovalById(String(Number(linkRow.entity_id)));
    if (!approval) {
      res.status(404).json({ success: false, error: 'Подача не найдена' });
      return;
    }
    if (!(await ensureAttachmentAccess(req, approval))) {
      res.status(403).json({ success: false, error: 'Нет доступа к этому табелю' });
      return;
    }

    const doc = await queryOne<{ r2_key: string; file_name: string }>(
      `SELECT r2_key, file_name FROM documents WHERE id = $1 LIMIT 1`,
      [documentId],
    );
    if (!doc) {
      res.status(404).json({ success: false, error: 'Документ не найден' });
      return;
    }

    const downloadUrl = await r2Service.generateDownloadUrl(doc.r2_key);
    res.json({ success: true, data: { download_url: downloadUrl, file_name: doc.file_name } });
  } catch (err) {
    console.error('timesheet-approval.getAttachmentDownloadUrl error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения URL' });
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
      // Для dept-scope HR показываем только полные подачи назначенных отделов.
      // Персональные подачи видны только админам/HR со scope='all' — это допустимо для MVP.
      whereParts.push(`(department_id = ANY($${params.length}::uuid[]) AND manager_employee_id IS NULL)`);
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

    const deptIds = [...new Set(rows.map((r) => r.department_id).filter((id): id is string => !!id))];
    const userIds = [...new Set(
      rows.flatMap((r) => [r.submitted_by, r.reviewed_by]).filter((id): id is string => Boolean(id)),
    )];
    const managerEmpIds = [...new Set(
      rows.map(r => r.manager_employee_id).filter((id): id is number => Number.isInteger(id) && (id ?? 0) > 0),
    )];
    const personalApprovalIds = rows
      .filter(r => r.manager_employee_id != null)
      .map(r => r.id);

    // Snapshot personal-подач — для weekend-check внутри enriched (employeeIds).
    const personalSnapshotRows = personalApprovalIds.length > 0
      ? await query<{ approval_id: number; employee_id: number }>(
        `SELECT approval_id, employee_id
           FROM timesheet_approval_employees
           WHERE approval_id = ANY($1::bigint[])`,
        [personalApprovalIds],
      )
      : [];

    const [deptRows, userRows, managerRows] = await Promise.all([
      deptIds.length > 0
        ? query<{ id: string; name: string | null }>(
          `SELECT id, name FROM org_departments WHERE id = ANY($1::uuid[])`,
          [deptIds],
        )
        : Promise.resolve([] as Array<{ id: string; name: string | null }>),
      userIds.length > 0
        ? query<{ id: string; full_name: string | null; role_code: string | null }>(
          `SELECT up.id, up.full_name, sr.code AS role_code
             FROM user_profiles up
             LEFT JOIN system_roles sr ON sr.id = up.system_role_id
            WHERE up.id = ANY($1::uuid[])`,
          [userIds],
        )
        : Promise.resolve([] as Array<{ id: string; full_name: string | null; role_code: string | null }>),
      managerEmpIds.length > 0
        ? query<{ id: number; full_name: string | null }>(
          `SELECT id, full_name FROM employees WHERE id = ANY($1::int[])`,
          [managerEmpIds],
        )
        : Promise.resolve([] as Array<{ id: number; full_name: string | null }>),
    ]);

    const deptNames = new Map(deptRows.map((row) => [String(row.id), String(row.name ?? '')]));
    const userNames = new Map(userRows.map((row) => [String(row.id), String(row.full_name ?? '')]));
    const supervisorFlag = new Map(userRows.map(row => [String(row.id), row.role_code === 'site_supervisor']));
    const managerNames = new Map(managerRows.map((row) => [Number(row.id), row.full_name ?? null]));

    const snapshotByApproval = new Map<number, number[]>();
    for (const s of personalSnapshotRows) {
      const list = snapshotByApproval.get(Number(s.approval_id)) ?? [];
      list.push(Number(s.employee_id));
      snapshotByApproval.set(Number(s.approval_id), list);
    }

    // Группировка по «участку» = по начальнику участка (роль site_supervisor,
    // который подал табель). Все его подачи (любые бригады + его persona-подача) сворачиваются
    // в одну карточку «Участок: <ФИО супервайзера>». Подачи обычных пользователей идут одиночками.
    const deriveGroup = (row: TimesheetApproval): {
      parentDeptId: string | null;
      parentDeptName: string | null;
      groupKey: string;
    } => {
      const submitter = row.submitted_by;
      const isSupervisor = submitter != null && supervisorFlag.get(submitter) === true;
      if (isSupervisor) {
        return {
          parentDeptId: null,
          parentDeptName: userNames.get(submitter) ?? null,
          groupKey: `supervisor:${submitter}`,
        };
      }
      return { parentDeptId: null, parentDeptName: null, groupKey: `approval:${row.id}` };
    };

    const groupInfoByApproval = new Map<number, ReturnType<typeof deriveGroup>>();
    for (const r of rows) groupInfoByApproval.set(r.id, deriveGroup(r));

    const enriched = await Promise.all(rows.map(async (row) => {
      const isPersonal = row.manager_employee_id != null;
      const snapshotIds = isPersonal ? (snapshotByApproval.get(row.id) ?? []) : undefined;

      const weekend = await checkWeekendWorkRequirement({
        departmentId: row.department_id,
        startDate: row.start_date,
        endDate: row.end_date,
        employeeIds: snapshotIds,
      });

      const employeeIds = isPersonal
        ? snapshotIds!
        : row.department_id
          ? await import('../services/timesheet-department-assignments.service.js')
              .then((mod) => mod.listEmployeeIdsAssignedToDepartmentPeriod(row.department_id!, row.start_date, row.end_date))
          : [];

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

      const groupInfo = groupInfoByApproval.get(row.id) ?? {
        parentDeptId: null,
        parentDeptName: null,
        groupKey: row.department_id ? `parent:${row.department_id}` : `approval:${row.id}`,
      };

      return {
        ...row,
        department_name: row.department_id ? deptNames.get(row.department_id) ?? null : null,
        manager_employee_name: row.manager_employee_id != null ? managerNames.get(row.manager_employee_id) ?? null : null,
        submitted_by_name: row.submitted_by ? userNames.get(row.submitted_by) ?? null : null,
        reviewed_by_name: row.reviewed_by ? userNames.get(row.reviewed_by) ?? null : null,
        parent_department_id: groupInfo.parentDeptId,
        parent_department_name: groupInfo.parentDeptName,
        group_key: groupInfo.groupKey,
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

/**
 * HR-дашборд: сводка по подаче/утверждению табелей за период + карта руководителей
 * (с привязкой к отделам и без, зарегистрированных в ФОТ и не зарегистрированных).
 */
const getDashboard = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const range = parseRangeFromQuery(req.query as Record<string, unknown>);
    if (!range) {
      res.status(400).json({ success: false, error: 'start_date и end_date обязательны' });
      return;
    }

    const accessible = await resolveAccessibleDepartmentIds(req);
    if (accessible !== 'all' && accessible.length === 0) {
      res.status(403).json({ success: false, error: 'Нет доступа' });
      return;
    }

    const scopeIsAll = accessible === 'all';
    const scopeIds = scopeIsAll ? [] : accessible;

    // 1. Список отделов в скоупе (для расчёта «не подано»).
    type DeptRow = {
      id: string;
      name: string | null;
      parent_id: string | null;
    };
    const deptRows = scopeIsAll
      ? await query<DeptRow>(`SELECT id, name, parent_id FROM org_departments`)
      : await query<DeptRow>(
        `SELECT id, name, parent_id FROM org_departments WHERE id = ANY($1::uuid[])`,
        [scopeIds],
      );
    const deptById = new Map(deptRows.map(d => [d.id, d]));
    const deptPath = (id: string | null): string => {
      const parts: string[] = [];
      let cur: string | null = id;
      const guard = new Set<string>();
      while (cur && !guard.has(cur)) {
        guard.add(cur);
        const d = deptById.get(cur);
        if (!d) break;
        parts.unshift(d.name ?? cur);
        cur = d.parent_id;
      }
      return parts.join(' / ');
    };

    // 2. Согласования табелей в выбранном диапазоне (пересечение).
    type ApprovalSlim = {
      id: number;
      department_id: string | null;
      manager_employee_id: number | null;
      status: TimesheetApprovalStatus;
      start_date: string;
      end_date: string;
    };
    const approvalWhere: string[] = [
      `ta.start_date <= $1`,
      `ta.end_date >= $2`,
    ];
    const approvalParams: unknown[] = [range.endDate, range.startDate];
    if (!scopeIsAll) {
      approvalParams.push(scopeIds);
      approvalWhere.push(
        `(ta.department_id = ANY($${approvalParams.length}::uuid[])` +
        ` OR ta.manager_employee_id IS NOT NULL)`,
      );
    }
    const approvals = await query<ApprovalSlim>(
      `SELECT id, department_id, manager_employee_id, status, start_date, end_date
         FROM timesheet_approvals ta
         WHERE ${approvalWhere.join(' AND ')}`,
      approvalParams,
    );

    const submittedStatuses = new Set<TimesheetApprovalStatus>(['submitted', 'approved']);
    const approvedStatuses = new Set<TimesheetApprovalStatus>(['approved']);
    const returnedStatuses = new Set<TimesheetApprovalStatus>(['returned', 'rejected']);

    const departmentsSubmitted = new Set<string>();
    const departmentsApproved = new Set<string>();
    const departmentsReturned = new Set<string>();
    const managersSubmitted = new Set<number>();
    const managersApproved = new Set<number>();
    const managersReturned = new Set<number>();
    const allManagersInPeriod = new Set<number>();

    for (const a of approvals) {
      if (a.department_id) {
        if (submittedStatuses.has(a.status)) departmentsSubmitted.add(a.department_id);
        if (approvedStatuses.has(a.status)) departmentsApproved.add(a.department_id);
        if (returnedStatuses.has(a.status)) departmentsReturned.add(a.department_id);
      } else if (a.manager_employee_id != null) {
        allManagersInPeriod.add(a.manager_employee_id);
        if (submittedStatuses.has(a.status)) managersSubmitted.add(a.manager_employee_id);
        if (approvedStatuses.has(a.status)) managersApproved.add(a.manager_employee_id);
        if (returnedStatuses.has(a.status)) managersReturned.add(a.manager_employee_id);
      }
    }

    // 3. Отделы без подачи (в скоупе) + ответственные.
    const notSubmittedDeptIds = deptRows
      .map(d => d.id)
      .filter(id => !departmentsSubmitted.has(id));

    type ResponsibleRow = {
      department_id: string;
      user_id: string;
      full_name: string | null;
    };
    const responsibleRows = notSubmittedDeptIds.length > 0
      ? await query<ResponsibleRow>(
        `SELECT tr.department_id, tr.user_id, up.full_name
           FROM timesheet_responsibles tr
           JOIN user_profiles up ON up.id = tr.user_id
          WHERE tr.is_active = TRUE
            AND tr.role = 'primary'
            AND tr.department_id = ANY($1::uuid[])`,
        [notSubmittedDeptIds],
      )
      : [];
    const responsibleByDept = new Map<string, ResponsibleRow>(
      responsibleRows.map(r => [r.department_id, r]),
    );

    const not_submitted_departments = notSubmittedDeptIds.map(id => {
      const d = deptById.get(id);
      const resp = responsibleByDept.get(id);
      return {
        department_id: id,
        department_name: d?.name ?? id,
        parent_path: deptPath(id),
        responsible_user_id: resp?.user_id ?? null,
        responsible_name: resp?.full_name ?? null,
      };
    });

    // 4. Карта руководителей: зарегистрированные в ФОТ (+ привязка к отделам).
    type RegisteredRow = {
      user_id: string;
      full_name: string | null;
      role_code: string;
      department_id: string | null;
      department_name: string | null;
    };
    const registeredRows = await query<RegisteredRow>(
      `SELECT up.id::text AS user_id,
              up.full_name,
              sr.code AS role_code,
              od.id::text AS department_id,
              od.name AS department_name
         FROM user_profiles up
         JOIN system_roles sr ON sr.id = up.system_role_id
         LEFT JOIN user_department_access uda
                ON uda.user_id = up.id AND uda.is_active = TRUE
         LEFT JOIN org_departments od ON od.id = uda.department_id
        WHERE sr.code IN ('manager','manager_obj')
          AND up.is_approved = TRUE
        ORDER BY up.full_name NULLS LAST`,
    );

    type ManagerEntry = {
      user_id: string;
      full_name: string;
      role_code: 'manager' | 'manager_obj';
      departments: Array<{ id: string; name: string }>;
    };
    const registeredById = new Map<string, ManagerEntry>();
    for (const row of registeredRows) {
      const id = row.user_id;
      let entry = registeredById.get(id);
      if (!entry) {
        entry = {
          user_id: id,
          full_name: row.full_name ?? '',
          role_code: (row.role_code === 'manager_obj' ? 'manager_obj' : 'manager') as 'manager' | 'manager_obj',
          departments: [],
        };
        registeredById.set(id, entry);
      }
      if (row.department_id) {
        const inScope = scopeIsAll || scopeIds.includes(row.department_id);
        if (inScope) {
          entry.departments.push({ id: row.department_id, name: row.department_name ?? row.department_id });
        }
      }
    }

    const registered_bound: ManagerEntry[] = [];
    const registered_unbound: Array<Omit<ManagerEntry, 'departments'>> = [];
    for (const entry of registeredById.values()) {
      if (entry.departments.length > 0) {
        registered_bound.push(entry);
      } else {
        registered_unbound.push({
          user_id: entry.user_id,
          full_name: entry.full_name,
          role_code: entry.role_code,
        });
      }
    }

    // 5. Незарегистрированные руководители: employees с positions.category='manager' и без user_profile.
    type UnregisteredRow = {
      employee_id: number;
      full_name: string | null;
      position_name: string | null;
      department_id: string | null;
    };
    const unregisteredParams: unknown[] = [];
    const unregisteredWhere: string[] = [
      `p.category = 'manager'`,
      `up.id IS NULL`,
      `COALESCE(e.is_archived, FALSE) = FALSE`,
      `COALESCE(e.current_status, '') NOT IN ('Уволен','Уволена','уволен','уволена','dismissed')`,
    ];
    if (!scopeIsAll) {
      unregisteredParams.push(scopeIds);
      unregisteredWhere.push(`e.org_department_id = ANY($${unregisteredParams.length}::uuid[])`);
    }
    const unregisteredRows = await query<UnregisteredRow>(
      `SELECT e.id::int AS employee_id,
              e.full_name,
              p.name AS position_name,
              e.org_department_id::text AS department_id
         FROM employees e
         JOIN positions p ON p.id = e.position_id
         LEFT JOIN user_profiles up ON up.employee_id = e.id
        WHERE ${unregisteredWhere.join(' AND ')}
        ORDER BY e.full_name NULLS LAST`,
      unregisteredParams,
    );

    const unregistered = unregisteredRows.map(r => ({
      employee_id: r.employee_id,
      full_name: r.full_name ?? '',
      position_name: r.position_name ?? '',
      department_path: deptPath(r.department_id),
    }));

    // 6. Личные подачи менеджеров «не подали»: те, у кого есть direct_reports в скоупе,
    //    но в выбранном периоде не появилось ни submitted/approved. Берём пул менеджеров
    //    из user_profiles (manager_obj + site_supervisor): они и подают
    //    личные табели. Простой агрегат — manager_employee_id_in_period.
    type PersonalManagerRow = {
      employee_id: number;
      full_name: string | null;
      department_id: string | null;
    };
    const personalManagerRows = await query<PersonalManagerRow>(
      `SELECT DISTINCT e.id::int AS employee_id,
              e.full_name,
              e.org_department_id::text AS department_id
         FROM employee_direct_reports edr
         JOIN employees e ON e.id = edr.manager_employee_id
        WHERE COALESCE(edr.is_active, TRUE) = TRUE
          AND COALESCE(e.is_archived, FALSE) = FALSE`,
    );

    const personalManagerIds = personalManagerRows.map(r => r.employee_id);
    const not_submitted_managers = personalManagerRows
      .filter(r => !managersSubmitted.has(r.employee_id) && !managersApproved.has(r.employee_id))
      .map(r => ({
        employee_id: r.employee_id,
        full_name: r.full_name ?? '',
        department_path: deptPath(r.department_id),
      }));

    const departments_total = deptRows.length;
    const departments_submitted = departmentsSubmitted.size;
    const departments_approved = departmentsApproved.size;
    const departments_returned = departmentsReturned.size;
    const departments_not_submitted = Math.max(0, departments_total - departments_submitted);

    res.json({
      success: true,
      data: {
        period: { start_date: range.startDate, end_date: range.endDate },
        approvals: {
          totals: {
            departments_total,
            departments_submitted,
            departments_approved,
            departments_returned,
            departments_not_submitted,
            managers_personal_total: personalManagerIds.length,
            managers_personal_submitted: managersSubmitted.size,
            managers_personal_approved: managersApproved.size,
          },
          not_submitted_departments,
          not_submitted_managers,
        },
        managers: {
          registered_bound,
          registered_unbound,
          unregistered,
        },
      },
    });
  } catch (err) {
    const pg = err as {
      code?: string;
      message?: string;
      detail?: string;
      hint?: string;
      position?: string;
      where?: string;
      schema?: string;
      table?: string;
      column?: string;
      constraint?: string;
      stack?: string;
    };
    console.error('timesheet-approval.getDashboard error:', {
      code: pg.code,
      message: pg.message,
      detail: pg.detail,
      hint: pg.hint,
      position: pg.position,
      where: pg.where,
      schema: pg.schema,
      table: pg.table,
      column: pg.column,
      constraint: pg.constraint,
      start_date: req.query?.start_date,
      end_date: req.query?.end_date,
      userId: req.user?.id,
      is_admin: req.user?.is_admin,
      stack: pg.stack,
    });
    const payload: { success: false; error: string; debug?: { code?: string; message?: string } } = {
      success: false,
      error: 'Ошибка получения дашборда',
    };
    if (!IS_PRODUCTION) {
      payload.debug = { code: pg.code, message: pg.message };
    }
    res.status(500).json(payload);
  }
};

/** HR / руководитель в скоупе: состав сотрудников, поданных на согласование (снимок на момент submit). */
const getSubmittedEmployees = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const approval = await loadApprovalById(id);
    if (!approval) {
      res.status(404).json({ success: false, error: 'Запись не найдена' });
      return;
    }
    if (!(await ensureApprovalAccess(req, approval))) {
      res.status(403).json({ success: false, error: 'Нет доступа к этому табелю' });
      return;
    }
    const employees = await listApprovalEmployees(approval.id);
    res.json({ success: true, data: { employees } });
  } catch (err) {
    console.error('timesheet-approval.getSubmittedEmployees error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения состава табеля' });
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
  uploadAttachment,
  listAttachments,
  deleteAttachment,
  getAttachmentDownloadUrl,
  getReviewList,
  getSubmittedEmployees,
  getDashboard,
};
