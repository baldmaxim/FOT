import type { Response } from 'express';
import { z } from 'zod';
import { query, queryOne, execute, withTransaction } from '../config/postgres.js';
import { r2Service } from '../services/r2.service.js';
import { hasPageView } from '../services/access-control.service.js';
import {
  isHiringManagerByEmployee,
  isRecruiter,
  getActiveAssigneeEmployeeIds,
  getHiringManagerEmployeeIds,
  isHiringRequesterRole,
} from '../services/hiring-access.service.js';
import { getUserIdsByEmployeeIds } from '../services/recipients.service.js';
import { notificationService } from '../services/notification.service.js';
import { pushService } from '../services/push.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

type MulterRequest = AuthenticatedRequest & { file?: { originalname: string; buffer: Buffer; size: number; mimetype: string } };

const FUNNEL_STAGES = ['new', 'in_progress', 'interview', 'offer', 'closed', 'cancelled'] as const;
const CANDIDATE_STATUSES = ['new', 'screening', 'interview', 'offer', 'accepted', 'reserve', 'reject'] as const;

// ===================== Права =====================
async function canManageHiring(req: AuthenticatedRequest): Promise<boolean> {
  if (req.user.is_admin) return true;
  return isHiringManagerByEmployee(req.user.employee_id);
}

async function canWorkRequest(req: AuthenticatedRequest, requestId: number): Promise<boolean> {
  if (await canManageHiring(req)) return true;
  if (!req.user.employee_id) return false;
  const ids = await getActiveAssigneeEmployeeIds(requestId);
  return ids.includes(req.user.employee_id);
}

async function canCreateHiring(req: AuthenticatedRequest): Promise<boolean> {
  if (req.user.is_admin) return true;
  // Руководитель отдела / руководитель строительства подают заявки по роли.
  if (isHiringRequesterRole(req.user.role_code)) return true;
  if (await isHiringManagerByEmployee(req.user.employee_id)) return true;
  return hasPageView(req.user.role_code, '/staff-control/hiring');
}

// ===================== Helpers =====================
const parseId = (raw: string): number | null => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};

