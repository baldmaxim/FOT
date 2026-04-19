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

const MEMO_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
type MemoStatus = typeof MEMO_STATUSES[number];

const MAX_TITLE_LEN = 200;
const MAX_BODY_LEN = 5000;

async function loadEmployeeIdsByDepartments(departmentIds: string[]): Promise<Array<{ id: number; full_name: string | null; org_department_id?: string | null }>> {
  if (departmentIds.length === 0) return [];

  const { data, error } = await supabase
    .from('employees')
    .select('id, full_name, org_department_id')
    .in('org_department_id', departmentIds)
    .eq('employment_status', 'active');

  if (error) throw error;
  return data || [];
}

async function loadEmployeeIdsByDepartment(departmentId: string): Promise<Array<{ id: number; full_name: string | null }>> {
  const { data, error } = await supabase
    .from('employees')
    .select('id, full_name')
    .eq('org_department_id', departmentId)
    .eq('employment_status', 'active');

  if (error) throw error;
  return data || [];
}

async function findEmployeeUserId(employeeId: number): Promise<string | null> {
  const { data } = await supabase
    .from('user_profiles')
    .select('id')
    .eq('employee_id', employeeId)
    .maybeSingle();
  return (data?.id as string) || null;
}

async function findSupervisorUserId(employeeId: number): Promise<string | null> {
  const { data } = await supabase
    .from('user_profiles')
    .select('supervisor_id')
    .eq('employee_id', employeeId)
    .maybeSingle();
  return (data?.supervisor_id as string) || null;
}

/** Создание служебной записки (worker+) */
const create = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { title, body } = req.body;

    if (typeof title !== 'string' || title.trim().length === 0) {
      res.status(400).json({ success: false, error: 'title обязателен' });
      return;
    }
    if (typeof body !== 'string' || body.trim().length === 0) {
      res.status(400).json({ success: false, error: 'body обязателен' });
      return;
    }
    if (title.length > MAX_TITLE_LEN || body.length > MAX_BODY_LEN) {
      res.status(400).json({ success: false, error: 'Слишком длинный текст' });
      return;
    }

    const employeeId = req.user.employee_id;
    if (!employeeId) {
      res.status(400).json({ success: false, error: 'У пользователя нет привязки к сотруднику' });
      return;
    }

    const { data, error } = await supabase
      .from('official_memos')
      .insert({
        employee_id: employeeId,
        title: title.trim(),
        body: body.trim(),
      })
      .select()
      .single();

    if (error) throw error;

    const supervisorId = await findSupervisorUserId(employeeId);
    const recipientIds = supervisorId && supervisorId !== req.user.id ? [supervisorId] : [];

    if (recipientIds.length > 0) {
      const notifTitle = 'Новая служебная записка';
      const notifBody = `Сотрудник подал служебную записку: ${title.trim()}`;
      const path = '/leave-requests';
      notificationService.createMany(recipientIds.map(userId => ({
        userId,
        type: 'official_memo',
        title: notifTitle,
        body: notifBody,
        metadata: { memoId: data.id, employeeId, path },
      }))).catch(e => console.error('official-memo notification save error:', e));

      pushService.sendGenericNotification(recipientIds, notifTitle, notifBody, { path, memoId: data.id })
        .catch(e => console.error('official-memo push error:', e));

      const io = getIo();
      if (io) {
        for (const uid of recipientIds) {
          io.to(`user:${uid}`).emit('official_memo_notification', { memoId: data.id });
        }
      }
    }

    res.json({ success: true, data });
  } catch (err) {
    console.error('official-memos.create error:', err);
    res.status(500).json({ success: false, error: 'Ошибка создания служебной записки' });
  }
};

/** Мои служебные записки (worker) */
const getMy = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = req.user.employee_id;
    if (!employeeId) {
      res.json({ success: true, data: [] });
      return;
    }

    const { data, error } = await supabase
      .from('official_memos')
      .select('*')
      .eq('employee_id', employeeId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err) {
    console.error('official-memos.getMy error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения служебных записок' });
  }
};

