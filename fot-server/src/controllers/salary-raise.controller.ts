import type { Response } from 'express';
import { supabase } from '../config/database.js';
import type { AuthenticatedRequest, SalaryRaiseStatus } from '../types/index.js';
import { employeeChangesService } from '../services/employee-changes.service.js';
import { pushService } from '../services/push.service.js';
import { getHierarchyLevel } from '../services/roles-cache.service.js';
import { r2Service } from '../services/r2.service.js';
import { getIo } from '../socket/io-instance.js';

const REQUEST_TYPES = ['performance', 'market_adjustment', 'promotion', 'new_responsibilities', 'retention', 'other'] as const;

const VALID_TRANSITIONS: Record<string, { action: string; next: SalaryRaiseStatus }[]> = {
  draft: [
    { action: 'submit', next: 'supervisor_review' },
    { action: 'cancel', next: 'cancelled' },
  ],
  supervisor_review: [
    { action: 'approve', next: 'hr_review' },
    { action: 'reject', next: 'rejected' },
    { action: 'cancel', next: 'cancelled' },
  ],
  hr_review: [
    { action: 'approve', next: 'finance_review' },
    { action: 'reject', next: 'rejected' },
  ],
  finance_review: [
    { action: 'approve', next: 'approved' },
    { action: 'reject', next: 'rejected' },
  ],
};

const getNextStatus = (current: string, action: string): SalaryRaiseStatus | null => {
  const transitions = VALID_TRANSITIONS[current];
  if (!transitions) return null;
  const t = transitions.find(t => t.action === action);
  return t ? t.next : null;
};

/** Собрать snapshot сотрудника */
const buildSnapshot = async (employeeId: number) => {
  const { data: emp } = await supabase
    .from('employees')
    .select('full_name, current_salary, salary_actual, hire_date, work_object, position_id, org_department_id')
    .eq('id', employeeId)
    .single();

  if (!emp) return null;

  // Название должности
  let positionName: string | null = null;
  if (emp.position_id) {
    const { data: pos } = await supabase.from('positions').select('name').eq('id', emp.position_id).single();
    positionName = pos?.name || null;
  }

  // Название отдела
  let departmentName: string | null = null;
  if (emp.org_department_id) {
    const { data: dep } = await supabase.from('org_departments').select('name').eq('id', emp.org_department_id).single();
    departmentName = dep?.name || null;
  }

  // Руководитель
  let supervisorName: string | null = null;
  const { data: up } = await supabase.from('user_profiles').select('supervisor_id').eq('employee_id', employeeId).single();
  if (up?.supervisor_id) {
    const { data: supProfile } = await supabase.from('user_profiles').select('employee_id').eq('id', up.supervisor_id).single();
    if (supProfile?.employee_id) {
      const { data: supEmp } = await supabase.from('employees').select('full_name').eq('id', supProfile.employee_id).single();
      supervisorName = supEmp?.full_name || null;
    }
  }

  // Последнее повышение
  const { data: lastRaise } = await supabase
    .from('salary_history')
    .select('effective_date')
    .eq('employee_id', employeeId)
    .order('effective_date', { ascending: false })
    .limit(1)
    .single();

  return {
    full_name: emp.full_name,
    position_name: positionName,
    department_name: departmentName,
    work_object: emp.work_object,
    current_salary: emp.current_salary,
    salary_actual: emp.salary_actual,
    hire_date: emp.hire_date,
    supervisor_name: supervisorName,
    last_raise_date: lastRaise?.effective_date || null,
  };
};

/** Уведомить через push + socket */
const notifyUsers = (userIds: string[], title: string, body: string) => {
  pushService.sendSalaryRaiseNotification(userIds, title, body)
    .then((sentIds) => {
      const io = getIo();
      if (io) {
        for (const uid of sentIds) {
          io.to(`user:${uid}`).emit('salary_raise_notification', { title, body });
        }
      }
    })
    .catch((e) => console.error('salary-raise notify error:', e));
};