async function logEvent(
  requestId: number,
  userId: string,
  kind: string,
  data: { body?: string | null; link_url?: string | null; from_stage?: string | null; to_stage?: string | null } = {},
): Promise<void> {
  await execute(
    `INSERT INTO hiring_request_events (request_id, author_user_id, kind, body, link_url, from_stage, to_stage)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [requestId, userId, kind, data.body ?? null, data.link_url ?? null, data.from_stage ?? null, data.to_stage ?? null],
  );
}

interface AssigneeView { employee_id: number; full_name: string | null; is_primary: boolean }

async function loadAssignees(requestIds: number[]): Promise<Map<number, AssigneeView[]>> {
  const map = new Map<number, AssigneeView[]>();
  if (requestIds.length === 0) return map;
  const rows = await query<{ request_id: number; employee_id: number; full_name: string | null; is_primary: boolean }>(
    `SELECT a.request_id, a.employee_id, e.full_name, a.is_primary
       FROM hiring_request_assignees a
       LEFT JOIN employees e ON e.id = a.employee_id
      WHERE a.request_id = ANY($1::bigint[]) AND a.is_active = TRUE
      ORDER BY a.is_primary DESC, a.assigned_at ASC`,
    [requestIds],
  );
  for (const r of rows) {
    const list = map.get(Number(r.request_id)) ?? [];
    list.push({ employee_id: Number(r.employee_id), full_name: r.full_name, is_primary: r.is_primary });
    map.set(Number(r.request_id), list);
  }
  return map;
}

// ===================== Заявки =====================
const list = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const manage = await canManageHiring(req);
  const empId = req.user.employee_id;
  const can_create = await canCreateHiring(req);
  const is_recruiter = await isRecruiter(empId);

  const params: unknown[] = [];
  let where = '';
  if (!manage) {
    // свои (автор) ∪ назначенные мне
    params.push(empId ?? -1);
    where = `WHERE (r.author_employee_id = $1
                 OR EXISTS (SELECT 1 FROM hiring_request_assignees a
                             WHERE a.request_id = r.id AND a.is_active = TRUE AND a.employee_id = $1))`;
  }

  const rows = await query<Record<string, unknown>>(
    `SELECT r.*,
            EXTRACT(DAY FROM (COALESCE(r.closed_at, NOW()) - COALESCE(r.reactivated_at, r.created_at)))::int AS days_in_work,
            (SELECT COUNT(*) FROM hiring_candidates c WHERE c.request_id = r.id)::int AS candidate_count,
            (SELECT COUNT(*) FROM hiring_candidates c WHERE c.request_id = r.id AND c.applicant_approved)::int AS approved_count
       FROM hiring_requests r
       ${where}
      ORDER BY r.is_urgent DESC, r.created_at DESC`,
    params,
  );

  const ids = rows.map(r => Number(r.id));
  const assignees = await loadAssignees(ids);
  const data = rows.map(r => ({ ...r, assignees: assignees.get(Number(r.id)) ?? [] }));

  res.json({ success: true, data, meta: { can_manage: manage, is_recruiter, can_create } });
};

const getById = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ success: false, error: 'Некорректный id' }); return; }

  const request = await queryOne<Record<string, unknown>>(
    `SELECT r.*,
            EXTRACT(DAY FROM (COALESCE(r.closed_at, NOW()) - COALESCE(r.reactivated_at, r.created_at)))::int AS days_in_work
       FROM hiring_requests r WHERE r.id = $1`,
    [id],
  );
  if (!request) { res.status(404).json({ success: false, error: 'Заявка не найдена' }); return; }

  // видимость
  const manage = await canManageHiring(req);
  if (!manage) {
    const isAuthor = req.user.employee_id != null && Number(request.author_employee_id) === req.user.employee_id;
    const isAssignee = req.user.employee_id != null
      && (await getActiveAssigneeEmployeeIds(id)).includes(req.user.employee_id);
    if (!isAuthor && !isAssignee) { res.status(403).json({ success: false, error: 'Нет доступа к заявке' }); return; }
  }

  const [assignees, candidates, files, events] = await Promise.all([
    loadAssignees([id]),
    query(`SELECT * FROM hiring_candidates WHERE request_id = $1 ORDER BY applicant_approved DESC, created_at ASC`, [id]),
    query(`SELECT id, file_name, file_size, mime_type, candidate_id, created_at FROM hiring_request_files WHERE request_id = $1 ORDER BY created_at DESC`, [id]),
    query(
      `SELECT ev.id, ev.kind, ev.body, ev.link_url, ev.from_stage, ev.to_stage, ev.created_at, u.full_name AS author_name
         FROM hiring_request_events ev
         LEFT JOIN user_profiles u ON u.id = ev.author_user_id
        WHERE ev.request_id = $1 ORDER BY ev.created_at ASC`,
      [id],
    ),
  ]);

  res.json({
    success: true,
    data: { ...request, assignees: assignees.get(id) ?? [], candidates, files, events, can_manage: manage },
  });
};

const createSchema = z.object({
  position_title: z.string().trim().min(1),
  customer_name: z.string().trim().optional().nullable(),
  headcount: z.coerce.number().int().min(1).default(1),
  start_work_date: z.string().optional().nullable(),
  deadline: z.string().optional().nullable(),
  duties: z.string().optional().nullable(),
  experience: z.string().optional().nullable(),
  requirements: z.string().optional().nullable(),
  software: z.string().optional().nullable(),
  gender: z.enum(['any', 'male', 'female']).optional().nullable(),
  salary_level: z.string().optional().nullable(),
  hh_vacancy_url: z.string().optional().nullable(),
  department_id: z.string().uuid().optional().nullable(),
});

const create = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  if (!(await canCreateHiring(req))) { res.status(403).json({ success: false, error: 'Нет прав на создание заявки' }); return; }
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, error: 'position_title обязателен' }); return; }
  const b = parsed.data;

  // Заказчик = ФИО автора (заполняется автоматически, не вводится в форме).
  // Отдел автора — для аналитики. Грузим строку сотрудника при наличии employee_id.
  let departmentId: string | null = b.department_id ?? null;
  let authorName: string | null = null;
  if (req.user.employee_id) {
    const emp = await queryOne<{ org_department_id: string | null; full_name: string | null }>(
      `SELECT org_department_id, full_name FROM employees WHERE id = $1`, [req.user.employee_id],
    );
    if (!departmentId) departmentId = emp?.org_department_id ?? null;
    authorName = emp?.full_name ?? null;
  }
  // Дата создания заявки = «дата поступления в работу» (если фронт не прислал — сегодня).
  const startWorkDate = b.start_work_date || null;

  const row = await queryOne<{ id: number }>(
    `INSERT INTO hiring_requests
       (author_user_id, author_employee_id, department_id, position_title, customer_name, headcount,
        start_work_date, deadline, duties, experience, requirements, software, gender, salary_level, hh_vacancy_url)
     VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7::date, CURRENT_DATE) ,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING id`,
    [
      req.user.id, req.user.employee_id ?? null, departmentId, b.position_title, authorName, b.headcount,
      startWorkDate, b.deadline || null, b.duties ?? null, b.experience ?? null, b.requirements ?? null,
      b.software ?? null, b.gender ?? null, b.salary_level ?? null, null,
    ],
  );
  const requestId = row?.id;
  // Оповещение руководителя(ей) отдела кадров о новой заявке — fire-and-forget,
  // сбой уведомления не должен ломать создание заявки.
  if (requestId) {
    void (async () => {
      const mgrEmpIds = (await getHiringManagerEmployeeIds())
        .filter(eid => eid !== req.user.employee_id); // самого автора не уведомляем
      if (mgrEmpIds.length === 0) return;
      const userIds = await getUserIdsByEmployeeIds(mgrEmpIds);
      if (userIds.length === 0) return;

      const title = 'Новая заявка на подбор';
      const body = `${authorName ?? 'Сотрудник'} подал заявку: ${b.position_title}`
        + (b.headcount && b.headcount > 1 ? ` (${b.headcount} чел.)` : '');
      const path = '/staff-control?tab=hiring';

      await notificationService.createMany(userIds.map(userId => ({
        userId,
        type: 'hiring_request',
        title,
        body,
        metadata: { requestId, path },
      })));
      await pushService.sendGenericNotification(userIds, title, body, { path, requestId });
    })().catch(e => console.error('hiring-request notify error:', e));
  }

  res.status(201).json({ success: true, data: { id: requestId } });
};

const updateFields = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ success: false, error: 'Некорректный id' }); return; }
  const request = await queryOne<{ author_employee_id: number | null; stage: string }>(
    `SELECT author_employee_id, stage FROM hiring_requests WHERE id = $1`, [id],
  );
  if (!request) { res.status(404).json({ success: false, error: 'Заявка не найдена' }); return; }
  const manage = await canManageHiring(req);
  const isAuthor = req.user.employee_id != null && request.author_employee_id === req.user.employee_id;
  const isWork = await canWorkRequest(req, id); // manage ∨ активный ответственный (рекрутер)
  const canAuthorEdit = isAuthor && ['new', 'rework'].includes(request.stage);
  if (!manage && !canAuthorEdit && !isWork) {
    res.status(403).json({ success: false, error: 'Редактирование недоступно' }); return;
  }
  const parsed = createSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, error: 'Некорректные поля' }); return; }
  // Роль-зависимый whitelist полей:
  //  - manage: всё;
  //  - автор (new/rework): поля заявки (без авто-полей customer_name/start_work_date и рекрутерского hh_vacancy_url);
  //  - ответственный-рекрутер: только ссылка на вакансию.
  const MANAGE_FIELDS = ['position_title', 'customer_name', 'headcount', 'start_work_date', 'deadline', 'duties', 'experience', 'requirements', 'software', 'gender', 'salary_level', 'hh_vacancy_url'] as const;
  const AUTHOR_FIELDS = ['position_title', 'headcount', 'deadline', 'duties', 'experience', 'requirements', 'software', 'gender', 'salary_level'] as const;
  const allowed: readonly string[] = manage
    ? MANAGE_FIELDS
    : canAuthorEdit
      ? AUTHOR_FIELDS
      : ['hh_vacancy_url'];
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const key of allowed) {
    if (key in parsed.data) {
      params.push((parsed.data as Record<string, unknown>)[key] ?? null);
      sets.push(`${key} = $${params.length}`);
    }
  }
  if (sets.length === 0) { res.json({ success: true }); return; }
  params.push(id);
  await execute(`UPDATE hiring_requests SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length}`, params);
  res.json({ success: true });
};

const changeStage = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ success: false, error: 'Некорректный id' }); return; }
  const stage = String(req.body?.stage || '');
  if (!FUNNEL_STAGES.includes(stage as typeof FUNNEL_STAGES[number])) {
    res.status(400).json({ success: false, error: 'Недопустимый этап (rework — только через возврат на доработку)' }); return;
  }
  if (!(await canWorkRequest(req, id))) { res.status(403).json({ success: false, error: 'Нет прав на смену этапа' }); return; }
  const cur = await queryOne<{ stage: string }>(`SELECT stage FROM hiring_requests WHERE id = $1`, [id]);
  if (!cur) { res.status(404).json({ success: false, error: 'Заявка не найдена' }); return; }
  const closedAt = stage === 'closed' ? 'NOW()' : 'NULL';
  await execute(
    `UPDATE hiring_requests SET stage = $1, closed_at = ${closedAt}, updated_at = NOW() WHERE id = $2`,
    [stage, id],
  );
  await logEvent(id, req.user.id, 'stage_change', { from_stage: cur.stage, to_stage: stage });
  res.json({ success: true });
};

const reject = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ success: false, error: 'Некорректный id' }); return; }
  const reason = String(req.body?.reason || '').trim();
  if (!reason) { res.status(400).json({ success: false, error: 'Причина обязательна' }); return; }
  if (!(await canManageHiring(req))) { res.status(403).json({ success: false, error: 'Доступно руководителю отдела кадров' }); return; }
  const cur = await queryOne<{ stage: string }>(`SELECT stage FROM hiring_requests WHERE id = $1`, [id]);
  if (!cur) { res.status(404).json({ success: false, error: 'Заявка не найдена' }); return; }
  await execute(`UPDATE hiring_requests SET stage = 'rework', rework_reason = $1, updated_at = NOW() WHERE id = $2`, [reason, id]);
  await logEvent(id, req.user.id, 'rework', { body: reason, from_stage: cur.stage, to_stage: 'rework' });
  res.json({ success: true });
};

const resubmit = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ success: false, error: 'Некорректный id' }); return; }
  const request = await queryOne<{ author_employee_id: number | null; stage: string }>(
    `SELECT author_employee_id, stage FROM hiring_requests WHERE id = $1`, [id],
  );
  if (!request) { res.status(404).json({ success: false, error: 'Заявка не найдена' }); return; }
  const manage = await canManageHiring(req);
  const isAuthor = req.user.employee_id != null && request.author_employee_id === req.user.employee_id;
  if (!manage && !isAuthor) { res.status(403).json({ success: false, error: 'Нет прав' }); return; }
  if (request.stage !== 'rework') { res.status(400).json({ success: false, error: 'Заявка не на доработке' }); return; }
  await execute(`UPDATE hiring_requests SET stage = 'new', reactivated_at = NOW(), updated_at = NOW() WHERE id = $1`, [id]);
  await logEvent(id, req.user.id, 'resubmit', { from_stage: 'rework', to_stage: 'new' });
  res.json({ success: true });
};

const setUrgent = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ success: false, error: 'Некорректный id' }); return; }
  if (!(await canManageHiring(req))) { res.status(403).json({ success: false, error: 'Доступно руководителю отдела кадров' }); return; }
  const urgent = !!req.body?.urgent;
  await execute(`UPDATE hiring_requests SET is_urgent = $1, updated_at = NOW() WHERE id = $2`, [urgent, id]);
  await logEvent(id, req.user.id, 'urgent', { body: urgent ? 'Отмечена срочной' : 'Снята срочность' });
  res.json({ success: true });
};

// ===================== Ответственные =====================
const listAssignees = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ success: false, error: 'Некорректный id' }); return; }
  const data = (await loadAssignees([id])).get(id) ?? [];
  res.json({ success: true, data });
};

const addAssignee = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ success: false, error: 'Некорректный id' }); return; }
  if (!(await canManageHiring(req))) { res.status(403).json({ success: false, error: 'Доступно руководителю отдела кадров' }); return; }
  const employeeId = Number(req.body?.employee_id);
  if (!Number.isInteger(employeeId)) { res.status(400).json({ success: false, error: 'employee_id обязателен' }); return; }
  // только из пула
  const inPool = await isRecruiter(employeeId);
  if (!inPool) { res.status(400).json({ success: false, error: 'Сотрудник не в пуле рекрутеров' }); return; }

  await withTransaction(async (client) => {
    const existing = await client.query(`SELECT 1 FROM hiring_request_assignees WHERE request_id = $1 AND is_active = TRUE LIMIT 1`, [id]);
    const wantPrimary = !!req.body?.is_primary || existing.rowCount === 0; // первый назначенный → primary
    if (wantPrimary) {
      await client.query(`UPDATE hiring_request_assignees SET is_primary = FALSE WHERE request_id = $1 AND is_active = TRUE`, [id]);
    }
    await client.query(
      `INSERT INTO hiring_request_assignees (request_id, employee_id, is_primary, assigned_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (request_id, employee_id) WHERE is_active = TRUE DO UPDATE SET is_primary = EXCLUDED.is_primary`,
      [id, employeeId, wantPrimary, req.user.id],
    );
  });
  await logEvent(id, req.user.id, 'assign', { body: `Назначен ответственный (employee #${employeeId})` });
  res.json({ success: true });
};

const setPrimaryAssignee = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const id = parseId(req.params.id);
  const employeeId = Number(req.params.employeeId);
  if (!id || !Number.isInteger(employeeId)) { res.status(400).json({ success: false, error: 'Некорректные параметры' }); return; }
  if (!(await canManageHiring(req))) { res.status(403).json({ success: false, error: 'Доступно руководителю отдела кадров' }); return; }
  await withTransaction(async (client) => {
    await client.query(`UPDATE hiring_request_assignees SET is_primary = FALSE WHERE request_id = $1 AND is_active = TRUE`, [id]);
    await client.query(`UPDATE hiring_request_assignees SET is_primary = TRUE WHERE request_id = $1 AND employee_id = $2 AND is_active = TRUE`, [id, employeeId]);
  });
  res.json({ success: true });
};

