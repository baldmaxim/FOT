import type { Response } from 'express';
import { query, queryOne, withTransaction } from '../config/postgres.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { pushService } from '../services/push.service.js';
import { notificationService } from '../services/notification.service.js';
import { getIo } from '../socket/io-instance.js';
import {
  canAccessEmployeeInScope,
  resolveAccessibleDepartmentIds,
  resolveManagedDepartmentIds,
  resolveScopedDepartmentId,
} from '../services/data-scope.service.js';
import { listDirectSubordinates } from '../services/employee-direct-reports.service.js';
import { upsertAttendanceAdjustment } from '../services/attendance.service.js';
import { resolveSchedule, getScheduleForDate } from '../services/schedule.service.js';
import { resolveAdjustmentApprovalStatus } from './timesheet.controller.js';
import type { TimeStatus } from '../types/index.js';

const LEAVE_REQUEST_TYPES = ['vacation', 'sick_leave', 'remote', 'certificate', 'time_correction', 'unpaid', 'work'] as const;
const LEAVE_TYPE_LABELS: Record<string, string> = {
  vacation: 'Отпуск', sick_leave: 'Больничный', remote: 'Удалёнка',
  certificate: 'Справка', time_correction: 'Корректировка', unpaid: 'За свой счёт',
  work: 'Работа',
};
const LEAVE_TO_TIMESHEET: Record<'vacation' | 'sick_leave' | 'remote' | 'unpaid' | 'work', TimeStatus> = {
  vacation: 'vacation',
  sick_leave: 'sick',
  remote: 'remote',
  unpaid: 'unpaid',
  work: 'work',
};

function isTimeStatus(value: unknown): value is TimeStatus {
  return ['work', 'vacation', 'remote', 'unpaid', 'absent', 'sick', 'educational_leave'].includes(String(value));
}

async function loadEmployeeIdsByDepartment(departmentId: string): Promise<Array<{ id: number; full_name: string | null }>> {
  return query<{ id: number; full_name: string | null }>(
    `SELECT id, full_name
       FROM employees
      WHERE org_department_id = $1
        AND employment_status = 'active'`,
    [departmentId],
  );
}

async function loadEmployeeIdsByDepartments(
  departmentIds: string[],
): Promise<Array<{ id: number; full_name: string | null; org_department_id?: string | null }>> {
  if (departmentIds.length === 0) {
    return [];
  }

  return query<{ id: number; full_name: string | null; org_department_id: string | null }>(
    `SELECT id, full_name, org_department_id
       FROM employees
      WHERE org_department_id = ANY($1::uuid[])
        AND employment_status = 'active'`,
    [departmentIds],
  );
}

interface IEmployeeMeta {
  id: number;
  full_name: string | null;
  org_department_id: string | null;
  department_name: string | null;
  position_name: string | null;
}

interface IAttachmentRow {
  leave_request_id: string;
  id: number;
  file_name: string;
  mime_type: string | null;
  file_size: number | null;
}

async function loadEmployeeMeta(employeeIds: number[]): Promise<Map<number, IEmployeeMeta>> {
  if (employeeIds.length === 0) return new Map();
  const rows = await query<IEmployeeMeta>(
    `SELECT e.id,
            e.full_name,
            e.org_department_id,
            od.name AS department_name,
            p.name  AS position_name
       FROM employees e
       LEFT JOIN org_departments od ON od.id = e.org_department_id
       LEFT JOIN positions p        ON p.id = e.position_id
      WHERE e.id = ANY($1::bigint[])`,
    [employeeIds],
  );
  return new Map(rows.map(r => [r.id, r]));
}

