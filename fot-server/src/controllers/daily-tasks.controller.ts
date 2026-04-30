import type { Response } from 'express';
import { supabase } from '../config/database.js';
import type { AuthenticatedRequest } from '../types/index.js';

const MAX_CONTENT_LENGTH = 5000;

const todayMoscowIso = (): string => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return parts;
};

const getMy = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = req.user.employee_id;
    if (!employeeId) {
      res.json({ success: true, data: [] });
      return;
    }

    const { data, error } = await supabase
      .from('daily_tasks')
      .select('*')
      .eq('employee_id', employeeId)
      .order('task_date', { ascending: false });

    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err) {
    console.error('daily-tasks.getMy error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения задач' });
  }
};

const getToday = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = req.user.employee_id;
    if (!employeeId) {
      res.json({ success: true, data: null });
      return;
    }

    const { data, error } = await supabase
      .from('daily_tasks')
      .select('*')
      .eq('employee_id', employeeId)
      .eq('task_date', todayMoscowIso())
      .maybeSingle();

    if (error) throw error;
    res.json({ success: true, data: data || null });
  } catch (err) {
    console.error('daily-tasks.getToday error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения задач' });
  }
};

const upsert = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = req.user.employee_id;
    if (!employeeId) {
      res.status(400).json({ success: false, error: 'У пользователя нет привязки к сотруднику' });
      return;
    }

    const content = String(req.body?.content ?? '').trim();
    if (!content) {
      res.status(400).json({ success: false, error: 'Содержимое не может быть пустым' });
      return;
    }
    if (content.length > MAX_CONTENT_LENGTH) {
      res.status(400).json({ success: false, error: `Превышен лимит ${MAX_CONTENT_LENGTH} символов` });
      return;
    }

    const taskDate = todayMoscowIso();

    const { data, error } = await supabase
      .from('daily_tasks')
      .upsert(
        {
          employee_id: employeeId,
          task_date: taskDate,
          content,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'employee_id,task_date' },
      )
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    console.error('daily-tasks.upsert error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения задач' });
  }
};

export const dailyTasksController = {
  getMy,
  getToday,
  upsert,
};