const removeAssignee = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const id = parseId(req.params.id);
  const employeeId = Number(req.params.employeeId);
  if (!id || !Number.isInteger(employeeId)) { res.status(400).json({ success: false, error: 'Некорректные параметры' }); return; }
  if (!(await canManageHiring(req))) { res.status(403).json({ success: false, error: 'Доступно руководителю отдела кадров' }); return; }
  await withTransaction(async (client) => {
    const removed = await client.query(
      `UPDATE hiring_request_assignees SET is_active = FALSE
        WHERE request_id = $1 AND employee_id = $2 AND is_active = TRUE
        RETURNING is_primary`,
      [id, employeeId],
    );
    const wasPrimary = removed.rows[0]?.is_primary === true;
    if (wasPrimary) {
      // промоут самого раннего из оставшихся
      await client.query(
        `UPDATE hiring_request_assignees SET is_primary = TRUE
          WHERE id = (SELECT id FROM hiring_request_assignees
                       WHERE request_id = $1 AND is_active = TRUE
                       ORDER BY assigned_at ASC LIMIT 1)`,
        [id],
      );
    }
  });
  await logEvent(id, req.user.id, 'unassign', { body: `Снят ответственный (employee #${employeeId})` });
  res.json({ success: true });
};

// ===================== Пул рекрутеров =====================
const listRecruiters = async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  const data = await query(
    `SELECT hr.employee_id, e.full_name, p.name AS position_name, d.name AS department_name
       FROM hiring_recruiters hr
       JOIN employees e ON e.id = hr.employee_id
       LEFT JOIN positions p ON p.id = e.position_id
       LEFT JOIN org_departments d ON d.id = e.org_department_id
      WHERE hr.is_active = TRUE
      ORDER BY e.full_name ASC`,
  );
  res.json({ success: true, data });
};