async function loadAttachmentsByLeaveRequestIds(
  requestIds: number[],
): Promise<Map<number, Array<{ id: number; file_name: string; mime_type: string | null; file_size: number | null }>>> {
  const result = new Map<number, Array<{ id: number; file_name: string; mime_type: string | null; file_size: number | null }>>();
  if (requestIds.length === 0) return result;
  const rows = await query<IAttachmentRow>(
    `SELECT dl.entity_id AS leave_request_id,
            d.id,
            d.file_name,
            d.mime_type,
            d.file_size
       FROM document_links dl
       JOIN documents d ON d.id = dl.document_id
      WHERE dl.entity_type = 'leave_request'
        AND dl.entity_id = ANY($1::text[])`,
    [requestIds.map(String)],
  );
  for (const row of rows) {
    const key = Number(row.leave_request_id);
    if (!Number.isFinite(key)) continue;
    const list = result.get(key) || [];
    list.push({
      id: row.id,
      file_name: row.file_name,
      mime_type: row.mime_type,
      file_size: row.file_size,
    });
    result.set(key, list);
  }
  return result;
}

/**
 * Для уже approved заявок time_correction поднимаем текущий approval_status
 * связанной attendance_adjustments — фронт показывает «Ожидает доп. согласования
 * администратором», если корректировка в статусе 'pending' (выходной в whitelist-отделе).
 */
async function loadCorrectionApprovalStatusByRequestIds(
  requestIds: number[],
): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  if (requestIds.length === 0) return result;
  const sourceIds = requestIds.map(id => `${id}:time_correction`);
  const rows = await query<{ source_id: string; approval_status: string }>(
    `SELECT source_id, approval_status
       FROM attendance_adjustments
      WHERE source_type = 'leave_request'
        AND source_id = ANY($1::text[])`,
    [sourceIds],
  );
  for (const row of rows) {
    const reqIdStr = String(row.source_id).split(':')[0];
    const reqId = Number(reqIdStr);
    if (Number.isFinite(reqId)) result.set(reqId, row.approval_status);
  }
  return result;
}

function broadcastPendingChanged(): void {
  const io = getIo();
  if (io) io.emit('leave_request_pending_changed');
}

