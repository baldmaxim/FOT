import type { Response } from 'express';
import { supabase } from '../config/database.js';
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

const LEAVE_REQUEST_TYPES = ['vacation', 'sick_leave', 'remote', 'dayoff', 'certificate', 'time_correction'] as const;
const LEAVE_TYPE_LABELS: Record<string, string> = {
  vacation: 'Отпуск', sick_leave: 'Больничный', remote: 'Удалёнка',
  dayoff: 'Отгул', certificate: 'Справка', time_correction: 'Корректировка',
};
const LEAVE_TO_TIMESHEET: Record<'vacation' | 'sick_leave' | 'remote' | 'dayoff', TimeStatus> = {
  vacation: 'vacation',
  sick_leave: 'sick',
  remote: 'remote',
  dayoff: 'dayoff',
};

function isTimeStatus(value: unknown): value is TimeStatus {
  return ['work', 'vacation', 'dayoff', 'remote', 'unpaid', 'absent', 'sick', 'manual', 'educational_leave'].includes(String(value));
}

async function loadEmployeeIdsByDepartment(departmentId: string): Promise<Array<{ id: number; full_name: string | null }>> {
  const { data, error } = await supabase
    .from('employees')
    .select('id, full_name')
    .eq('org_department_id', departmentId)
    .eq('employment_status', 'active');

  if (error) {
    throw error;
  }

  return data || [];
}

async function loadEmployeeIdsByDepartments(
  departmentIds: string[],
): Promise<Array<{ id: number; full_name: string | null; org_department_id?: string | null }>> {
  if (departmentIds.length === 0) {
    return [];
  }

  const { data, error } = await supabase
    .from('employees')
    .select('id, full_name, org_department_id')
    .in('org_department_id', departmentIds)
    .eq('employment_status', 'active');

  if (error) {
    throw error;
  }

  return data || [];
}

/** Создание заявления (worker+) */
const ATTACHMENT_REQUIRED_TYPES = new Set(['remote', 'vacation']);

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

    if (ATTACHMENT_REQUIRED_TYPES.has(request_type) && attachmentIds.length === 0) {
      res.status(400).json({ success: false, error: 'Прикрепите файл-подтверждение к заявлению' });
      return;
    }

    const employeeId = req.user.employee_id;
    if (!employeeId) {
      res.status(400).json({ success: false, error: 'У пользователя нет привязки к сотруднику' });
      return;
    }

    if (attachmentIds.length > 0) {
      const { data: docs, error: docsErr } = await supabase
        .from('documents')
        .select('id, employee_id')
        .in('id', attachmentIds);
      if (docsErr) throw docsErr;
      const owned = (docs || []).filter((d) => Number(d.employee_id) === Number(employeeId));
      if (owned.length !== attachmentIds.length) {
        res.status(400).json({ success: false, error: 'Файл-вложение не принадлежит этому сотруднику' });
        return;
      }
    }

    const insertData: Record<string, unknown> = {
      employee_id: employeeId,
      request_type,
      start_date,
      end_date,
      reason: reason || null,
    };

    if (request_type === 'time_correction') {
      insertData.correction_date = correction_date;
      insertData.correction_status = correction_status;
      insertData.correction_hours = correction_hours ?? null;
    }

    const { data, error } = await supabase
      .from('leave_requests')
      .insert(insertData)
      .select()
      .single();

    if (error) throw error;

    if (attachmentIds.length > 0) {
      const links = attachmentIds.map((documentId) => ({
        document_id: documentId,
        entity_type: 'leave_request',
        entity_id: String(data.id),
        purpose: 'leave_request_attachment',
      }));
      const { error: linkError } = await supabase
        .from('document_links')
        .upsert(links, { onConflict: 'document_id,entity_type,entity_id,purpose' });
      if (linkError) {
        console.error('leave-requests.create: link attachments error', linkError);
      }
      await supabase
        .from('documents')
        .update({ leave_request_id: data.id })
        .in('id', attachmentIds)
        .is('leave_request_id', null);
    }

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

    const { data, error } = await supabase
      .from('leave_requests')
      .select('*')
      .eq('employee_id', employeeId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, data: data || [] });
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
    const empIds = (employees || []).map(e => e.id);
    if (empIds.length === 0) {
      res.json({ success: true, data: [] });
      return;
    }

    const nameMap = new Map((employees || []).map((e: { id: number; full_name: string | null }) => [e.id, e.full_name]));

    const { data, error } = await supabase
      .from('leave_requests')
      .select('*')
      .in('employee_id', empIds)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const enriched = (data || []).map(r => ({
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
    let query = supabase
      .from('leave_requests')
      .select('*')
      .order('created_at', { ascending: false });

    const status = req.query.status as string | undefined;
    if (status) {
      query = query.eq('status', status);
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
      query = query.in('employee_id', employeeIds);
    }

    const { data, error } = await query;
    if (error) throw error;

    // Подгружаем ФИО сотрудников
    const empIds = [...new Set((data || []).map(r => r.employee_id))];
    let nameMap = new Map<number, string | null>();
    if (empIds.length > 0) {
      const { data: emps } = await supabase
        .from('employees')
        .select('id, full_name')
        .in('id', empIds);
      nameMap = new Map((emps || []).map((e: { id: number; full_name: string | null }) => [e.id, e.full_name]));
    }

    const enriched = (data || []).map(r => ({
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

    const { data: request, error } = await supabase
      .from('leave_requests')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !request) {
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
    const { data: emp } = await supabase
      .from('employees')
      .select('id, full_name')
      .eq('id', request.employee_id)
      .maybeSingle();

    // Данные ревьюера
    let reviewer: { id: string; full_name: string | null } | null = null;
    if (request.reviewer_id) {
      const { data: reviewerProfile } = await supabase
        .from('user_profiles')
        .select('id, full_name')
        .eq('id', request.reviewer_id)
        .maybeSingle();
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
    const { data: request, error: fetchErr } = await supabase
      .from('leave_requests')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchErr || !request) {
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

    const { data, error } = await supabase
      .from('leave_requests')
      .update({
        status: 'approved',
        reviewer_id: req.user.id,
        reviewed_at: new Date().toISOString(),
        review_comment: comment || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

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

    const { data: request, error: fetchErr } = await supabase
      .from('leave_requests')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchErr || !request) {
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

    const { data, error } = await supabase
      .from('leave_requests')
      .update({
        status: 'rejected',
        reviewer_id: req.user.id,
        reviewed_at: new Date().toISOString(),
        review_comment: comment || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
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

    const { data: request, error: fetchErr } = await supabase
      .from('leave_requests')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchErr || !request) {
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

    const { data, error } = await supabase
      .from('leave_requests')
      .update({
        status: 'cancelled',
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
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