const addRecruiter = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  if (!(await canManageHiring(req))) { res.status(403).json({ success: false, error: 'Доступно руководителю отдела кадров' }); return; }
  const employeeId = Number(req.body?.employee_id);
  if (!Number.isInteger(employeeId)) { res.status(400).json({ success: false, error: 'employee_id обязателен' }); return; }
  await execute(
    `INSERT INTO hiring_recruiters (employee_id, added_by) VALUES ($1,$2)
     ON CONFLICT (employee_id) WHERE is_active = TRUE DO NOTHING`,
    [employeeId, req.user.id],
  );
  res.json({ success: true });
};

const removeRecruiter = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  if (!(await canManageHiring(req))) { res.status(403).json({ success: false, error: 'Доступно руководителю отдела кадров' }); return; }
  const employeeId = Number(req.params.employeeId);
  if (!Number.isInteger(employeeId)) { res.status(400).json({ success: false, error: 'Некорректный employee_id' }); return; }
  // активные назначения НЕ трогаем — возвращаем их для предупреждения
  const active = await query<{ id: number; position_title: string }>(
    `SELECT r.id, r.position_title FROM hiring_request_assignees a
       JOIN hiring_requests r ON r.id = a.request_id
      WHERE a.employee_id = $1 AND a.is_active = TRUE AND r.stage NOT IN ('closed','cancelled')`,
    [employeeId],
  );
  await execute(`UPDATE hiring_recruiters SET is_active = FALSE WHERE employee_id = $1 AND is_active = TRUE`, [employeeId]);
  res.json({ success: true, data: { active_requests: active } });
};