/** Получить user_ids по минимальному уровню роли */
const getUsersByMinLevel = async (minLevel: number, excludeId?: string): Promise<string[]> => {
  const { data: roles } = await supabase.from('system_roles').select('code, level').gte('level', minLevel);
  if (!roles || roles.length === 0) return [];
  const codes = roles.map(r => r.code);
  const { data: users } = await supabase
    .from('user_profiles')
    .select('id')
    .in('position_type', codes)
    .eq('is_approved', true);
  const ids = (users || []).map(u => u.id).filter(id => id !== excludeId);
  return ids;
};

/** Получить supervisor user_id для сотрудника */
const getSupervisorUserId = async (employeeId: number): Promise<string | null> => {
  const { data: up } = await supabase.from('user_profiles').select('supervisor_id').eq('employee_id', employeeId).single();
  return up?.supervisor_id || null;
};

/** Создать заявку */
const create = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = req.user.employee_id;
    if (!employeeId) {
      res.status(400).json({ success: false, error: 'Нет привязки к сотруднику' });
      return;
    }

    const {
      request_type, requested_salary, raise_percentage,
      desired_effective_date, reason_brief,
      achievements, responsibility_changes, self_assessment,
    } = req.body;

    if (!request_type || !requested_salary || !desired_effective_date || !reason_brief) {
      res.status(400).json({ success: false, error: 'Обязательные поля: request_type, requested_salary, desired_effective_date, reason_brief' });
      return;
    }
    if (!REQUEST_TYPES.includes(request_type)) {
      res.status(400).json({ success: false, error: 'Недопустимый тип заявки' });
      return;
    }

    const snapshot = await buildSnapshot(employeeId);
    if (!snapshot) {
      res.status(404).json({ success: false, error: 'Сотрудник не найден' });
      return;
    }

    const { data, error } = await supabase
      .from('salary_raise_requests')
      .insert({
        employee_id: employeeId,
        author_user_id: req.user.id,
        employee_snapshot: snapshot,
        request_type,
        requested_salary,
        raise_percentage: raise_percentage ?? 0,
        desired_effective_date,
        reason_brief,
        achievements: achievements || [],
        responsibility_changes: responsibility_changes || {},
        self_assessment: self_assessment || {},
      })
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    console.error('salary-raise.create error:', err);
    res.status(500).json({ success: false, error: 'Ошибка создания заявки' });
  }
};

/** Обновить черновик */
const update = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    const { data: request, error: fetchErr } = await supabase
      .from('salary_raise_requests')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchErr || !request) {
      res.status(404).json({ success: false, error: 'Заявка не найдена' });
      return;
    }
    if (request.author_user_id !== req.user.id) {
      res.status(403).json({ success: false, error: 'Можно редактировать только свою заявку' });
      return;
    }
    if (request.status !== 'draft') {
      res.status(400).json({ success: false, error: 'Можно редактировать только черновик' });
      return;
    }

    const {
      request_type, requested_salary, raise_percentage,
      desired_effective_date, reason_brief,
      achievements, responsibility_changes, self_assessment,
    } = req.body;

    // Пересобрать snapshot
    const snapshot = await buildSnapshot(request.employee_id);

    const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (snapshot) updateData.employee_snapshot = snapshot;
    if (request_type !== undefined) updateData.request_type = request_type;
    if (requested_salary !== undefined) updateData.requested_salary = requested_salary;
    if (raise_percentage !== undefined) updateData.raise_percentage = raise_percentage;
    if (desired_effective_date !== undefined) updateData.desired_effective_date = desired_effective_date;
    if (reason_brief !== undefined) updateData.reason_brief = reason_brief;
    if (achievements !== undefined) updateData.achievements = achievements;
    if (responsibility_changes !== undefined) updateData.responsibility_changes = responsibility_changes;
    if (self_assessment !== undefined) updateData.self_assessment = self_assessment;

    const { data, error } = await supabase
      .from('salary_raise_requests')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    console.error('salary-raise.update error:', err);
    res.status(500).json({ success: false, error: 'Ошибка обновления заявки' });
  }
};

