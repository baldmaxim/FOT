import type { Response } from 'express';
import { z } from 'zod';
import { supabase } from '../config/database.js';
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

    const { data, error } = await supabase
      .from('production_calendar')
      .select('year, month, norm_days, norm_hours, holidays, mandatory_holidays, pre_holidays, is_custom, updated_by, updated_at')
      .eq('year', year)
      .order('month', { ascending: true });

    if (error) throw error;
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.json({ success: true, data: data || [] });
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

    const payload: Record<string, unknown> = {
      year,
      month,
      norm_days: parsed.data.norm_days,
      norm_hours: parsed.data.norm_hours,
      is_custom: true,
      updated_by: req.user.employee_id ?? null,
      updated_at: new Date().toISOString(),
    };
    if (parsed.data.holidays !== undefined) payload.holidays = parsed.data.holidays;
    if (parsed.data.mandatory_holidays !== undefined) payload.mandatory_holidays = parsed.data.mandatory_holidays;
    if (parsed.data.pre_holidays !== undefined) payload.pre_holidays = parsed.data.pre_holidays;

    const { data, error } = await supabase
      .from('production_calendar')
      .upsert(payload, { onConflict: 'year,month' })
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    console.error('production-calendar.update error:', err);
    res.status(500).json({ success: false, error: 'Ошибка обновления календаря' });
  }
};

export const productionCalendarController = { getByYear, update };