// ===================== Кандидаты =====================
const addCandidate = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ success: false, error: 'Некорректный id' }); return; }
  if (!(await canWorkRequest(req, id))) { res.status(403).json({ success: false, error: 'Нет прав' }); return; }
  const fullName = String(req.body?.full_name || '').trim();
  if (!fullName) { res.status(400).json({ success: false, error: 'ФИО обязательно' }); return; }
  const row = await queryOne<{ id: number }>(
    `INSERT INTO hiring_candidates (request_id, full_name, hh_resume_url, phone, salary_expectation, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [id, fullName, req.body?.hh_resume_url ?? null, req.body?.phone ?? null, req.body?.salary_expectation ?? null, req.user.id],
  );
  await logEvent(id, req.user.id, 'candidate', { body: `Добавлен кандидат: ${fullName}` });
  res.status(201).json({ success: true, data: { id: row?.id } });
};

const updateCandidate = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const id = parseId(req.params.id);
  const cid = parseId(req.params.cid);
  if (!id || !cid) { res.status(400).json({ success: false, error: 'Некорректные параметры' }); return; }
  const cand = await queryOne<{ request_id: number }>(`SELECT request_id FROM hiring_candidates WHERE id = $1`, [cid]);
  if (!cand || Number(cand.request_id) !== id) { res.status(404).json({ success: false, error: 'Кандидат не найден' }); return; }

  const isWork = await canWorkRequest(req, id);
  const request = await queryOne<{ author_employee_id: number | null }>(`SELECT author_employee_id FROM hiring_requests WHERE id = $1`, [id]);
  const isAuthor = req.user.employee_id != null && request?.author_employee_id === req.user.employee_id;

  const sets: string[] = [];
  const params: unknown[] = [];
  const b = req.body ?? {};
  // work-роли: статус, отзыв соискателя, контактные поля
  if (isWork) {
    if (typeof b.status === 'string') {
      if (!CANDIDATE_STATUSES.includes(b.status)) { res.status(400).json({ success: false, error: 'Недопустимый статус' }); return; }
      params.push(b.status); sets.push(`status = $${params.length}`);
    }
    for (const k of ['seeker_feedback', 'hh_resume_url', 'phone', 'salary_expectation', 'interview_at'] as const) {
      if (k in b) { params.push(b[k] ?? null); sets.push(`${k} = $${params.length}`); }
    }
  }
  // отзыв заявителя: автор ИЛИ work-роль
  if ('applicant_feedback' in b && (isWork || isAuthor)) {
    params.push(b.applicant_feedback ?? null); sets.push(`applicant_feedback = $${params.length}`);
  }
  if (sets.length === 0) { res.status(403).json({ success: false, error: 'Нет прав на изменение этих полей' }); return; }
  params.push(cid);
  await execute(`UPDATE hiring_candidates SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length}`, params);
  res.json({ success: true });
};

const approveCandidate = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const id = parseId(req.params.id);
  const cid = parseId(req.params.cid);
  if (!id || !cid) { res.status(400).json({ success: false, error: 'Некорректные параметры' }); return; }
  const approved = !!req.body?.approved;

  const request = await queryOne<{ author_employee_id: number | null }>(`SELECT author_employee_id FROM hiring_requests WHERE id = $1`, [id]);
  if (!request) { res.status(404).json({ success: false, error: 'Заявка не найдена' }); return; }
  const manage = await canManageHiring(req);
  const isAuthor = req.user.employee_id != null && request.author_employee_id === req.user.employee_id;
  if (!manage && !isAuthor) { res.status(403).json({ success: false, error: 'Утверждать может заявитель или руководитель' }); return; }

  try {
    await withTransaction(async (client) => {
      // блокируем строку заявки — защита от гонки лимита headcount
      const hc = await client.query<{ headcount: number }>(`SELECT headcount FROM hiring_requests WHERE id = $1 FOR UPDATE`, [id]);
      const headcount = Number(hc.rows[0]?.headcount ?? 1);
      const belongs = await client.query(`SELECT 1 FROM hiring_candidates WHERE id = $1 AND request_id = $2`, [cid, id]);
      if (belongs.rowCount === 0) throw new Error('NOT_FOUND');
      if (approved) {
        const cnt = await client.query<{ n: number }>(
          `SELECT COUNT(*)::int AS n FROM hiring_candidates WHERE request_id = $1 AND applicant_approved = TRUE AND id <> $2`,
          [id, cid],
        );
        if (Number(cnt.rows[0].n) + 1 > headcount) throw new Error('LIMIT');
        await client.query(
          `UPDATE hiring_candidates SET applicant_approved = TRUE, approved_by = $1, approved_at = NOW(), updated_at = NOW() WHERE id = $2`,
          [req.user.id, cid],
        );
      } else {
        await client.query(
          `UPDATE hiring_candidates SET applicant_approved = FALSE, approved_by = NULL, approved_at = NULL, updated_at = NOW() WHERE id = $1`,
          [cid],
        );
      }
    });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === 'LIMIT') { res.status(409).json({ success: false, error: 'Достигнут лимит выбранных кандидатов (headcount)' }); return; }
    if (msg === 'NOT_FOUND') { res.status(404).json({ success: false, error: 'Кандидат не найден' }); return; }
    throw err;
  }
  await logEvent(id, req.user.id, 'approve', { body: approved ? 'Кандидат выбран заявителем' : 'Снято утверждение кандидата' });
  res.json({ success: true });
};

const deleteCandidate = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const id = parseId(req.params.id);
  const cid = parseId(req.params.cid);
  if (!id || !cid) { res.status(400).json({ success: false, error: 'Некорректные параметры' }); return; }
  if (!(await canWorkRequest(req, id))) { res.status(403).json({ success: false, error: 'Нет прав' }); return; }
  await execute(`DELETE FROM hiring_candidates WHERE id = $1 AND request_id = $2`, [cid, id]);
  res.json({ success: true });
};

const finalizeSelection = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ success: false, error: 'Некорректный id' }); return; }
  const request = await queryOne<{ author_employee_id: number | null; headcount: number }>(
    `SELECT author_employee_id, headcount FROM hiring_requests WHERE id = $1`, [id],
  );
  if (!request) { res.status(404).json({ success: false, error: 'Заявка не найдена' }); return; }
  const manage = await canManageHiring(req);
  const isAuthor = req.user.employee_id != null && request.author_employee_id === req.user.employee_id;
  if (!manage && !isAuthor) { res.status(403).json({ success: false, error: 'Нет прав' }); return; }

  const cnt = await queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM hiring_candidates WHERE request_id = $1 AND applicant_approved = TRUE`, [id]);
  const approved = Number(cnt?.n ?? 0);
  if (approved < 1) { res.status(400).json({ success: false, error: 'Утвердите хотя бы одного кандидата' }); return; }
  if (approved < Number(request.headcount) && !req.body?.confirm_partial) {
    res.status(400).json({ success: false, error: 'Выбрано меньше требуемого. Подтвердите частичное закрытие (confirm_partial).', code: 'PARTIAL' }); return;
  }
  await execute(`UPDATE hiring_requests SET applicant_finalized_at = NOW(), updated_at = NOW() WHERE id = $1`, [id]);
  await logEvent(id, req.user.id, 'finalize', { body: `Заявитель утвердил набор (${approved})` });
  res.json({ success: true });
};