/** Мои заявки */
const getMy = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { data, error } = await supabase
      .from('salary_raise_requests')
      .select('*')
      .eq('author_user_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err) {
    console.error('salary-raise.getMy error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения заявок' });
  }
};

/** На рассмотрении (header+) — заявки, ожидающие действия текущего пользователя */
const getPending = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userLevel = await getHierarchyLevel(req.user.position_type);
    const results: unknown[] = [];

    // Supervisor review: заявки где текущий user — supervisor или header отдела
    if (userLevel >= 2) {
      const { data: supervisorRequests } = await supabase
        .from('salary_raise_requests')
        .select('*')
        .eq('status', 'supervisor_review')
        .order('created_at', { ascending: false });

      if (supervisorRequests) {
        for (const r of supervisorRequests) {
          const supervisorId = await getSupervisorUserId(r.employee_id);
          if (supervisorId === req.user.id) {
            results.push(r);
            continue;
          }
          // Или header того же отдела
          if (req.user.position_type === 'header' && req.user.department_id) {
            const { data: emp } = await supabase
              .from('employees')
              .select('org_department_id')
              .eq('id', r.employee_id)
              .single();
            if (emp?.org_department_id === req.user.department_id) {
              results.push(r);
            }
          }
        }
      }
    }

    // HR review
    if (userLevel >= 3) {
      const { data: hrRequests } = await supabase
        .from('salary_raise_requests')
        .select('*')
        .eq('status', 'hr_review')
        .order('created_at', { ascending: false });
      if (hrRequests) results.push(...hrRequests);
    }

    // Finance review (admin+)
    if (userLevel >= 4) {
      const { data: finRequests } = await supabase
        .from('salary_raise_requests')
        .select('*')
        .eq('status', 'finance_review')
        .order('created_at', { ascending: false });
      if (finRequests) results.push(...finRequests);
    }

    // Enrich с ФИО
    const enriched = await enrichWithNames(results as Record<string, unknown>[]);
    res.json({ success: true, data: enriched });
  } catch (err) {
    console.error('salary-raise.getPending error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения заявок' });
  }
};

/** Все заявки (hr+) */
const getAll = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    let query = supabase
      .from('salary_raise_requests')
      .select('*')
      .order('created_at', { ascending: false });

    const status = req.query.status as string | undefined;
    if (status) query = query.eq('status', status);

    const { data, error } = await query;
    if (error) throw error;

    const enriched = await enrichWithNames(data || []);
    res.json({ success: true, data: enriched });
  } catch (err) {
    console.error('salary-raise.getAll error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения заявок' });
  }
};

/** Одна заявка */
const getById = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('salary_raise_requests')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !data) {
      res.status(404).json({ success: false, error: 'Заявка не найдена' });
      return;
    }

    // Подгрузить вложения
    const { data: attachments } = await supabase
      .from('salary_raise_attachments')
      .select('*')
      .eq('salary_raise_id', id)
      .order('created_at', { ascending: true });

    res.json({ success: true, data: { ...data, attachments: attachments || [] } });
  } catch (err) {
    console.error('salary-raise.getById error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения заявки' });
  }
};

/** Отправить (submit) */
const submit = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { data: request, error: fetchErr } = await supabase
      .from('salary_raise_requests')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchErr || !request) {
      res.status(404).json({ success: false, error: 'Заявка не найдена' });
      return;
    }
    if (request.author_user_id !== req.user.id) {
      res.status(403).json({ success: false, error: 'Можно отправить только свою заявку' });
      return;
    }

    const next = getNextStatus(request.status, 'submit');
    if (!next) {
      res.status(400).json({ success: false, error: 'Невозможно отправить заявку в текущем статусе' });
      return;
    }

    const { data, error } = await supabase
      .from('salary_raise_requests')
      .update({ status: next, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    // Push supervisor
    const supervisorId = await getSupervisorUserId(request.employee_id);
    if (supervisorId) {
      const snapshot = request.employee_snapshot as Record<string, unknown>;
      notifyUsers([supervisorId], 'Заявка на повышение', `${snapshot.full_name || 'Сотрудник'} подал заявку на повышение оклада`);
    }

    res.json({ success: true, data });
  } catch (err) {
    console.error('salary-raise.submit error:', err);
    res.status(500).json({ success: false, error: 'Ошибка отправки заявки' });
  }
};