/** Создание заявления (worker+) */
const create = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { request_type, start_date, end_date, reason, correction_date, correction_status, correction_hours, attachments } = req.body;
    if (!request_type || !start_date || !end_date) {
      res.status(400).json({ success: false, error: 'request_type, start_date, end_date обязательны' });
      return;
    }
    if (!LEAVE_REQUEST_TYPES.includes(request_type)) {
      res.status(400).json({ success: false, error: 'Недопустимый тип заявления' });
      return;
    }

    // Валидация для time_correction
    if (request_type === 'time_correction') {
      if (!correction_date || !correction_status) {
        res.status(400).json({ success: false, error: 'correction_date и correction_status обязательны для корректировки' });
        return;
      }
    }

    const attachmentIds = Array.isArray(attachments)
      ? attachments.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)
      : [];

    const employeeId = req.user.employee_id;
    if (!employeeId) {
      res.status(400).json({ success: false, error: 'У пользователя нет привязки к сотруднику' });
      return;
    }

    if (attachmentIds.length > 0) {
      const docs = await query<{ id: number; employee_id: number | null }>(
        `SELECT id, employee_id FROM documents WHERE id = ANY($1::bigint[])`,
        [attachmentIds],
      );
      const owned = docs.filter(d => Number(d.employee_id) === Number(employeeId));
      if (owned.length !== attachmentIds.length) {
        res.status(400).json({ success: false, error: 'Файл-вложение не принадлежит этому сотруднику' });
        return;
      }
    }

    // Многошаговая операция: insert заявления + связь с документами в одной TX.
    const data = await withTransaction(async (client) => {
      const insertCols: string[] = ['employee_id', 'request_type', 'start_date', 'end_date', 'reason'];
      const insertVals: unknown[] = [employeeId, request_type, start_date, end_date, reason || null];
      if (request_type === 'time_correction') {
        insertCols.push('correction_date', 'correction_status', 'correction_hours');
        insertVals.push(correction_date, correction_status, correction_hours ?? null);
      }
      const placeholders = insertVals.map((_, i) => `$${i + 1}`).join(', ');

      const insRes = await client.query(
        `INSERT INTO leave_requests (${insertCols.join(', ')})
         VALUES (${placeholders})
         RETURNING *`,
        insertVals,
      );
      const row = insRes.rows[0];
      if (!row) throw new Error('Failed to create leave_request');

      if (attachmentIds.length > 0) {
        const docIds = attachmentIds;
        const entityIds = attachmentIds.map(() => String(row.id));
        const entityTypes = attachmentIds.map(() => 'leave_request');
        const purposes = attachmentIds.map(() => 'leave_request_attachment');

        await client.query(
          `INSERT INTO document_links (document_id, entity_type, entity_id, purpose)
           SELECT u.document_id, u.entity_type, u.entity_id, u.purpose
             FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[])
               AS u(document_id, entity_type, entity_id, purpose)
           ON CONFLICT (document_id, entity_type, entity_id, purpose) DO NOTHING`,
          [docIds, entityTypes, entityIds, purposes],
        );

        await client.query(
          `UPDATE documents SET leave_request_id = $1
            WHERE id = ANY($2::bigint[]) AND leave_request_id IS NULL`,
          [row.id, docIds],
        );
      }

      return row;
    });

    broadcastPendingChanged();

    // Уведомляем руководителя отдела и админов (fire-and-forget)
    const label = LEAVE_TYPE_LABELS[request_type] || request_type;
    pushService.sendLeaveRequestNotification(employeeId, request_type, req.user.id)
      .then((recipientIds) => {
        const io = getIo();
        if (io) {
          for (const uid of recipientIds) {
            io.to(`user:${uid}`).emit('leave_request_notification', { requestType: request_type });
          }
        }
        // Сохраняем в БД
        notificationService.createMany(
          recipientIds.map(uid => ({
            userId: uid,
            type: 'leave_request',
            title: 'Новое заявление',
            body: `Сотрудник подал заявление: ${label}`,
            metadata: { requestType: request_type, employeeId },
          })),
        ).catch((e) => console.error('leave-request notification save error:', e));
      })
      .catch((e) => console.error('leave-request notify error:', e));

    res.json({ success: true, data });
  } catch (err) {
    console.error('leave-requests.create error:', err);
    res.status(500).json({ success: false, error: 'Ошибка создания заявления' });
  }
};

/** Мои заявления (worker) */
const getMy = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = req.user.employee_id;
    if (!employeeId) {
      res.json({ success: true, data: [] });
      return;
    }

    const data = await query<{ id: number; request_type: string; status: string; [k: string]: unknown }>(
      `SELECT * FROM leave_requests
        WHERE employee_id = $1
        ORDER BY created_at DESC`,
      [employeeId],
    );
    const correctionRequestIds = data
      .filter(r => r.request_type === 'time_correction' && r.status === 'approved')
      .map(r => Number(r.id))
      .filter(Number.isFinite);
    const correctionStatusMap = await loadCorrectionApprovalStatusByRequestIds(correctionRequestIds);
    const enriched = data.map(r => ({
      ...r,
      correction_approval_status: correctionStatusMap.get(Number(r.id)) ?? null,
    }));
    res.json({ success: true, data: enriched });
  } catch (err) {
    console.error('leave-requests.getMy error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения заявлений' });
  }
};