const unfinalize = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ success: false, error: 'Некорректный id' }); return; }
  if (!(await canManageHiring(req))) { res.status(403).json({ success: false, error: 'Доступно руководителю отдела кадров' }); return; }
  const cur = await queryOne<{ stage: string }>(`SELECT stage FROM hiring_requests WHERE id = $1`, [id]);
  if (!cur) { res.status(404).json({ success: false, error: 'Заявка не найдена' }); return; }
  if (cur.stage === 'closed') { res.status(400).json({ success: false, error: 'Сначала верните этап из «Закрыта»' }); return; }
  await execute(`UPDATE hiring_requests SET applicant_finalized_at = NULL, updated_at = NOW() WHERE id = $1`, [id]);
  await logEvent(id, req.user.id, 'unfinalize', { body: 'Снята фиксация набора' });
  res.json({ success: true });
};

// ===================== Комментарии / ссылки / файлы =====================
const addComment = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ success: false, error: 'Некорректный id' }); return; }
  if (!(await canWorkRequest(req, id))) { res.status(403).json({ success: false, error: 'Нет прав' }); return; }
  const body = String(req.body?.body || '').trim();
  if (!body) { res.status(400).json({ success: false, error: 'Текст обязателен' }); return; }
  await logEvent(id, req.user.id, 'comment', { body });
  res.json({ success: true });
};

