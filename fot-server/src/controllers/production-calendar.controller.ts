import type { Response } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../config/postgres.js';
import type { AuthenticatedRequest } from '../types/index.js';

const dateArraySchema = z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional();

const updateSchema = z.object({
  norm_days: z.number().int().min(0).max(31),
  norm_hours: z.number().min(0).max(800),
  holidays: dateArraySchema,
  mandatory_holidays: dateArraySchema,
  pre_holidays: dateArraySchema,
});

/** GET /api/production-calendar?year=YYYY */
const getByYear = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const year = parseInt(req.query.year as string);
    if (isNaN(year)) {
      res.status(400).json({ success: false, error: 'Параметр year обязателен' });
      return;
    }

    const data = await query(
      `SELECT year, month, norm_days, norm_hours, holidays, mandatory_holidays, pre_holidays, is_custom, updated_by, updated_at
         FROM production_calendar
        WHERE year = $1
        ORDER BY month ASC`,
      [year],
    );
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.json({ success: true, data });
  } catch (err) {
    console.error('production-calendar.getByYear error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения календаря' });
  }
};

/** PUT /api/production-calendar/:year/:month */
const update = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const year = parseInt(req.params.year);
    const month = parseInt(req.params.month);
    if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
      res.status(400).json({ success: false, error: 'Некорректные параметры year/month' });
      return;
    }

    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.issues });
      return;
    }

    const updatedBy = req.user.employee_id ?? null;
    const nowIso = new Date().toISOString();
    const holidays = parsed.data.holidays ?? null;
    const mandatoryHolidays = parsed.data.mandatory_holidays ?? null;
    const preHolidays = parsed.data.pre_holidays ?? null;

    const data = await queryOne(
      `INSERT INTO production_calendar
         (year, month, norm_days, norm_hours, is_custom, updated_by, updated_at,
          holidays, mandatory_holidays, pre_holidays)
       VALUES ($1, $2, $3, $4, true, $5, $6,
               COALESCE($7::date[], '{}'::date[]),
               COALESCE($8::date[], '{}'::date[]),
               COALESCE($9::date[], '{}'::date[]))
       ON CONFLICT (year, month) DO UPDATE SET
         norm_days = EXCLUDED.norm_days,
         norm_hours = EXCLUDED.norm_hours,
         is_custom = EXCLUDED.is_custom,
         updated_by = EXCLUDED.updated_by,
         updated_at = EXCLUDED.updated_at,
         holidays = CASE WHEN $7::date[] IS NULL THEN production_calendar.holidays ELSE EXCLUDED.holidays END,
         mandatory_holidays = CASE WHEN $8::date[] IS NULL THEN production_calendar.mandatory_holidays ELSE EXCLUDED.mandatory_holidays END,
         pre_holidays = CASE WHEN $9::date[] IS NULL THEN production_calendar.pre_holidays ELSE EXCLUDED.pre_holidays END
       RETURNING *`,
      [
        year,
        month,
        parsed.data.norm_days,
        parsed.data.norm_hours,
        updatedBy,
        nowIso,
        holidays,
        mandatoryHolidays,
        preHolidays,
      ],
    );

    res.json({ success: true, data });
  } catch (err) {
    console.error('production-calendar.update error:', err);
    res.status(500).json({ success: false, error: 'Ошибка обновления календаря' });
  }
};

export const productionCalendarController = { getByYear, update };