/** Отмена */
const cancel = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { data: request, error: fetchErr } = await supabase
      .from('salary_raise_requests')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchErr || !request) {
      res.status(404).json({ success: false, error: 'Заявка не найдена' });
      return;
    }
    if (request.author_user_id !== req.user.id) {
      res.status(403).json({ success: false, error: 'Можно отменить только свою заявку' });
      return;
    }

    const next = getNextStatus(request.status, 'cancel');
    if (!next) {
      res.status(400).json({ success: false, error: 'Невозможно отменить заявку в текущем статусе' });
      return;
    }

    const { data, error } = await supabase
      .from('salary_raise_requests')
      .update({ status: next, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    console.error('salary-raise.cancel error:', err);
    res.status(500).json({ success: false, error: 'Ошибка отмены заявки' });
  }
};

/** Рецензия руководителя (Блок Е) */
const supervisorReview = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { review, action } = req.body; // action: 'approve' | 'reject'

    if (!action || !['approve', 'reject'].includes(action)) {
      res.status(400).json({ success: false, error: 'action должен быть approve или reject' });
      return;
    }

    const { data: request, error: fetchErr } = await supabase
      .from('salary_raise_requests')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchErr || !request) {
      res.status(404).json({ success: false, error: 'Заявка не найдена' });
      return;
    }
    if (request.status !== 'supervisor_review') {
      res.status(400).json({ success: false, error: 'Заявка не на этапе рассмотрения руководителем' });
      return;
    }

    // Проверка: supervisor_id или header отдела
    const supervisorId = await getSupervisorUserId(request.employee_id);
    let hasAccess = supervisorId === req.user.id;

    if (!hasAccess && req.user.position_type === 'header' && req.user.department_id) {
      const { data: emp } = await supabase
        .from('employees')
        .select('org_department_id')
        .eq('id', request.employee_id)
        .single();
      hasAccess = emp?.org_department_id === req.user.department_id;
    }

    // admin+ всегда может
    const userLevel = await getHierarchyLevel(req.user.position_type);
    if (userLevel >= 4) hasAccess = true;

    if (!hasAccess) {
      res.status(403).json({ success: false, error: 'Нет прав на рецензирование этой заявки' });
      return;
    }

    const next = getNextStatus(request.status, action);
    if (!next) {
      res.status(400).json({ success: false, error: 'Недопустимое действие' });
      return;
    }

    const { data, error } = await supabase
      .from('salary_raise_requests')
      .update({
        status: next,
        supervisor_review: review || {},
        supervisor_reviewer_id: req.user.id,
        supervisor_reviewed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    // Уведомления
    const snapshot = request.employee_snapshot as Record<string, unknown>;
    const empName = (snapshot.full_name as string) || 'Сотрудник';
    if (action === 'approve') {
      // Уведомить HR (level >= 3)
      const hrUsers = await getUsersByMinLevel(3, req.user.id);
      notifyUsers(hrUsers, 'Заявка на повышение', `Заявка ${empName} одобрена руководителем, ожидает рассмотрения HR`);
    }
    // Уведомить автора
    notifyUsers([request.author_user_id], 'Заявка на повышение',
      action === 'approve' ? 'Ваша заявка одобрена руководителем' : 'Ваша заявка отклонена руководителем');

    res.json({ success: true, data });
  } catch (err) {
    console.error('salary-raise.supervisorReview error:', err);
    res.status(500).json({ success: false, error: 'Ошибка рецензирования' });
  }
};

