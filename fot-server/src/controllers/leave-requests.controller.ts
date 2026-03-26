import type { Response } from 'express';
import { supabase } from '../config/database.js';
import type { AuthenticatedRequest } from '../types/index.js';

const LEAVE_REQUEST_TYPES = ['vacation', 'sick_leave', 'remote', 'dayoff', 'business_trip', 'certificate'] as const;
const LEAVE_TO_TIMESHEET: Record<string, string> = {
  vacation: 'vacation',
  sick_leave: 'sick',
  remote: 'remote',
  dayoff: 'dayoff',
  business_trip: 'business_trip',
};

/** Создание заявления (worker+) */
const create = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { request_type, start_date, end_date, reason } = req.body;
    if (!request_type || !start_date || !end_date) {
      res.status(400).json({ success: false, error: 'request_type, start_date, end_date обязательны' });
      return;
    }
    if (!LEAVE_REQUEST_TYPES.includes(request_type)) {
      res.status(400).json({ success: false, error: 'Недопустимый тип заявления' });
      return;
    }

    const employeeId = req.user.employee_id;
    if (!employeeId) {
      res.status(400).json({ success: false, error: 'У пользователя нет привязки к сотруднику' });
      return;
    }

    const { data, error } = await supabase
      .from('leave_requests')
      .insert({
        organization_id: req.user.organization_id,
        employee_id: employeeId,
        request_type,
        start_date,
        end_date,
        reason: reason || null,
      })
      .select()
      .single();

    if (error) throw error;
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
    const departmentId = req.user.department_id;
    if (!departmentId) {
      res.json({ success: true, data: [] });
      return;
    }

    // Получаем id сотрудников отдела
    const { data: employees } = await supabase
      .from('employees')
      .select('id')
      .eq('org_department_id', departmentId)
      .eq('employment_status', 'active');

    const empIds = (employees || []).map(e => e.id);
    if (empIds.length === 0) {
      res.json({ success: true, data: [] });
      return;
    }

    const { data, error } = await supabase
      .from('leave_requests')
      .select('*')
      .in('employee_id', empIds)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err) {
    console.error('leave-requests.getDepartment error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения заявлений отдела' });
  }
};

/** Все заявления организации (hr/admin) */
const getAll = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const orgId = req.user.organization_id;
    let query = supabase
      .from('leave_requests')
      .select('*')
      .order('created_at', { ascending: false });

    if (orgId) {
      query = query.eq('organization_id', orgId);
    }

    const status = req.query.status as string | undefined;
    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err) {
    console.error('leave-requests.getAll error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения заявлений' });
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

    // header может одобрять только заявления своего отдела
    if (req.user.position_type === 'header') {
      const { data: emp } = await supabase
        .from('employees')
        .select('org_department_id')
        .eq('id', request.employee_id)
        .single();

      if (emp?.org_department_id !== req.user.department_id) {
        res.status(403).json({ success: false, error: 'Нет доступа к заявлениям другого отдела' });
        return;
      }
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

    // Создаём записи в табеле
    const timesheetStatus = LEAVE_TO_TIMESHEET[request.request_type];
    if (timesheetStatus) {
      const startDate = new Date(request.start_date);
      const endDate = new Date(request.end_date);
      const entries = [];

      for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
        const dayOfWeek = d.getDay();
        if (dayOfWeek === 0 || dayOfWeek === 6) continue; // Пропускаем выходные
        entries.push({
          employee_id: request.employee_id,
          work_date: d.toISOString().split('T')[0],
          status: timesheetStatus,
          hours_worked: null,
          is_correction: false,
        });
      }

      if (entries.length > 0) {
        await supabase.from('timesheet').upsert(entries, {
          onConflict: 'employee_id,work_date',
          ignoreDuplicates: false,
        });
      }
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

    // header: только свой отдел
    if (req.user.position_type === 'header') {
      const { data: emp } = await supabase
        .from('employees')
        .select('org_department_id')
        .eq('id', request.employee_id)
        .single();

      if (emp?.org_department_id !== req.user.department_id) {
        res.status(403).json({ success: false, error: 'Нет доступа к заявлениям другого отдела' });
        return;
      }
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
  getDepartment,
  getAll,
  approve,
  reject,
  cancel,
};
