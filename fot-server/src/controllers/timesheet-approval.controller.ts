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
import {
  listEmployeeMembershipsForDepartmentPeriod,
  buildMembershipWindowMap,
  isWithinMembershipWindow,
  type IMembershipWindow,
} from '../services/timesheet-department-assignments.service.js';
import { emitDomainChange } from '../services/realtime-broadcast.service.js';
import { settingsService } from '../services/settings.service.js';
import { IS_PRODUCTION } from '../config/features.js';
import { invalidateCaches } from '../middleware/cacheResponse.js';

/**
 * Сброс серверных LRU-кэшей табеля после смены статуса согласования.
 * Эндпоинты согласования живут на роутере /api/timesheet-approvals, поэтому
 * write-through сброс кэша роутера /api/timesheet их не покрывает — иначе сетка
 * (с блокировками дней) отдаётся из кэша ещё до 5 минут после отзыва/утверждения.
 */
const invalidateTimesheetGridCaches = (): void =>
  invalidateCaches('timesheet', 'timesheet:today', 'timesheet:overview', 'timesheet:overview:today');

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
import { resolveOverlapSubmission } from '../services/timesheet-approval-overlap.service.js';
import { loadRoleRestrictions } from '../services/correction-restrictions.service.js';
import { getAllowedSubmissionRange, isRangeSubmittable } from '../services/timesheet-period.service.js';
import { resolveEffectivePageAccess } from '../services/access-control.service.js';
import {
  createAttachmentRecord,
  deleteAttachmentRecord,
  findOrCreateDraftApproval,
  listApprovalPeriodAttachments,
  relinkApprovalAttachments,
} from '../services/timesheet-approval-attachments.service.js';
import { r2Service } from '../services/r2.service.js';
import {
  listApprovalEmployees,
  resolveManagerPersonalSnapshotIds,
  snapshotApprovalEmployees,
} from '../services/timesheet-approval-employees-snapshot.service.js';
import {
  listDirectReportDepartmentIds,
  listDirectSubordinates,
} from '../services/employee-direct-reports.service.js';
import { sanitizeFileName } from '../utils/file-validation.utils.js';
import { decodeMulterFilename } from '../utils/multer-filename.utils.js';
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

/**
 * Опциональный фильтр отделов для дашборда (`?department_ids=a,b` или повтор параметра).
 * Возвращает null, если параметр отсутствует (фильтра нет); [] — если параметр есть, но пуст
 * (значит «снять все» → дашборд показывает ноль).
 */