/** Рецензия HR (Блок З) */
const hrReview = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { review, action } = req.body;

    if (!action || !['approve', 'reject'].includes(action)) {
      res.status(400).json({ success: false, error: 'action должен быть approve или reject' });
      return;
    }

    const { data: request, error: fetchErr } = await supabase
      .from('salary_raise_requests')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchErr || !request) {
      res.status(404).json({ success: false, error: 'Заявка не найдена' });
      return;
    }
    if (request.status !== 'hr_review') {
      res.status(400).json({ success: false, error: 'Заявка не на этапе рассмотрения HR' });
      return;
    }

    const next = getNextStatus(request.status, action);
    if (!next) {
      res.status(400).json({ success: false, error: 'Недопустимое действие' });
      return;
    }

    const { data, error } = await supabase
      .from('salary_raise_requests')
      .update({
        status: next,
        hr_review: review || {},
        hr_reviewer_id: req.user.id,
        hr_reviewed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    const snapshot = request.employee_snapshot as Record<string, unknown>;
    const empName = (snapshot.full_name as string) || 'Сотрудник';
    if (action === 'approve') {
      const adminUsers = await getUsersByMinLevel(4, req.user.id);
      notifyUsers(adminUsers, 'Заявка на повышение', `Заявка ${empName} одобрена HR, ожидает финансового согласования`);
    }
    notifyUsers([request.author_user_id], 'Заявка на повышение',
      action === 'approve' ? 'Ваша заявка одобрена HR' : 'Ваша заявка отклонена HR');

    res.json({ success: true, data });
  } catch (err) {
    console.error('salary-raise.hrReview error:', err);
    res.status(500).json({ success: false, error: 'Ошибка рецензирования' });
  }
};

/** Рецензия финансов (Блок И) — admin+ */
const financeReview = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { review, action } = req.body;

    if (!action || !['approve', 'reject'].includes(action)) {
      res.status(400).json({ success: false, error: 'action должен быть approve или reject' });
      return;
    }

    const { data: request, error: fetchErr } = await supabase
      .from('salary_raise_requests')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchErr || !request) {
      res.status(404).json({ success: false, error: 'Заявка не найдена' });
      return;
    }
    if (request.status !== 'finance_review') {
      res.status(400).json({ success: false, error: 'Заявка не на этапе финансового согласования' });
      return;
    }

    const next = getNextStatus(request.status, action);
    if (!next) {
      res.status(400).json({ success: false, error: 'Недопустимое действие' });
      return;
    }

    const updateData: Record<string, unknown> = {
      status: next,
      finance_review: review || {},
      finance_reviewer_id: req.user.id,
      finance_reviewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from('salary_raise_requests')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    // При approve — автоматически применить повышение
    if (action === 'approve') {
      await employeeChangesService.changeSalary(request.employee_id, Number(request.requested_salary), {
        effectiveDate: request.desired_effective_date,
        reason: `Заявка на повышение #${request.id}`,
        createdBy: req.user.id,
      });
    }

    notifyUsers([request.author_user_id], 'Заявка на повышение',
      action === 'approve' ? 'Ваша заявка одобрена! Оклад обновлён.' : 'Ваша заявка отклонена финансовым отделом');

    res.json({ success: true, data });
  } catch (err) {
    console.error('salary-raise.financeReview error:', err);
    res.status(500).json({ success: false, error: 'Ошибка рецензирования' });
  }
};