/** Заявления отдела (header) */
const getDepartment = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const departmentIds = await resolveManagedDepartmentIds(req);
    const directReportIds = req.user.employee_id
      ? await listDirectSubordinates(req.user.employee_id)
      : [];

    const departmentEmployees = await loadEmployeeIdsByDepartments(departmentIds);
    const departmentEmpIds = new Set(departmentEmployees.map(e => e.id));
    // Direct-reports считаем «непосредственными подчинёнными» только если они НЕ
    // покрыты subtree отделов — иначе показываем их в группе отдела (без дублей).
    const directOnlyIds = directReportIds.filter(id => !departmentEmpIds.has(id));

    const empIds = [...new Set([...departmentEmpIds, ...directOnlyIds])];
    if (empIds.length === 0) {
      res.json({ success: true, data: [] });
      return;
    }

    const data = await query<{ id: number; employee_id: number; request_type: string; status: string; [k: string]: unknown }>(
      `SELECT * FROM leave_requests
        WHERE employee_id = ANY($1::bigint[])
        ORDER BY created_at DESC`,
      [empIds],
    );

    const metaMap = await loadEmployeeMeta(empIds);
    const requestIds = data.map(r => Number(r.id)).filter(Number.isFinite);
    const attachmentsMap = await loadAttachmentsByLeaveRequestIds(requestIds);
    const correctionRequestIds = data
      .filter(r => r.request_type === 'time_correction' && r.status === 'approved')
      .map(r => Number(r.id))
      .filter(Number.isFinite);
    const correctionStatusMap = await loadCorrectionApprovalStatusByRequestIds(correctionRequestIds);
    const directOnlySet = new Set(directOnlyIds);

    const enriched = data.map(r => {
      const meta = metaMap.get(r.employee_id);
      return {
        ...r,
        employee_name: meta?.full_name ?? null,
        department_name: meta?.department_name ?? null,
        position_name: meta?.position_name ?? null,
        is_direct_subordinate: directOnlySet.has(Number(r.employee_id)),
        attachments: attachmentsMap.get(Number(r.id)) ?? [],
        correction_approval_status: correctionStatusMap.get(Number(r.id)) ?? null,
      };
    });
    res.json({ success: true, data: enriched });
  } catch (err) {
    console.error('leave-requests.getDepartment error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения заявлений отдела' });
  }
};

/** Все заявления организации (hr/admin) */
const getAll = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const scopedDepartmentId = await resolveScopedDepartmentId(req, null);
    const managedDepartmentIds = await resolveManagedDepartmentIds(req);
    const directReportIds = req.user.employee_id
      ? await listDirectSubordinates(req.user.employee_id)
      : [];

    const whereParts: string[] = [];
    const params: unknown[] = [];
    const addParam = (v: unknown): string => {
      params.push(v);
      return `$${params.length}`;
    };

    const status = req.query.status as string | undefined;
    if (status) {
      whereParts.push(`status = ${addParam(status)}`);
    }

    let directOnlySet = new Set<number>();
    if (managedDepartmentIds.length > 0 || directReportIds.length > 0) {
      const employees = scopedDepartmentId
        ? await loadEmployeeIdsByDepartment(scopedDepartmentId)
        : await loadEmployeeIdsByDepartments(managedDepartmentIds);
      const departmentEmpIds = new Set(employees.map(e => e.id));
      // При scopedDepartmentId (admin фильтрует один отдел) direct-reports не
      // расширяют выборку — это явный фильтр пользователя на отдел.
      const directOnlyIds = scopedDepartmentId
        ? []
        : directReportIds.filter(id => !departmentEmpIds.has(id));
      directOnlySet = new Set(directOnlyIds);
      const employeeIds = [...new Set([...departmentEmpIds, ...directOnlyIds])];
      if (employeeIds.length === 0) {
        res.json({ success: true, data: [] });
        return;
      }
      whereParts.push(`employee_id = ANY(${addParam(employeeIds)}::bigint[])`);
    }

    const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';

    const data = await query<{ id: number; employee_id: number; request_type: string; status: string; [k: string]: unknown }>(
      `SELECT * FROM leave_requests
        ${whereSql}
        ORDER BY created_at DESC`,
      params,
    );

    const empIds = [...new Set(data.map(r => r.employee_id))];
    const metaMap = await loadEmployeeMeta(empIds);
    const requestIds = data.map(r => Number(r.id)).filter(Number.isFinite);
    const attachmentsMap = await loadAttachmentsByLeaveRequestIds(requestIds);
    const correctionRequestIds = data
      .filter(r => r.request_type === 'time_correction' && r.status === 'approved')
      .map(r => Number(r.id))
      .filter(Number.isFinite);
    const correctionStatusMap = await loadCorrectionApprovalStatusByRequestIds(correctionRequestIds);

    const enriched = data.map(r => {
      const meta = metaMap.get(r.employee_id);
      return {
        ...r,
        employee_name: meta?.full_name ?? null,
        department_name: meta?.department_name ?? null,
        position_name: meta?.position_name ?? null,
        is_direct_subordinate: directOnlySet.has(Number(r.employee_id)),
        attachments: attachmentsMap.get(Number(r.id)) ?? [],
        correction_approval_status: correctionStatusMap.get(Number(r.id)) ?? null,
      };
    });
    res.json({ success: true, data: enriched });
  } catch (err) {
    console.error('leave-requests.getAll error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения заявлений' });
  }
};