function parseDepartmentIdsFromQuery(query: Record<string, unknown>): string[] | null {
  const raw = query.department_ids;
  if (raw === undefined || raw === null) return null;
  const parts = Array.isArray(raw)
    ? raw.flatMap(v => String(v).split(','))
    : String(raw).split(',');
  return parts.map(s => s.trim()).filter(s => s.length > 0);
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
export async function resolvePersonalSubmissionContext(req: AuthenticatedRequest): Promise<{
  managerEmployeeId: number;
  employeeIds: number[];
  affectedDepartmentIds: string[];
} | null> {
  if (!req.user.employee_id) return null;
  const managerEmployeeId = req.user.employee_id;
  const subordinateIds = await listDirectSubordinates(managerEmployeeId);
  if (subordinateIds.length === 0) return null;

  // Сам руководитель тоже входит в персональную подачу (строка РУКОВОДИТЕЛЬ /
  // source='self' в его сетке). Без него снимок состоит лишь из подчинённых и
  // руководитель «теряется» у проверяющего. Зеркалит resolveManagerPersonalSnapshotIds.
  const candidateIds = [...new Set([managerEmployeeId, ...subordinateIds])];

  const rows = await query<{ id: number; org_department_id: string | null }>(
    `SELECT id, org_department_id
       FROM employees
      WHERE id = ANY($1::int[])
        AND (is_archived IS NULL OR is_archived = false)
        AND (employment_status IS NULL OR employment_status = 'active')`,
    [candidateIds],
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
 * Гарантирует, что у руководителя за указанный диапазон есть persona-подача,
 * включающая его самого + его активных прямых подчинённых (employee_direct_reports),
 * за вычетом тех, кто уже покрыт department-подачей за этот период. Используется
 * после успешной полной подачи отдела: подчинённые, назначенные руководителю лично
 * (и сидящие вне подаваемых бригад), иначе не попадут ни в одну подачу и будут не
 * видны HR на странице согласования. Идемпотентно — повторные вызовы для того же
 * диапазона не создают дублей, partial EXCLUDE на manager_employee_id это поддерживает.
 *
 * Возвращает:
 *  - null, если подача не нужна (нет employee_id, итоговый набор пуст — нет активных
 *    direct reports и сам руководитель уже покрыт department-подачей; либо persona
 *    уже актуальна и состав лишь дополнен idempotent-upsert'ом).
 *  - { approval, transitioned: true } — если подача создана или переведена в submitted
 *    (нужно отправить notify HR + событие в историю).
 */
async function ensureManagerSelfApprovalForRange(
  req: AuthenticatedRequest,
  range: ITimesheetDateRange,
): Promise<{ approval: TimesheetApproval; transitioned: boolean } | null> {
  const managerEmpId = req.user.employee_id;
  if (!managerEmpId) return null;

  // Состав persona-подачи: сам руководитель + активные прямые подчинённые, за вычетом
  // уже покрытых department-подачами за этот период (дедуп против двойного показа).
  // Если набор пуст (нет подчинённых вне бригад и сам руководитель в бригаде) —
  // persona-подача не нужна.
  const snapshotIds = await resolveManagerPersonalSnapshotIds(managerEmpId, range.startDate, range.endDate);
  if (snapshotIds.length === 0) return null;

  const now = new Date().toISOString();

  const existing = await queryOne<TimesheetApproval>(
    `SELECT * FROM timesheet_approvals
       WHERE manager_employee_id = $1 AND start_date = $2 AND end_date = $3
       LIMIT 1`,
    [managerEmpId, range.startDate, range.endDate],
  );

  if (existing) {
    // Если уже submitted/approved — статус не трогаем, но перезаписываем состав полным
    // набором (self + активные direct reports минус покрытые dept-подачами), чтобы
    // назначенные сотрудники попали в snapshot. snapshotApprovalEmployees делает
    // DELETE+INSERT — передаём полный набор, не дельту.
    if (existing.status === 'submitted' || existing.status === 'approved') {
      await withTransaction(async client => {
        await snapshotApprovalEmployees(client, existing.id, snapshotIds);
      });
      return null;
    }
    // draft / returned / rejected → переводим в submitted и пишем полный snapshot.
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
      await snapshotApprovalEmployees(client, existing.id, snapshotIds);
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
      if (row) await snapshotApprovalEmployees(client, row.id, snapshotIds);
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

/**
 * Уведомление об отзыве УЖЕ утверждённого табеля руководителем (переподача без HR).
 * Получатели: прежний проверяющий (reviewed_by) + проверяющие/мониторящие отдела.
 * Инициатора (actorUserId) не уведомляем.
 */
async function notifyApprovalRecalledFromApproved(input: {
  previousReviewerId: string | null;
  departmentId: string | null;
  managerEmployeeId: number | null;
  range: ITimesheetDateRange;
  actorUserId: string;
}): Promise<void> {
  const { previousReviewerId, departmentId, managerEmployeeId, range, actorUserId } = input;

  const recipients = new Set<string>();
  if (previousReviewerId) recipients.add(previousReviewerId);
  const reviewDepts = departmentId
    ? [departmentId]
    : (managerEmployeeId != null ? await listDirectReportDepartmentIds(managerEmployeeId) : []);
  for (const dept of reviewDepts) {
    const ids = await listTimesheetWorkflowRecipientIds(dept, ['review', 'monitor']);
    for (const uid of ids) recipients.add(uid);
  }
  recipients.delete(actorUserId);
  if (recipients.size === 0) return;

  const rangeLabel = formatTimesheetRangeLabel(range.startDate, range.endDate);
  const subjectName = managerEmployeeId != null
    ? `Персональная подача (${(await loadEmployeeFullName(managerEmployeeId)) ?? 'руководитель'})`
    : departmentId
      ? `Отдел ${await loadDepartmentName(departmentId)}`
      : 'Табель';
  const path = departmentId
    ? buildRangeRedirectPath('/timesheet', range, departmentId)
    : buildRangeRedirectPath('/timesheet', range);

  const title = 'Утверждённый табель отозван';
  const body = `${subjectName}: руководитель отозвал утверждённый табель за ${rangeLabel} для переподачи.`;
  const recipientIds = [...recipients];

  await notificationService.createMany(recipientIds.map(userId => ({
    userId,
    type: 'timesheet_approval_recalled',
    title,
    body,
    metadata: {
      departmentId,
      managerEmployeeId,
      start_date: range.startDate,
      end_date: range.endDate,
      status: 'draft',
      path,
    },
  })));
  await pushService.sendGenericNotification(
    recipientIds,
    title,
    body,
    { path, start_date: range.startDate, end_date: range.endDate },
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
    // system_admin / HR (доступ к /timesheet-hr) или роли с timesheet_show_full_period блокировку обходят.
    const submissionExempt = req.user.timesheet_show_full_period || (await resolveEffectivePageAccess(req, '/timesheet-hr', 'view'));
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

    // Все пересекающиеся подачи того же скоупа. Зеркалит EXCLUDE-констрейнты
    // миграции 122 (daterange && daterange), а не точное совпадение дат: иначе
    // смена диапазона (полупериод → месяц) поверх уже поданного табеля не
    // находила строку и падала в INSERT → 23P01 → невнятный 409.
    const overlaps = personal
      ? await query<TimesheetApproval>(
          `SELECT * FROM timesheet_approvals
             WHERE manager_employee_id = $1
               AND daterange(start_date, end_date, '[]') && daterange($2::date, $3::date, '[]')
             ORDER BY id`,
          [managerEmployeeId, range.startDate, range.endDate],
        )
      : await query<TimesheetApproval>(
          `SELECT * FROM timesheet_approvals
             WHERE department_id = $1 AND manager_employee_id IS NULL
               AND daterange(start_date, end_date, '[]') && daterange($2::date, $3::date, '[]')
             ORDER BY id`,
          [deptId, range.startDate, range.endDate],
        );

    // Политика «вытеснять»: переиспользуем активную/точную строку, прочие
    // пересекающиеся НЕутверждённые подачи удаляем. approved — блокирует.
    const { approvedOverlap, exactSame, reuseRow, toDeleteIds } = resolveOverlapSubmission(overlaps, range);

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

    // Все строки, консолидируемые этим сабмитом: файл служебки мог быть загружен
    // на точный черновик диапазона (exactSame), который при вытеснении уходит в
    // toDeleteIds, тогда как reuseRow — другая пересекающаяся строка.
    const consolidatedApprovalIds = [reuseRow?.id, exactSame?.id, ...toDeleteIds]
      .filter((id): id is number => typeof id === 'number');

    const { weekend_memo_required } = await loadRoleRestrictions(req.user.system_role_id);
    const memoCheck = await checkManagerObjWeekendMemoRequirement({
      weekendMemoRequired: weekend_memo_required,
      departmentId: deptId,
      startDate: range.startDate,
      endDate: range.endDate,
      approvalIds: consolidatedApprovalIds,
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

    if (approvedOverlap) {
      res.status(409).json({
        success: false,
        error: `Утверждённый табель за ${formatTimesheetRangeLabel(approvedOverlap.start_date, approvedOverlap.end_date)} нельзя переподать напрямую. Сначала верните его на доработку через HR.`,
      });
      return;
    }

    // Тот же диапазон уже подан и не рассмотрен — идемпотентно возвращаем его.
    if (exactSame?.status === 'submitted') {
      res.json({ success: true, data: exactSame });
      return;
    }

    const now = new Date().toISOString();
    let approval: TimesheetApproval | null = null;

    try {
      approval = await withTransaction(async client => {
        let row: TimesheetApproval | null;
        if (reuseRow) {
          // Переиспользуем существующую строку, перезаписывая диапазон под новый
          // (история событий остаётся привязана к этому approval_id).
          const result = await client.query<TimesheetApproval>(
            `UPDATE timesheet_approvals
               SET start_date = $1,
                   end_date = $2,
                   status = 'submitted',
                   submitted_by = $3,
                   submitted_at = $4,
                   reviewed_by = NULL,
                   reviewed_at = NULL,
                   review_comment = NULL,
                   updated_at = $4
               WHERE id = $5
               RETURNING *`,
            [range.startDate, range.endDate, req.user.id, now, reuseRow.id],
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
        // Вытеснение: удаляем прочие пересекающиеся НЕутверждённые подачи того же
        // скоупа (draft/rejected-дубли). approved сюда не попадает — отсечён выше.
        if (toDeleteIds.length > 0 && row) {
          // Сначала перевешиваем служебки с вытесняемых строк на выжившую, иначе
          // document_links осиротеют и файл-подтверждение потеряется.
          await relinkApprovalAttachments(client, toDeleteIds, row.id);
          await client.query(
            `DELETE FROM timesheet_approvals WHERE id = ANY($1::bigint[])`,
            [toDeleteIds],
          );
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
            ? 'Этот период пересекается с другой вашей персональной подачей. Отзовите её и подайте заново.'
            : 'Этот диапазон пересекается с другой подачей табеля этого отдела. Отзовите её и подайте заново.',
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
      fromStatus: reuseRow?.status ?? null,
      toStatus: 'submitted',
      action: 'submitted',
      actorUserId: req.user.id,
    });

    await logApprovalAudit(req, approval.id, 'TIMESHEET_APPROVAL_SUBMITTED', {
      department_id: deptId,
      manager_employee_id: managerEmployeeId,
      start_date: range.startDate,
      end_date: range.endDate,
      from_status: reuseRow?.status ?? null,
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
          const selfEmployeeCount = (await listApprovalEmployees(selfResult.approval.id)).length;
          void notifyHrAboutSubmittedApproval({
            departmentId: null,
            managerEmployeeId: req.user.employee_id,
            affectedDepartmentIds: selfAffectedDepartmentIds,
            employeeCount: selfEmployeeCount,
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

    invalidateTimesheetGridCaches();
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

    // Отозвать можно поданный (submitted) или уже утверждённый (approved) табель.
    // Отзыв утверждённого = руководитель сам возвращает его на доработку для переподачи,
    // не дожидаясь HR (раньше это умел только HR через return-to-rework).
    if (!existing || (existing.status !== 'submitted' && existing.status !== 'approved')) {
      res.status(409).json({
        success: false,
        error: 'Отозвать можно только поданный или утверждённый табель',
      });
      return;
    }
    const wasApproved = existing.status === 'approved';

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
      reviewerUserId: existing.reviewed_by ?? req.user.id,
      action: 'recall',
    });

    // Отзыв утверждённого табеля снимает решение HR — уведомляем прежнего проверяющего
    // и проверяющих отдела, что период вернулся в работу для переподачи.
    if (wasApproved) {
      void notifyApprovalRecalledFromApproved({
        previousReviewerId: existing.reviewed_by,
        departmentId: deptId,
        managerEmployeeId,
        range,
        actorUserId: req.user.id,
      }).catch(notifyError => {
        console.error('timesheet-approval.recall notify error:', notifyError);
      });
    }

    invalidateTimesheetGridCaches();
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

    invalidateTimesheetGridCaches();
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
      let membershipWindow: Map<number, IMembershipWindow> | null = null;
      if (approval.manager_employee_id != null) {
        const snap = await listApprovalEmployees(approval.id);
        employeeIds = snap.map(s => s.employee_id);
      } else if (approval.department_id) {
        const memberships = await listEmployeeMembershipsForDepartmentPeriod(
          approval.department_id, approval.start_date, approval.end_date,
        );
        employeeIds = memberships.map(m => m.employee_id);
        membershipWindow = buildMembershipWindowMap(memberships);
      } else {
        employeeIds = [];
      }
      let count = 0;
      if (employeeIds.length > 0) {
        // Берём pending-корректировки и отбрасываем те, что вне окна членства сотрудника
        // в этом отделе (чужой выход после перевода не должен блокировать утверждение).
        const pendingRows = await query<{ employee_id: number; work_date: string }>(
          `SELECT employee_id, work_date::text AS work_date FROM attendance_adjustments
             WHERE approval_status = 'pending'
               AND employee_id = ANY($1::int[])
               AND work_date >= $2
               AND work_date <= $3`,
          [employeeIds, approval.start_date, approval.end_date],
        );
        count = pendingRows.filter((r) =>
          membershipWindow == null
            ? true
            : isWithinMembershipWindow(membershipWindow.get(Number(r.employee_id)), String(r.work_date).slice(0, 10), 'viaTransferOnly'),
        ).length;
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
    const safeFileName = sanitizeFileName(decodeMulterFilename(file.originalname));
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

    const data = await listApprovalPeriodAttachments(approvalId);
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

    const disposition = req.query.disposition === 'inline' ? 'inline' : 'attachment';
    const downloadUrl = await r2Service.generateDownloadUrl(doc.r2_key, doc.file_name, disposition);
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

    // Отметки табельщицы «Проверено» по (department_id, start_date, end_date) этих подач.
    const reviewRows = deptIds.length > 0
      ? await query<{ department_id: string; start_date: string; end_date: string; checked_at: string; checked_by_name: string | null }>(
        `SELECT r.department_id,
                to_char(r.start_date,'YYYY-MM-DD') AS start_date,
                to_char(r.end_date,'YYYY-MM-DD')   AS end_date,
                r.checked_at,
                up.full_name AS checked_by_name
           FROM timesheet_timekeeper_review r
           LEFT JOIN user_profiles up ON up.id = r.checked_by
          WHERE r.department_id = ANY($1::uuid[])`,
        [deptIds],
      )
      : [];
    const reviewKey = (dept: string, start: string, end: string): string =>
      `${dept}|${String(start).slice(0, 10)}|${String(end).slice(0, 10)}`;
    const reviewMap = new Map(
      reviewRows.map(r => [reviewKey(r.department_id, r.start_date, r.end_date), r]),
    );

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

      // Состав отдела + окно членства по сотруднику. Персональная подача («по людям»)
      // окна не имеет — там фильтр не применяется (window === null).
      let employeeIds: number[];
      let membershipWindow: Map<number, IMembershipWindow> | null = null;
      if (isPersonal) {
        employeeIds = snapshotIds!;
      } else if (row.department_id) {
        const memberships = await listEmployeeMembershipsForDepartmentPeriod(
          row.department_id, row.start_date, row.end_date,
        );
        employeeIds = memberships.map((m) => m.employee_id);
        membershipWindow = buildMembershipWindowMap(memberships);
      } else {
        employeeIds = [];
      }
      // Корректировка учитывается, только если её дата входит в окно членства сотрудника
      // в ЭТОМ отделе. Иначе чужой выход (после перевода) «прилипает» к табелю по общей дате.
      const withinWindow = (empId: number, iso: string): boolean =>
        membershipWindow == null
          ? true
          : isWithinMembershipWindow(membershipWindow.get(empId), iso, 'viaTransferOnly');

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
          `SELECT employee_id, work_date::text AS work_date, status, hours_override, source_type, created_by, approval_status
             FROM attendance_adjustments
             WHERE employee_id = ANY($1::int[])
               AND work_date >= $2
               AND work_date <= $3`,
          [employeeIds, row.start_date, row.end_date],
        );
        // Отбрасываем корректировки вне окна членства сотрудника в этом отделе.
        const inWindow = adjustments.filter((a) =>
          withinWindow(Number(a.employee_id), String(a.work_date).slice(0, 10)));

        anyCorrection = inWindow.some((a) => String(a.source_type) === 'manual');
        absentDays = inWindow.some((a) => String(a.status) === 'absent');

        if (weekend.weekendWorkDates.length > 0) {
          const weekendSet = new Set(weekend.weekendWorkDates);
          pendingWeekendDates = [...new Set(
            inWindow
              .filter((a) => String(a.approval_status ?? '') === 'pending' && weekendSet.has(String(a.work_date).slice(0, 10)))
              .map((a) => String(a.work_date).slice(0, 10)),
          )].sort();
          approvedWeekendDates = [...new Set(
            inWindow
              .filter((a) => String(a.approval_status ?? '') === 'approved' && weekendSet.has(String(a.work_date).slice(0, 10)))
              .map((a) => String(a.work_date).slice(0, 10)),
          )].sort();
        }

        if (anyCorrection) {
          const workAdjustments = inWindow.filter((a) => String(a.source_type) === 'manual' && a.hours_override != null);
          if (workAdjustments.length > 0) {
            const dates = [...new Set(workAdjustments.map((a) => String(a.work_date).slice(0, 10)))];
            const skudRows = await query<{ employee_id: number; date: string; total_minutes: number | string | null }>(
              `SELECT employee_id, date::text AS date, total_minutes
                 FROM skud_daily_summary
                 WHERE employee_id = ANY($1::int[])
                   AND date = ANY($2::date[])`,
              [employeeIds, dates],
            );
            const skudMap = new Map<string, number>();
            for (const s of skudRows) {
              skudMap.set(`${Number(s.employee_id)}_${String(s.date).slice(0, 10)}`, Number(s.total_minutes ?? 0));
            }
            const largeDates = new Set<string>();
            for (const adj of workAdjustments) {
              const skudMinutes = skudMap.get(`${Number(adj.employee_id)}_${String(adj.work_date).slice(0, 10)}`) ?? 0;
              const adjHours = Number(adj.hours_override ?? 0);
              if (adjHours * 60 > skudMinutes + 1) {
                correctionExceedsSkud = true;
                largeDates.add(String(adj.work_date).slice(0, 10));
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

      const review = row.department_id
        ? reviewMap.get(reviewKey(row.department_id, row.start_date, row.end_date)) ?? null
        : null;

      return {
        ...row,
        timekeeper_checked: review != null,
        timekeeper_checked_by_name: review?.checked_by_name ?? null,
        timekeeper_checked_at: review?.checked_at ?? null,
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

    // Опциональный фильтр отделов (кнопка «Настройки» на дашборде) — влияет на весь дашборд.
    const departmentIdsFilter = parseDepartmentIdsFromQuery(req.query as Record<string, unknown>);

    // Какие system_roles считаются «руководителями» в Карте руководителей — настройка
    // /admin/settings (dashboard_manager_role_codes), дефолт manager/manager_obj/site_supervisor.
    const { managerRoleCodes } = await settingsService.getDashboardConfig();

    // 1. Полный доступный скоуп отделов — источник для пикера + резолва путей (не зависит от фильтра).
    type DeptRow = {
      id: string;
      name: string | null;
      parent_id: string | null;
    };
    const fullScopeDeptRows = scopeIsAll
      ? await query<DeptRow>(`SELECT id, name, parent_id FROM org_departments WHERE is_active = true`)
      : await query<DeptRow>(
        `SELECT id, name, parent_id FROM org_departments WHERE id = ANY($1::uuid[]) AND is_active = true`,
        [scopeIds],
      );
    const deptById = new Map(fullScopeDeptRows.map(d => [d.id, d]));
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

    // Эффективный скоуп = доступный скоуп ∩ фильтр. effectiveIsAll → без ограничения по id.
    let effectiveIds: string[];
    let effectiveIsAll: boolean;
    if (departmentIdsFilter !== null) {
      if (scopeIsAll) {
        effectiveIds = departmentIdsFilter;
      } else {
        const scopeSet = new Set(scopeIds);
        effectiveIds = departmentIdsFilter.filter(id => scopeSet.has(id));
      }
      effectiveIsAll = false;
    } else {
      effectiveIds = scopeIds;
      effectiveIsAll = scopeIsAll;
    }
    const effSet: Set<string> | null = effectiveIsAll ? null : new Set(effectiveIds);
    const inEffective = (id: string | null): boolean => !effSet || (id != null && effSet.has(id));

    // Корневые каталоги (уровень 1–2: «Объект» и компании/СМ) не считаются статистической
    // единицей и не отбираются — учитываем только уровень ≥ 3. Глубину считаем по полному
    // дереву org_departments (не по скоупу), чтобы у department-scoped пользователей не
    // принять L3-отдел с обрезанным предком за корень.
    const nonCountableRows = await query<{ id: string }>(
      `WITH RECURSIVE t AS (
         SELECT id, 1 AS lvl FROM org_departments WHERE parent_id IS NULL AND is_active = true
         UNION ALL
         SELECT d.id, t.lvl + 1 FROM org_departments d JOIN t ON d.parent_id = t.id
          WHERE d.is_active = true
       )
       SELECT id::text AS id FROM t WHERE lvl <= 2`,
    );
    const nonCountableSet = new Set(nonCountableRows.map(r => r.id));
    const isCountable = (id: string): boolean => !nonCountableSet.has(id);
    const deptRows = fullScopeDeptRows.filter(d => inEffective(d.id) && isCountable(d.id));

    // 2. Пул личных менеджеров (есть активные direct_reports). Нужен заранее — для фильтрации
    //    личных подач по эффективному скоупу (по org_department_id руководителя).
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
    const scopedPersonalManagerRows = personalManagerRows.filter(r => inEffective(r.department_id));
    const allowedPersonal = effSet ? new Set(scopedPersonalManagerRows.map(r => r.employee_id)) : null;

    // 3. Согласования табелей в выбранном диапазоне (пересечение).
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
    if (!effectiveIsAll) {
      approvalParams.push(effectiveIds);
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

    for (const a of approvals) {
      if (a.department_id) {
        if (!inEffective(a.department_id) || !isCountable(a.department_id)) continue;
        if (submittedStatuses.has(a.status)) departmentsSubmitted.add(a.department_id);
        if (approvedStatuses.has(a.status)) departmentsApproved.add(a.department_id);
        if (returnedStatuses.has(a.status)) departmentsReturned.add(a.department_id);
      } else if (a.manager_employee_id != null) {
        if (allowedPersonal && !allowedPersonal.has(a.manager_employee_id)) continue;
        if (submittedStatuses.has(a.status)) managersSubmitted.add(a.manager_employee_id);
        if (approvedStatuses.has(a.status)) managersApproved.add(a.manager_employee_id);
      }
    }

    // 4. Отделы без подачи (в эффективном скоупе) + ответственные.
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

    // 5. Карта руководителей: зарегистрированные в ФОТ (роли из настройки) + привязка к отделам.
    type RegisteredRow = {
      user_id: string;
      employee_id: number | null;
      full_name: string | null;
      role_code: string;
      department_id: string | null;
      department_name: string | null;
    };
    const registeredRows = await query<RegisteredRow>(
      `SELECT up.id::text AS user_id,
              up.employee_id::int AS employee_id,
              up.full_name,
              sr.code AS role_code,
              od.id::text AS department_id,
              od.name AS department_name
         FROM user_profiles up
         JOIN system_roles sr ON sr.id = up.system_role_id
         LEFT JOIN employee_department_access eda
                ON eda.employee_id = up.employee_id AND eda.is_active = TRUE
               AND eda.source <> 'sigur_sync'
         LEFT JOIN org_departments od ON od.id = eda.department_id
        WHERE sr.code = ANY($1::text[])
          AND up.is_approved = TRUE
        ORDER BY up.full_name NULLS LAST`,
      [managerRoleCodes],
    );

    type ManagerAgg = {
      user_id: string;
      employee_id: number | null;
      full_name: string;
      role_code: string;
      all_departments: Array<{ id: string; name: string }>;
    };
    const registeredById = new Map<string, ManagerAgg>();
    for (const row of registeredRows) {
      let entry = registeredById.get(row.user_id);
      if (!entry) {
        entry = {
          user_id: row.user_id,
          employee_id: row.employee_id,
          full_name: row.full_name ?? '',
          role_code: row.role_code,
          all_departments: [],
        };
        registeredById.set(row.user_id, entry);
      }
      if (row.department_id) {
        entry.all_departments.push({ id: row.department_id, name: row.department_name ?? row.department_id });
      }
    }

    // Назначения отдельных сотрудников для руководителей БЕЗ привязки к отделам — чтобы
    // показывать «N сотрудников» вместо пустой/ошибочной привязки. Источники:
    // employee_direct_reports (по manager_employee_id) ∪ user_employee_access (по user_id).
    const unboundManagers = [...registeredById.values()].filter(m => m.all_departments.length === 0);
    const unboundEmpIds = unboundManagers
      .map(m => m.employee_id)
      .filter((v): v is number => v != null);
    const unboundUserIds = unboundManagers.map(m => m.user_id);
    const assignedEmpByUser = new Map<string, Array<{ id: number; full_name: string }>>();
    const pushAssigned = (userId: string, empId: number, name: string | null): void => {
      let list = assignedEmpByUser.get(userId);
      if (!list) { list = []; assignedEmpByUser.set(userId, list); }
      if (!list.some(e => e.id === empId)) list.push({ id: empId, full_name: name ?? '' });
    };
    type AssignedEmpRow = { ref: string; employee_id: number; full_name: string | null };
    if (unboundEmpIds.length > 0) {
      const userByEmp = new Map<number, string>();
      for (const m of unboundManagers) if (m.employee_id != null) userByEmp.set(m.employee_id, m.user_id);
      const drRows = await query<AssignedEmpRow>(
        `SELECT edr.manager_employee_id::text AS ref, e.id::int AS employee_id, e.full_name
           FROM employee_direct_reports edr
           JOIN employees e ON e.id = edr.subordinate_employee_id
          WHERE edr.manager_employee_id = ANY($1::bigint[])
            AND COALESCE(edr.is_active, TRUE) = TRUE
            AND COALESCE(e.is_archived, FALSE) = FALSE`,
        [unboundEmpIds],
      );
      for (const r of drRows) {
        const uid = userByEmp.get(Number(r.ref));
        if (uid) pushAssigned(uid, r.employee_id, r.full_name);
      }
    }
    if (unboundUserIds.length > 0) {
      const ueaRows = await query<AssignedEmpRow>(
        `SELECT uea.user_id::text AS ref, e.id::int AS employee_id, e.full_name
           FROM user_employee_access uea
           JOIN employees e ON e.id = uea.employee_id
          WHERE uea.user_id = ANY($1::uuid[])
            AND uea.is_active = TRUE
            AND COALESCE(e.is_archived, FALSE) = FALSE`,
        [unboundUserIds],
      );
      for (const r of ueaRows) pushAssigned(r.ref, r.employee_id, r.full_name);
    }

    // Единый список руководителей (UI рендерит одну таблицу): привязка = отделы в скоупе
    // ЛИБО «N сотрудников» (assigned_employees) если отделов нет.
    type ManagerEntry = {
      user_id: string;
      full_name: string;
      role_code: string;
      departments: Array<{ id: string; name: string }>;
      assigned_employees: Array<{ id: number; full_name: string }>;
    };
    const managers_list: ManagerEntry[] = [];
    for (const entry of registeredById.values()) {
      const inScope = entry.all_departments.filter(d => inEffective(d.id));
      if (inScope.length > 0) {
        managers_list.push({
          user_id: entry.user_id,
          full_name: entry.full_name,
          role_code: entry.role_code,
          departments: inScope,
          assigned_employees: [],
        });
      } else if (entry.all_departments.length === 0) {
        // Без привязки к отделам — показываем всегда (вне зависимости от фильтра).
        const assigned = assignedEmpByUser.get(entry.user_id) ?? [];
        assigned.sort((a, b) => a.full_name.localeCompare(b.full_name, 'ru'));
        managers_list.push({
          user_id: entry.user_id,
          full_name: entry.full_name,
          role_code: entry.role_code,
          departments: [],
          assigned_employees: assigned,
        });
      }
      // else: привязан, но к не выбранным отделам → вне текущего фильтра, пропускаем.
    }
    managers_list.sort((a, b) => a.full_name.localeCompare(b.full_name, 'ru'));

    // 6. Отделы, которые никому не назначены: нет активного timesheet_responsibles и нет
    //    привязанного руководителя (employee_department_access + роль-руководитель из настройки).
    //    Заменяет прежний блок «не зарегистрированы в ФОТ» (он считал по positions.category=
    //    'manager', а эта категория в данных не используется → счётчик всегда был 0).
    type AssignedDeptRow = { department_id: string };
    const assignedRows = await query<AssignedDeptRow>(
      `SELECT DISTINCT s.department_id::text AS department_id
         FROM (
           SELECT department_id FROM timesheet_responsibles WHERE is_active = TRUE
           UNION
           SELECT eda.department_id
             FROM employee_department_access eda
             JOIN user_profiles up ON up.employee_id = eda.employee_id
             JOIN system_roles sr ON sr.id = up.system_role_id
            WHERE eda.is_active = TRUE
              AND eda.source <> 'sigur_sync'
              AND up.is_approved = TRUE
              AND sr.code = ANY($1::text[])
         ) s
        WHERE s.department_id IS NOT NULL`,
      [managerRoleCodes],
    );
    const assignedSet = new Set(assignedRows.map(r => r.department_id));
    const unassigned_departments = deptRows
      .filter(d => !assignedSet.has(d.id))
      .map(d => ({
        department_id: d.id,
        department_name: d.name ?? d.id,
        parent_path: deptPath(d.id),
      }));

    // 7. Карта отделов: статус подачи на каждый отдел эффективного скоупа («температура»).
    const statusOf = (id: string): 'approved' | 'submitted' | 'returned' | 'not_submitted' => {
      if (departmentsApproved.has(id)) return 'approved';
      if (departmentsSubmitted.has(id)) return 'submitted';
      if (departmentsReturned.has(id)) return 'returned';
      return 'not_submitted';
    };
    const department_status_map = deptRows
      .map(d => ({
        department_id: d.id,
        name: d.name ?? d.id,
        parent_path: deptPath(d.id),
        status: statusOf(d.id),
      }))
      .sort((a, b) => a.parent_path.localeCompare(b.parent_path, 'ru'));

    // 8. Личные подачи «не подали» (в эффективном скоупе).
    const personalManagerIds = scopedPersonalManagerRows.map(r => r.employee_id);
    const not_submitted_managers = scopedPersonalManagerRows
      .filter(r => !managersSubmitted.has(r.employee_id) && !managersApproved.has(r.employee_id))
      .map(r => ({
        employee_id: r.employee_id,
        full_name: r.full_name ?? '',
        department_id: r.department_id,
        department_path: deptPath(r.department_id),
      }));

    // 9. Список отделов полного скоупа — для дерева-пикера (не зависит от фильтра).
    //    parent_id нужен фронту для построения дерева с каскадным выбором.
    const scope_departments = fullScopeDeptRows
      .map(d => ({
        department_id: d.id,
        parent_id: d.parent_id,
        name: d.name ?? d.id,
        parent_path: deptPath(d.id),
        countable: isCountable(d.id),
      }))
      .sort((a, b) => a.parent_path.localeCompare(b.parent_path, 'ru'));

    const departments_total = deptRows.length;
    const departments_submitted = departmentsSubmitted.size;
    const departments_approved = departmentsApproved.size;
    const departments_returned = departmentsReturned.size;
    const departments_not_submitted = Math.max(0, departments_total - departments_submitted);

    res.json({
      success: true,
      data: {
        period: { start_date: range.startDate, end_date: range.endDate },
        scope_departments,
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
          unassigned_departments,
          department_status_map,
        },
        managers: {
          list: managers_list,
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
