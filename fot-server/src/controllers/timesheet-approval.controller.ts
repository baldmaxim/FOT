import type { Response } from 'express';
import { supabase } from '../config/database.js';
import type { AuthenticatedRequest } from '../types/index.js';

/** Header подтверждает табель отдела за месяц */
const submit = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { department_id, period } = req.body;
    const deptId = department_id || req.user.department_id;

    if (!deptId || !period) {
      res.status(400).json({ success: false, error: 'department_id и period обязательны' });
      return;
    }

    // header может подтвердить только свой отдел
    if (req.user.position_type === 'header' && deptId !== req.user.department_id) {
      res.status(403).json({ success: false, error: 'Можно подтвердить только свой отдел' });
      return;
    }

    const { data, error } = await supabase
      .from('timesheet_approvals')
      .upsert({
        organization_id: req.user.organization_id,
        department_id: deptId,
        period,
        status: 'submitted',
        submitted_by: req.user.id,
        submitted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'department_id,period' })
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    console.error('timesheet-approval.submit error:', err);
    res.status(500).json({ success: false, error: 'Ошибка подтверждения табеля' });
  }
};

/** Статус согласования по отделу и периоду */
const getStatus = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const department_id = (req.query.department_id as string) || req.user.department_id;
    const period = req.query.period as string;

    if (!department_id || !period) {
      res.json({ success: true, data: null });
      return;
    }

    const { data, error } = await supabase
      .from('timesheet_approvals')
      .select('*')
      .eq('department_id', department_id)
      .eq('period', period)
      .maybeSingle();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    console.error('timesheet-approval.getStatus error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения статуса' });
  }
};

/** HR утверждает табель */
const approve = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    const { data: approval } = await supabase
      .from('timesheet_approvals')
      .select('*')
      .eq('id', id)
      .single();

    if (!approval) {
      res.status(404).json({ success: false, error: 'Запись не найдена' });
      return;
    }

    if (approval.status !== 'submitted') {
      res.status(400).json({ success: false, error: 'Табель не находится на проверке' });
      return;
    }

    const { data, error } = await supabase
      .from('timesheet_approvals')
      .update({
        status: 'approved',
        reviewed_by: req.user.id,
        reviewed_at: new Date().toISOString(),
        review_comment: req.body.comment || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    console.error('timesheet-approval.approve error:', err);
    res.status(500).json({ success: false, error: 'Ошибка утверждения' });
  }
};

/** HR отклоняет табель */
const reject = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { comment } = req.body;

    const { data: approval } = await supabase
      .from('timesheet_approvals')
      .select('*')
      .eq('id', id)
      .single();

    if (!approval) {
      res.status(404).json({ success: false, error: 'Запись не найдена' });
      return;
    }

    if (approval.status !== 'submitted') {
      res.status(400).json({ success: false, error: 'Табель не находится на проверке' });
      return;
    }

    const { data, error } = await supabase
      .from('timesheet_approvals')
      .update({
        status: 'rejected',
        reviewed_by: req.user.id,
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
    console.error('timesheet-approval.reject error:', err);
    res.status(500).json({ success: false, error: 'Ошибка отклонения' });
  }
};

/** HR: все неутверждённые табели */
const getPending = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const orgId = req.user.organization_id;
    let query = supabase
      .from('timesheet_approvals')
      .select('*')
      .eq('status', 'submitted')
      .order('submitted_at', { ascending: false });

    if (orgId) {
      query = query.eq('organization_id', orgId);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err) {
    console.error('timesheet-approval.getPending error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения списка' });
  }
};

export const timesheetApprovalController = { submit, getStatus, approve, reject, getPending };
