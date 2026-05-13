import type { Response } from 'express';
import { query, queryOne } from '../config/postgres.js';
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

  return query<{ id: number; full_name: string | null; org_department_id: string | null }>(
    `SELECT id, full_name, org_department_id
       FROM employees
      WHERE org_department_id = ANY($1::uuid[])
        AND employment_status = 'active'`,
    [departmentIds],
  );
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

async function findEmployeeUserId(employeeId: number): Promise<string | null> {
  const row = await queryOne<{ id: string }>(
    `SELECT id FROM user_profiles WHERE employee_id = $1`,
    [employeeId],
  );
  return row?.id ?? null;
}

async function findSupervisorUserId(employeeId: number): Promise<string | null> {
  const row = await queryOne<{ supervisor_id: string | null }>(
    `SELECT supervisor_id FROM user_profiles WHERE employee_id = $1`,
    [employeeId],
  );
  return row?.supervisor_id ?? null;
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

    const data = await queryOne<{ id: number; employee_id: number; title: string; body: string; status: string; created_at: string }>(
      `INSERT INTO official_memos (employee_id, title, body)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [employeeId, title.trim(), body.trim()],
    );

    if (!data) {
      throw new Error('Failed to create memo');
    }

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

    const data = await query(
      `SELECT * FROM official_memos
        WHERE employee_id = $1
        ORDER BY created_at DESC`,
      [employeeId],
    );
    res.json({ success: true, data });
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

    const whereParts: string[] = [];
    const params: unknown[] = [];
    const addParam = (v: unknown): string => {
      params.push(v);
      return `$${params.length}`;
    };

    const status = req.query.status;
    if (typeof status === 'string' && MEMO_STATUSES.includes(status as MemoStatus)) {
      whereParts.push(`status = ${addParam(status)}`);
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
      whereParts.push(`employee_id = ANY(${addParam(employeeIds)}::bigint[])`);
    }

    const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';
    const data = await query<{ id: number; employee_id: number; [k: string]: unknown }>(
      `SELECT * FROM official_memos
        ${whereSql}
        ORDER BY created_at DESC`,
      params,
    );

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

    const memo = await queryOne<{ id: number; employee_id: number; status: string; title: string | null }>(
      `SELECT * FROM official_memos WHERE id = $1`,
      [id],
    );

    if (!memo) {
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

    const nowIso = new Date().toISOString();
    const reviewComment = typeof req.body?.comment === 'string' ? req.body.comment : null;

    const data = await queryOne<{ id: number; employee_id: number; title: string | null }>(
      `UPDATE official_memos SET
         status = $1,
         reviewer_id = $2,
         reviewed_at = $3,
         review_comment = $4,
         updated_at = $3
       WHERE id = $5
       RETURNING *`,
      [nextStatus, req.user.id, nowIso, reviewComment, id],
    );

    if (!data) {
      throw new Error('Failed to update memo');
    }

    void notifyAuthor(Number(data.id), Number(data.employee_id), nextStatus, String(data.title || ''), reviewComment);

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

    const memo = await queryOne<{ id: number; employee_id: number; status: string }>(
      `SELECT * FROM official_memos WHERE id = $1`,
      [id],
    );

    if (!memo) {
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

    const nowIso = new Date().toISOString();
    const data = await queryOne(
      `UPDATE official_memos SET status = 'cancelled', updated_at = $1
        WHERE id = $2
        RETURNING *`,
      [nowIso, id],
    );

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