/** Получить presigned URL для загрузки файла */
const getUploadUrl = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!(await r2Service.isEnabledAsync())) {
      res.status(503).json({ success: false, error: 'Хранилище файлов не настроено' });
      return;
    }

    const { id } = req.params;
    const { file_name, content_type, achievement_index } = req.body;

    if (!file_name || !content_type) {
      res.status(400).json({ success: false, error: 'file_name и content_type обязательны' });
      return;
    }

    const { data: request } = await supabase
      .from('salary_raise_requests')
      .select('employee_id, author_user_id, status')
      .eq('id', id)
      .single();

    if (!request) {
      res.status(404).json({ success: false, error: 'Заявка не найдена' });
      return;
    }
    if (request.author_user_id !== req.user.id) {
      res.status(403).json({ success: false, error: 'Нет доступа' });
      return;
    }
    if (request.status !== 'draft') {
      res.status(400).json({ success: false, error: 'Загрузка файлов только для черновиков' });
      return;
    }

    const key = `salary-raise/${id}/${Date.now()}-${file_name}`;
    const uploadUrl = await r2Service.generateUploadUrl(key, content_type);

    res.json({
      success: true,
      data: { upload_url: uploadUrl, r2_key: key, achievement_index: achievement_index ?? null },
    });
  } catch (err) {
    console.error('salary-raise.getUploadUrl error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения URL загрузки' });
  }
};

/** Подтвердить загрузку файла */
const confirmAttachment = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { r2_key, file_name, file_size, mime_type, achievement_index } = req.body;

    if (!r2_key || !file_name || !file_size || !mime_type) {
      res.status(400).json({ success: false, error: 'r2_key, file_name, file_size, mime_type обязательны' });
      return;
    }

    const { data: request } = await supabase
      .from('salary_raise_requests')
      .select('author_user_id')
      .eq('id', id)
      .single();

    if (!request) {
      res.status(404).json({ success: false, error: 'Заявка не найдена' });
      return;
    }
    if (request.author_user_id !== req.user.id) {
      res.status(403).json({ success: false, error: 'Нет доступа' });
      return;
    }

    const { data, error } = await supabase
      .from('salary_raise_attachments')
      .insert({
        salary_raise_id: Number(id),
        achievement_index: achievement_index ?? null,
        file_name,
        file_size,
        mime_type,
        r2_key,
        uploaded_by: req.user.id,
      })
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    console.error('salary-raise.confirmAttachment error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения вложения' });
  }
};

/** Список вложений */
const getAttachments = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('salary_raise_attachments')
      .select('*')
      .eq('salary_raise_id', id)
      .order('created_at', { ascending: true });

    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err) {
    console.error('salary-raise.getAttachments error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения вложений' });
  }
};

/** Удалить вложение */
const deleteAttachment = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id, aid } = req.params;

    const { data: att } = await supabase
      .from('salary_raise_attachments')
      .select('*')
      .eq('id', aid)
      .eq('salary_raise_id', id)
      .single();

    if (!att) {
      res.status(404).json({ success: false, error: 'Вложение не найдено' });
      return;
    }
    if (att.uploaded_by !== req.user.id) {
      res.status(403).json({ success: false, error: 'Нет доступа' });
      return;
    }

    // Удалить из R2
    if (await r2Service.isEnabledAsync()) {
      await r2Service.deleteObject(att.r2_key).catch(e => console.error('R2 delete error:', e));
    }

    await supabase.from('salary_raise_attachments').delete().eq('id', aid);
    res.json({ success: true });
  } catch (err) {
    console.error('salary-raise.deleteAttachment error:', err);
    res.status(500).json({ success: false, error: 'Ошибка удаления вложения' });
  }
};

/** Обогатить заявки именами сотрудников */
const enrichWithNames = async (requests: Record<string, unknown>[]) => {
  const empIds = [...new Set(requests.map(r => r.employee_id as number))];
  if (empIds.length === 0) return requests;

  const { data: emps } = await supabase
    .from('employees')
    .select('id, full_name')
    .in('id', empIds);

  const nameMap = new Map((emps || []).map((e: { id: number; full_name: string | null }) => [e.id, e.full_name]));

  return requests.map(r => ({
    ...r,
    employee_name: nameMap.get(r.employee_id as number) || null,
  }));
};

export const salaryRaiseController = {
  create,
  update,
  getMy,
  getPending,
  getAll,
  getById,
  submit,
  cancel,
  supervisorReview,
  hrReview,
  financeReview,
  getUploadUrl,
  confirmAttachment,
  getAttachments,
  deleteAttachment,
};
