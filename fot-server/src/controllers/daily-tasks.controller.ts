import type { Response } from 'express';
import { query, queryOne } from '../config/postgres.js';
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

    const data = await query(
      `SELECT * FROM daily_tasks
        WHERE employee_id = $1
        ORDER BY task_date DESC`,
      [employeeId],
    );
    res.json({ success: true, data });
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

    const data = await queryOne(
      `SELECT * FROM daily_tasks
        WHERE employee_id = $1 AND task_date = $2`,
      [employeeId, todayMoscowIso()],
    );
    res.json({ success: true, data });
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
    const nowIso = new Date().toISOString();

    const data = await queryOne(
      `INSERT INTO daily_tasks (employee_id, task_date, content, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (employee_id, task_date) DO UPDATE SET
         content = EXCLUDED.content,
         updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [employeeId, taskDate, content, nowIso],
    );

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