const addLink = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ success: false, error: 'Некорректный id' }); return; }
  if (!(await canWorkRequest(req, id))) { res.status(403).json({ success: false, error: 'Нет прав' }); return; }
  const url = String(req.body?.link_url || '').trim();
  if (!url) { res.status(400).json({ success: false, error: 'Ссылка обязательна' }); return; }
  await logEvent(id, req.user.id, 'link', { body: req.body?.body ?? null, link_url: url });
  res.json({ success: true });
};

const uploadFile = async (req: MulterRequest, res: Response): Promise<void> => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ success: false, error: 'Некорректный id' }); return; }
  if (!(await canWorkRequest(req, id))) { res.status(403).json({ success: false, error: 'Нет прав' }); return; }
  if (!(await r2Service.isEnabledAsync())) { res.status(503).json({ success: false, error: 'R2 хранилище не настроено' }); return; }
  if (!req.file) { res.status(400).json({ success: false, error: 'Файл обязателен' }); return; }
  const candidateId = req.body?.candidate_id ? Number(req.body.candidate_id) : null;
  const r2Key = r2Service.generateHiringRequestKey(id, req.file.originalname);
  await r2Service.uploadObject(r2Key, req.file.buffer, req.file.mimetype);
  try {
    const row = await queryOne<{ id: number }>(
      `INSERT INTO hiring_request_files (request_id, candidate_id, r2_key, file_name, file_size, mime_type, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [id, candidateId, r2Key, req.file.originalname, req.file.size, req.file.mimetype, req.user.id],
    );
    await logEvent(id, req.user.id, 'file', { body: `Прикреплён файл: ${req.file.originalname}` });
    res.status(201).json({ success: true, data: { id: row?.id } });
  } catch (err) {
    try { await r2Service.deleteObject(r2Key); } catch { /* best-effort */ }
    throw err;
  }
};

const downloadFile = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const id = parseId(req.params.id);
  const fileId = parseId(req.params.fileId);
  if (!id || !fileId) { res.status(400).json({ success: false, error: 'Некорректные параметры' }); return; }
  if (!(await canWorkRequest(req, id)) && !(await canManageHiring(req))) {
    // автор тоже может скачивать вложения своей заявки
    const request = await queryOne<{ author_employee_id: number | null }>(`SELECT author_employee_id FROM hiring_requests WHERE id = $1`, [id]);
    const isAuthor = req.user.employee_id != null && request?.author_employee_id === req.user.employee_id;
    if (!isAuthor) { res.status(403).json({ success: false, error: 'Нет прав' }); return; }
  }
  const file = await queryOne<{ r2_key: string; file_name: string }>(
    `SELECT r2_key, file_name FROM hiring_request_files WHERE id = $1 AND request_id = $2`, [fileId, id],
  );
  if (!file) { res.status(404).json({ success: false, error: 'Файл не найден' }); return; }
  const url = await r2Service.generateDownloadUrl(file.r2_key, file.file_name);
  res.json({ success: true, data: { url } });
};

const deleteFile = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const id = parseId(req.params.id);
  const fileId = parseId(req.params.fileId);
  if (!id || !fileId) { res.status(400).json({ success: false, error: 'Некорректные параметры' }); return; }
  if (!(await canWorkRequest(req, id))) { res.status(403).json({ success: false, error: 'Нет прав' }); return; }
  const file = await queryOne<{ r2_key: string }>(`SELECT r2_key FROM hiring_request_files WHERE id = $1 AND request_id = $2`, [fileId, id]);
  if (file) {
    await execute(`DELETE FROM hiring_request_files WHERE id = $1`, [fileId]);
    try { await r2Service.deleteObject(file.r2_key); } catch { /* best-effort */ }
  }
  res.json({ success: true });
};

// ===================== Аналитика (по primary) =====================
const analytics = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  if (!(await canManageHiring(req))) { res.status(403).json({ success: false, error: 'Доступно руководителю отдела кадров' }); return; }
  const period = req.query.period === 'week' ? 'week' : 'month';
  const interval = period === 'week' ? '7 days' : '1 month';

  const rows = await query(
    `WITH primary_assignee AS (
        SELECT a.request_id, a.employee_id
          FROM hiring_request_assignees a
         WHERE a.is_active = TRUE AND a.is_primary = TRUE
     )
     SELECT e.id AS employee_id, e.full_name,
            COUNT(r.id)::int AS total,
            COUNT(*) FILTER (WHERE r.stage = 'closed' AND r.closed_at >= NOW() - $1::interval)::int AS closed,
            ROUND(AVG(r.headcount), 1) AS avg_headcount,
            (SELECT COUNT(*)::int FROM hiring_candidates c
              WHERE c.request_id IN (SELECT request_id FROM primary_assignee pa WHERE pa.employee_id = e.id)
                AND c.status = 'interview') AS interviews,
            ROUND(AVG(EXTRACT(DAY FROM (r.closed_at - COALESCE(r.reactivated_at, r.created_at)))) FILTER (WHERE r.stage = 'closed'), 1) AS avg_close_days,
            COUNT(*) FILTER (WHERE r.stage = 'closed' AND r.deadline IS NOT NULL AND r.closed_at::date <= r.deadline)::int AS closed_in_time,
            COUNT(*) FILTER (WHERE r.stage = 'closed' AND r.deadline IS NOT NULL)::int AS closed_with_deadline,
            COUNT(*) FILTER (WHERE r.stage NOT IN ('closed','cancelled') AND r.deadline IS NOT NULL AND r.deadline < CURRENT_DATE)::int AS overdue
       FROM primary_assignee pa
       JOIN employees e ON e.id = pa.employee_id
       JOIN hiring_requests r ON r.id = pa.request_id
      GROUP BY e.id, e.full_name
      ORDER BY closed DESC, total DESC`,
    [interval],
  );

  res.json({ success: true, data: rows, meta: { period } });
};

export const hiringRequestsController = {
  list, getById, create, updateFields, changeStage, reject, resubmit, setUrgent,
  listAssignees, addAssignee, setPrimaryAssignee, removeAssignee,
  listRecruiters, addRecruiter, removeRecruiter,
  addCandidate, updateCandidate, approveCandidate, deleteCandidate,
  finalizeSelection, unfinalize,
  addComment, addLink, uploadFile, downloadFile, deleteFile,
  analytics,
};