/** Количество pending-заявлений в scope текущего юзера (для бейджа в меню) */
const pendingCount = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const accessible = await resolveAccessibleDepartmentIds(req);

    if (accessible === 'all') {
      const row = await queryOne<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM leave_requests WHERE status = 'pending'`,
      );
      res.json({ success: true, data: { count: Number(row?.count ?? 0) } });
      return;
    }

    const directReportIds = req.user.employee_id
      ? await listDirectSubordinates(req.user.employee_id)
      : [];

    if (accessible.length === 0 && directReportIds.length === 0) {
      res.json({ success: true, data: { count: 0 } });
      return;
    }

    const row = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM leave_requests lr
         JOIN employees e ON e.id = lr.employee_id
        WHERE lr.status = 'pending'
          AND (
                e.org_department_id = ANY($1::uuid[])
             OR lr.employee_id      = ANY($2::bigint[])
              )`,
      [accessible, directReportIds],
    );
    res.json({ success: true, data: { count: Number(row?.count ?? 0) } });
  } catch (err) {
    console.error('leave-requests.pendingCount error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения счётчика заявлений' });
  }
};

/** Получение одной заявки по ID (автор + ревьюер с правами) */
const getById = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    const request = await queryOne<{
      employee_id: number;
      reviewer_id: string | null;
      request_type: string;
      status: string;
      [k: string]: unknown;
    }>(
      `SELECT * FROM leave_requests WHERE id = $1`,
      [id],
    );

    if (!request) {
      res.status(404).json({ success: false, error: 'Заявление не найдено' });
      return;
    }

    const isOwner = request.employee_id === req.user.employee_id;
    const canReviewOthers = await canAccessEmployeeInScope(req, request.employee_id);
    if (!isOwner && !canReviewOthers) {
      res.status(403).json({ success: false, error: 'Нет доступа к заявке' });
      return;
    }

    // ФИО сотрудника
    const emp = await queryOne<{ id: number; full_name: string | null }>(
      `SELECT id, full_name FROM employees WHERE id = $1`,
      [request.employee_id],
    );

    // Данные ревьюера
    let reviewer: { id: string; full_name: string | null } | null = null;
    if (request.reviewer_id) {
      const reviewerProfile = await queryOne<{ id: string; full_name: string | null }>(
        `SELECT id, full_name FROM user_profiles WHERE id = $1`,
        [request.reviewer_id],
      );
      if (reviewerProfile) reviewer = reviewerProfile;
    }

    let correctionApprovalStatus: string | null = null;
    if (request.request_type === 'time_correction' && request.status === 'approved') {
      const statusMap = await loadCorrectionApprovalStatusByRequestIds([Number(id)]);
      correctionApprovalStatus = statusMap.get(Number(id)) ?? null;
    }

    res.json({
      success: true,
      data: {
        ...request,
        employee_name: emp?.full_name ?? null,
        reviewer,
        correction_approval_status: correctionApprovalStatus,
      },
    });
  } catch (err) {
    console.error('leave-requests.getById error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения заявки' });
  }
};

