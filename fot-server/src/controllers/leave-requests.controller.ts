import type { Response } from 'express';
import { query, queryOne, withTransaction } from '../config/postgres.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { pushService } from '../services/push.service.js';
import { notificationService } from '../services/notification.service.js';
import { getIo } from '../socket/io-instance.js';
import {
  canAccessEmployeeInScope,
  resolveManagedDepartmentIds,
  resolveScopedDepartmentId,
} from '../services/data-scope.service.js';
import { upsertAttendanceAdjustment } from '../services/attendance.service.js';
import type { TimeStatus } from '../types/index.js';

const LEAVE_REQUEST_TYPES = ['vacation', 'sick_leave', 'remote', 'certificate', 'time_correction'] as const;
const LEAVE_TYPE_LABELS: Record<string, string> = {
  vacation: 'Отпуск', sick_leave: 'Больничный', remote: 'Удалёнка',
  certificate: 'Справка', time_correction: 'Корректировка',
};
const LEAVE_TO_TIMESHEET: Record<'vacation' | 'sick_leave' | 'remote', TimeStatus> = {
  vacation: 'vacation',
  sick_leave: 'sick',
  remote: 'remote',
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

    const data = await query(
      `SELECT * FROM leave_requests
        WHERE employee_id = $1
        ORDER BY created_at DESC`,
      [employeeId],
    );
    res.json({ success: true, data });
  } catch (err) {
    console.error('leave-requests.getMy error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения заявлений' });
  }
};

/** Заявления отдела (header) */
const getDepartment = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const departmentIds = await resolveManagedDepartmentIds(req);
    if (departmentIds.length === 0) {
      res.json({ success: true, data: [] });
      return;
    }

    const employees = await loadEmployeeIdsByDepartments(departmentIds);
    const empIds = employees.map(e => e.id);
    if (empIds.length === 0) {
      res.json({ success: true, data: [] });
      return;
    }

    const nameMap = new Map(employees.map(e => [e.id, e.full_name]));

    const data = await query<{ employee_id: number; [k: string]: unknown }>(
      `SELECT * FROM leave_requests
        WHERE employee_id = ANY($1::bigint[])
        ORDER BY created_at DESC`,
      [empIds],
    );

    const enriched = data.map(r => ({
      ...r,
      employee_name: nameMap.get(r.employee_id) || null,
    }));
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

    if (managedDepartmentIds.length > 0) {
      const employees = scopedDepartmentId
        ? await loadEmployeeIdsByDepartment(scopedDepartmentId)
        : await loadEmployeeIdsByDepartments(managedDepartmentIds);
      const employeeIds = employees.map(employee => employee.id);
      if (employeeIds.length === 0) {
        res.json({ success: true, data: [] });
        return;
      }
      whereParts.push(`employee_id = ANY(${addParam(employeeIds)}::bigint[])`);
    }

    const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';

    const data = await query<{ employee_id: number; [k: string]: unknown }>(
      `SELECT * FROM leave_requests
        ${whereSql}
        ORDER BY created_at DESC`,
      params,
    );

    // Подгружаем ФИО сотрудников
    const empIds = [...new Set(data.map(r => r.employee_id))];
    let nameMap = new Map<number, string | null>();
    if (empIds.length > 0) {
      const emps = await query<{ id: number; full_name: string | null }>(
        `SELECT id, full_name FROM employees WHERE id = ANY($1::bigint[])`,
        [empIds],
      );
      nameMap = new Map(emps.map(e => [e.id, e.full_name]));
    }

    const enriched = data.map(r => ({
      ...r,
      employee_name: nameMap.get(r.employee_id) || null,
    }));
    res.json({ success: true, data: enriched });
  } catch (err) {
    console.error('leave-requests.getAll error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения заявлений' });
  }
};

/** Получение одной заявки по ID (автор + ревьюер с правами) */
const getById = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    const request = await queryOne<{
      employee_id: number;
      reviewer_id: string | null;
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

    res.json({
      success: true,
      data: {
        ...request,
        employee_name: emp?.full_name ?? null,
        reviewer,
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
      const startDate = new Date(request.start_date);
      const endDate = new Date(request.end_date);

      for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
        const dayOfWeek = d.getDay();
        if (dayOfWeek === 0 || dayOfWeek === 6) continue; // Пропускаем выходные

        await upsertAttendanceAdjustment({
          employee_id: request.employee_id,
          work_date: d.toISOString().split('T')[0],
          status: timesheetStatus,
          hours_override: null,
          source_type: 'leave_request',
          source_id: String(request.id),
          reason: `Approved leave request: ${request.request_type}`,
          created_by: req.user.id,
        });
      }
    }

    // Обработка корректировки табеля
    if (request.request_type === 'time_correction' && request.correction_date) {
      const correctionStatus: TimeStatus = isTimeStatus(request.correction_status) ? request.correction_status : 'work';
      await upsertAttendanceAdjustment({
        employee_id: request.employee_id,
        work_date: request.correction_date,
        status: correctionStatus,
        hours_override: request.correction_hours ?? null,
        source_type: 'leave_request',
        source_id: `${request.id}:time_correction`,
        reason: request.reason || 'Approved time correction request',
        created_by: req.user.id,
      });
    }

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

    res.json({ success: true, data });
  } catch (err) {
    console.error('leave-requests.reject error:', err);
    res.status(500).json({ success: false, error: 'Ошибка отклонения заявления' });
  }
};

/** Отмена заявления (worker отменяет своё pending-заявление) */
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

    if (request.status !== 'pending') {
      res.status(400).json({ success: false, error: 'Можно отменить только ожидающее заявление' });
      return;
    }

    // Только автор может отменить
    if (request.employee_id !== req.user.employee_id) {
      res.status(403).json({ success: false, error: 'Можно отменить только своё заявление' });
      return;
    }

    const nowIso = new Date().toISOString();
    const data = await queryOne(
      `UPDATE leave_requests SET status = 'cancelled', updated_at = $1
        WHERE id = $2
        RETURNING *`,
      [nowIso, id],
    );

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
  approve,
  reject,
  cancel,
};