/** Все записки организации с учётом скоупа (header/hr/admin) */
const getAll = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const scopedDepartmentId = await resolveScopedDepartmentId(req, null);
    const managedDepartmentIds = await resolveManagedDepartmentIds(req);

    let query = supabase
      .from('official_memos')
      .select('*')
      .order('created_at', { ascending: false });

    const status = req.query.status;
    if (typeof status === 'string' && MEMO_STATUSES.includes(status as MemoStatus)) {
      query = query.eq('status', status);
    }

    if (managedDepartmentIds.length > 0) {
      const employees = scopedDepartmentId
        ? await loadEmployeeIdsByDepartment(scopedDepartmentId)
        : await loadEmployeeIdsByDepartments(managedDepartmentIds);
      const employeeIds = employees.map(e => e.id);
      if (employeeIds.length === 0) {
        res.json({ success: true, data: [] });
        return;
      }
      query = query.in('employee_id', employeeIds);
    }

    const { data, error } = await query;
    if (error) throw error;

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
    console.error('official-memos.getAll error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения служебных записок' });
  }
};

async function notifyAuthor(memoId: number, employeeId: number, status: MemoStatus, title: string, comment: string | null): Promise<void> {
  const authorUserId = await findEmployeeUserId(employeeId);
  if (!authorUserId) return;

  const labelByStatus: Record<MemoStatus, string> = {
    pending: 'в ожидании',
    approved: 'одобрена',
    rejected: 'отклонена',
    cancelled: 'отменена',
  };
  const label = labelByStatus[status];
  const notifTitle = `Служебная записка ${label}`;
  const notifBody = comment ? `«${title}» — ${label}. Комментарий: ${comment}` : `«${title}» — ${label}.`;
  const path = '/employee';

  notificationService.createMany([{
    userId: authorUserId,
    type: 'official_memo_decision',
    title: notifTitle,
    body: notifBody,
    metadata: { memoId, path, status },
  }]).catch(e => console.error('official-memo author notify save error:', e));

  pushService.sendGenericNotification([authorUserId], notifTitle, notifBody, { path, memoId, status })
    .catch(e => console.error('official-memo author push error:', e));

  const io = getIo();
  if (io) {
    io.to(`user:${authorUserId}`).emit('official_memo_decision', { memoId, status });
  }
}

async function transition(req: AuthenticatedRequest, res: Response, nextStatus: 'approved' | 'rejected'): Promise<void> {
  try {
    const { id } = req.params;
    const { comment } = req.body;

    const { data: memo, error: fetchErr } = await supabase
      .from('official_memos')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchErr || !memo) {
      res.status(404).json({ success: false, error: 'Служебная записка не найдена' });
      return;
    }

    if (memo.status !== 'pending') {
      res.status(400).json({ success: false, error: 'Запись уже обработана' });
      return;
    }

    if (!(await canAccessEmployeeInScope(req, memo.employee_id))) {
      res.status(403).json({ success: false, error: 'Нет доступа к записке сотрудника' });
      return;
    }

    const { data, error } = await supabase
      .from('official_memos')
      .update({
        status: nextStatus,
        reviewer_id: req.user.id,
        reviewed_at: new Date().toISOString(),
        review_comment: typeof comment === 'string' ? comment : null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    void notifyAuthor(Number(data.id), Number(data.employee_id), nextStatus, String(data.title || ''), typeof comment === 'string' ? comment : null);

    res.json({ success: true, data });
  } catch (err) {
    console.error('official-memos.transition error:', err);
    res.status(500).json({ success: false, error: 'Ошибка обновления служебной записки' });
  }
}

const approve = (req: AuthenticatedRequest, res: Response) => transition(req, res, 'approved');
const reject = (req: AuthenticatedRequest, res: Response) => transition(req, res, 'rejected');

/** Отмена своей записки (worker) */
const cancel = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    const { data: memo, error: fetchErr } = await supabase
      .from('official_memos')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchErr || !memo) {
      res.status(404).json({ success: false, error: 'Служебная записка не найдена' });
      return;
    }

    if (memo.status !== 'pending') {
      res.status(400).json({ success: false, error: 'Можно отменить только ожидающую записку' });
      return;
    }

    if (memo.employee_id !== req.user.employee_id) {
      res.status(403).json({ success: false, error: 'Можно отменить только свою записку' });
      return;
    }

    const { data, error } = await supabase
      .from('official_memos')
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
    console.error('official-memos.cancel error:', err);
    res.status(500).json({ success: false, error: 'Ошибка отмены служебной записки' });
  }
};

export const officialMemosController = {
  create,
  getMy,
  getAll,
  approve,
  reject,
  cancel,
};