/** Одобрение заявления */
const approve = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { comment } = req.body;

    // Проверяем заявление
    const request = await queryOne<{
      id: number;
      employee_id: number;
      status: string;
      request_type: string;
      start_date: string;
      end_date: string;
      correction_date: string | null;
      correction_status: string | null;
      correction_hours: number | null;
      reason: string | null;
    }>(
      `SELECT * FROM leave_requests WHERE id = $1`,
      [id],
    );

    if (!request) {
      res.status(404).json({ success: false, error: 'Заявление не найдено' });
      return;
    }

    if (request.status !== 'pending') {
      res.status(400).json({ success: false, error: 'Заявление уже обработано' });
      return;
    }

    if (!(await canAccessEmployeeInScope(req, request.employee_id))) {
      res.status(403).json({ success: false, error: 'Нет доступа к заявлениям сотрудника' });
      return;
    }

    // Автором корректировки в табеле должен быть сам сотрудник-заявитель,
    // а не одобряющий руководитель. Резолвим его user_profiles.id по employee_id.
    const author = await queryOne<{ id: string }>(
      `SELECT id FROM user_profiles WHERE employee_id = $1 LIMIT 1`,
      [request.employee_id],
    );
    const authorUserId = author?.id ?? req.user.id;

    const nowIso = new Date().toISOString();
    const data = await queryOne(
      `UPDATE leave_requests SET
         status = 'approved',
         reviewer_id = $1,
         reviewed_at = $2,
         review_comment = $3,
         updated_at = $2
       WHERE id = $4
       RETURNING *`,
      [req.user.id, nowIso, comment || null, id],
    );

    // Создаём attendance adjustments как канонический источник ручных статусов
    const timesheetStatus = Object.prototype.hasOwnProperty.call(LEAVE_TO_TIMESHEET, request.request_type)
      ? LEAVE_TO_TIMESHEET[request.request_type as keyof typeof LEAVE_TO_TIMESHEET]
      : undefined;
    if (timesheetStatus) {
      const isWorkKind = request.request_type === 'work';
      // Для kind='work' разрешаем выход на смену в любой день, включая выходные/праздники.
      // Часы берём по графику дня; на выходной (work_hours=0) — fallback 8ч.
      // Статус 'work' не имеет fallback в attendance.service при null hours_override,
      // поэтому передаём явные часы (см. attendance.service.ts: ABSENCE_STATUSES_AS_WORKED не включает 'work').
      const schedule = isWorkKind
        ? await resolveSchedule(request.employee_id, null, request.start_date)
        : null;
      // Отсутствие сотрудника (отпуск/больничный/за свой счёт) идёт подряд календарно,
      // включая выходные. Для 'remote' (удалёнка) — это рабочая активность, выходные пропускаем.
      const skipWeekends = request.request_type === 'remote';
      const startDate = new Date(request.start_date);
      const endDate = new Date(request.end_date);

      for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
        const dayOfWeek = d.getDay();
        if (skipWeekends && (dayOfWeek === 0 || dayOfWeek === 6)) continue;

        const iso = d.toISOString().split('T')[0];
        const hoursOverride = isWorkKind
          ? (getScheduleForDate(schedule!, d).work_hours || 8)
          : null;
        const approvalStatus = isWorkKind
          ? await resolveAdjustmentApprovalStatus(request.employee_id, iso, timesheetStatus, hoursOverride)
          : undefined;

        await upsertAttendanceAdjustment({
          employee_id: request.employee_id,
          work_date: iso,
          status: timesheetStatus,
          hours_override: hoursOverride,
          source_type: 'leave_request',
          source_id: String(request.id),
          reason: `Approved leave request: ${request.request_type}`,
          created_by: authorUserId,
          ...(approvalStatus ? { approval_status: approvalStatus } : {}),
        });
      }
    }

    // Обработка корректировки табеля
    if (request.request_type === 'time_correction' && request.correction_date) {
      const correctionStatus: TimeStatus = isTimeStatus(request.correction_status) ? request.correction_status : 'work';
      // Если день — выходной по графику сотрудника И его отдел в whitelist
      // настройки «Согласование выходных дней», корректировка попадает в pending
      // и должна быть дополнительно одобрена админом на /approvals.
      const approvalStatus = await resolveAdjustmentApprovalStatus(
        request.employee_id,
        request.correction_date,
        correctionStatus,
        request.correction_hours ?? null,
      );
      await upsertAttendanceAdjustment({
        employee_id: request.employee_id,
        work_date: request.correction_date,
        status: correctionStatus,
        hours_override: request.correction_hours ?? null,
        source_type: 'leave_request',
        source_id: `${request.id}:time_correction`,
        reason: request.reason || 'Approved time correction request',
        created_by: authorUserId,
        approval_status: approvalStatus,
      });
    }

    broadcastPendingChanged();

    res.json({ success: true, data });
  } catch (err) {
    console.error('leave-requests.approve error:', err);
    res.status(500).json({ success: false, error: 'Ошибка одобрения заявления' });
  }
};

/** Отклонение заявления */
const reject = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { comment } = req.body;

    const request = await queryOne<{ id: number; employee_id: number; status: string }>(
      `SELECT * FROM leave_requests WHERE id = $1`,
      [id],
    );

    if (!request) {
      res.status(404).json({ success: false, error: 'Заявление не найдено' });
      return;
    }

    if (request.status !== 'pending') {
      res.status(400).json({ success: false, error: 'Заявление уже обработано' });
      return;
    }

    if (!(await canAccessEmployeeInScope(req, request.employee_id))) {
      res.status(403).json({ success: false, error: 'Нет доступа к заявлениям сотрудника' });
      return;
    }

    const nowIso = new Date().toISOString();
    const data = await queryOne(
      `UPDATE leave_requests SET
         status = 'rejected',
         reviewer_id = $1,
         reviewed_at = $2,
         review_comment = $3,
         updated_at = $2
       WHERE id = $4
       RETURNING *`,
      [req.user.id, nowIso, comment || null, id],
    );

    broadcastPendingChanged();

    res.json({ success: true, data });
  } catch (err) {
    console.error('leave-requests.reject error:', err);
    res.status(500).json({ success: false, error: 'Ошибка отклонения заявления' });
  }
};

/** Отмена заявления автором (статусы pending или approved). Для approved
 *  откатываем побочный эффект approve(): удаляем созданные строки
 *  attendance_adjustments в той же транзакции. */
const cancel = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    const request = await queryOne<{ id: number; employee_id: number; status: string }>(
      `SELECT * FROM leave_requests WHERE id = $1`,
      [id],
    );

    if (!request) {
      res.status(404).json({ success: false, error: 'Заявление не найдено' });
      return;
    }

    if (request.status !== 'pending' && request.status !== 'approved') {
      res.status(400).json({ success: false, error: 'Нельзя отменить отклонённое или уже отменённое заявление' });
      return;
    }

    if (request.employee_id !== req.user.employee_id) {
      res.status(403).json({ success: false, error: 'Можно отменить только своё заявление' });
      return;
    }

    const nowIso = new Date().toISOString();
    const data = await withTransaction(async (client) => {
      const updated = await client.query(
        `UPDATE leave_requests SET status = 'cancelled', updated_at = $1
          WHERE id = $2
          RETURNING *`,
        [nowIso, id],
      );
      if (request.status === 'approved') {
        await client.query(
          `DELETE FROM attendance_adjustments
             WHERE source_type = 'leave_request'
               AND source_id = ANY($1::text[])`,
          [[String(id), `${id}:time_correction`]],
        );
      }
      return updated.rows[0] ?? null;
    });

    broadcastPendingChanged();

    res.json({ success: true, data });
  } catch (err) {
    console.error('leave-requests.cancel error:', err);
    res.status(500).json({ success: false, error: 'Ошибка отмены заявления' });
  }
};

export const leaveRequestsController = {
  create,
  getMy,
  getById,
  getDepartment,
  getAll,
  pendingCount,
  approve,
  reject,
  cancel,
};
