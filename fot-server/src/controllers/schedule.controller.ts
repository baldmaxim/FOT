/**
 * Контроллер графиков работы: CRUD шаблонов, назначение отделам/сотрудникам.
 */
import { Response } from 'express';
import { z } from 'zod';
import { supabase } from '../config/database.js';
import { resolveSchedule, resolveSchedulesBulk } from '../services/schedule.service.js';
import { resolveRequestDataScope } from '../services/data-scope.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

const scheduleTypeEnum = z.enum(['office', 'remote', 'hybrid', 'shift']);
const patternTypeEnum = z.enum(['5+0', '5+2', '6+0', 'custom']);
const workCategoryCodeSchema = z.string().min(1).max(50).regex(/^[a-z0-9_]+$/);
const weekDayArray = z.array(z.number().int().min(1).max(7)).min(1).max(7);

const dayOverrideSchema = z.object({
  work_start: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  work_end: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  work_hours: z.number().min(0.5).max(24),
});

const baseScheduleSchema = z.object({
  name: z.string().min(1).max(100),
  schedule_type: scheduleTypeEnum,
  work_start: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  work_end: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  work_hours: z.number().min(0.5).max(24),
  work_days: weekDayArray,
  office_days: weekDayArray.nullable().optional(),
  late_threshold_minutes: z.number().int().min(0).max(120).optional(),
  day_overrides: z.record(z.string().regex(/^[1-7]$/), dayOverrideSchema).nullable().optional(),
  lunch_minutes: z.number().int().min(0).max(240).optional(),
  respects_holidays: z.boolean().optional(),
  pattern_type: patternTypeEnum.optional(),
  expected_saturdays_per_month: z.number().int().min(0).max(5).optional(),
  full_day_threshold_minutes: z.number().int().min(0).max(1440).nullable().optional(),
  weekend_full_day_threshold_minutes: z.number().int().min(0).max(1440).nullable().optional(),
});

const createScheduleSchema = baseScheduleSchema.refine((data) => {
  if (!data.day_overrides) return true;
  return Object.keys(data.day_overrides).every(k => data.work_days.includes(Number(k)));
}, { message: 'day_overrides keys must be in work_days' });

const assignCategorySchema = z.object({
  schedule_id: z.string().uuid(),
  effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  effective_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});
const employeeIdParamSchema = z.coerce.number().int().positive();
const assignEmployeeSchema = assignCategorySchema;
const effectiveDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const bulkBrigadeScheduleSchema = z.object({
  department_ids: z.array(z.string().uuid()).min(1),
  action: z.enum(['assign', 'reset']),
  schedule_id: z.string().uuid().optional(),
  effective_date: effectiveDateSchema,
}).superRefine((value, ctx) => {
  if (new Set(value.department_ids).size !== value.department_ids.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'department_ids должны быть уникальными',
      path: ['department_ids'],
    });
  }

  if (value.action === 'assign' && !value.schedule_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'schedule_id обязателен для assign',
      path: ['schedule_id'],
    });
  }
});

type EmployeeScheduleRow = {
  id: string;
  schedule_id: string;
  effective_from: string;
  effective_to: string | null;
};

const BRIGADE_PREFIX = 'бр.';

const shiftIsoDate = (date: string, days: number): string => {
  const cursor = new Date(`${date}T00:00:00Z`);
  cursor.setUTCDate(cursor.getUTCDate() + days);
  return cursor.toISOString().slice(0, 10);
};

const previousIsoDate = (date: string): string => shiftIsoDate(date, -1);

/** Нормализация HH:MM → HH:MM:SS */
const normalizeTime = (t: string): string => (t.length === 5 ? t + ':00' : t);

/** Нормализация day_overrides: time → HH:MM:SS */
const normalizeDayOverrides = (
  overrides: Record<string, { work_start: string; work_end: string; work_hours: number }> | null | undefined,
): Record<string, { work_start: string; work_end: string; work_hours: number }> | null => {
  if (!overrides) return null;
  const result: Record<string, { work_start: string; work_end: string; work_hours: number }> = {};
  for (const [key, val] of Object.entries(overrides)) {
    result[key] = {
      work_start: normalizeTime(val.work_start),
      work_end: normalizeTime(val.work_end),
      work_hours: val.work_hours,
    };
  }
  return result;
};

const isBrigadeDepartmentName = (name: string | null | undefined): boolean => (
  String(name || '').trim().toLowerCase().startsWith(BRIGADE_PREFIX)
);

const loadEmployeeScheduleRows = async (employeeId: number): Promise<EmployeeScheduleRow[]> => {
  const { data, error } = await supabase
    .from('employee_schedule_assignments')
    .select('id, schedule_id, effective_from, effective_to')
    .eq('employee_id', employeeId)
    .order('effective_from', { ascending: true });

  if (error) throw error;
  return (data || []) as EmployeeScheduleRow[];
};

const assignEmployeeSchedule = async (
  employeeId: number,
  scheduleId: string,
  effectiveFrom: string,
  createdBy: number | null,
  effectiveTo?: string | null,
): Promise<unknown> => {
  const rows = await loadEmployeeScheduleRows(employeeId);
  const nowIso = new Date().toISOString();
  const activeAtDate = rows.find(row => row.effective_from <= effectiveFrom && (row.effective_to === null || row.effective_to >= effectiveFrom)) || null;
  const nextAssignment = rows.find(row => row.effective_from > effectiveFrom) || null;

  if (activeAtDate?.effective_from === effectiveFrom) {
    const nextEffectiveTo = effectiveTo ?? (nextAssignment ? previousIsoDate(nextAssignment.effective_from) : activeAtDate.effective_to ?? null);
    const { data, error } = await supabase
      .from('employee_schedule_assignments')
      .update({
        schedule_id: scheduleId,
        effective_to: nextEffectiveTo,
        updated_at: nowIso,
      })
      .eq('id', activeAtDate.id)
      .select('*, work_schedules(*)')
      .single();

    if (error) throw error;
    return data;
  }

  if (activeAtDate && activeAtDate.effective_from < effectiveFrom) {
    const { error } = await supabase
      .from('employee_schedule_assignments')
      .update({ effective_to: previousIsoDate(effectiveFrom), updated_at: nowIso })
      .eq('id', activeAtDate.id);
    if (error) throw error;
  }

  const nextEffectiveTo = effectiveTo ?? (nextAssignment ? previousIsoDate(nextAssignment.effective_from) : null);
  const { data, error } = await supabase
    .from('employee_schedule_assignments')
    .insert({
      employee_id: employeeId,
      schedule_id: scheduleId,
      effective_from: effectiveFrom,
      effective_to: nextEffectiveTo,
      created_by: createdBy,
    })
    .select('*, work_schedules(*)')
    .single();

  if (error) throw error;
  return data;
};

const removeEmployeeSchedule = async (
  employeeId: number,
  effectiveDate: string,
): Promise<boolean> => {
  const rows = await loadEmployeeScheduleRows(employeeId);
  const nowIso = new Date().toISOString();
  const exactRow = rows.find(row => row.effective_from === effectiveDate) || null;
  if (exactRow) {
    const { error } = await supabase
      .from('employee_schedule_assignments')
      .delete()
      .eq('id', exactRow.id);

    if (error) throw error;
    return true;
  }

  const activeAtDate = rows.find(row => row.effective_from < effectiveDate && (row.effective_to === null || row.effective_to >= effectiveDate)) || null;
  if (!activeAtDate) {
    return false;
  }

  const { error } = await supabase
    .from('employee_schedule_assignments')
    .update({ effective_to: previousIsoDate(effectiveDate), updated_at: nowIso })
    .eq('id', activeAtDate.id);

  if (error) throw error;
  return true;
};

export const scheduleController = {
  /** GET /api/schedules — шаблоны */
  async list(_req: AuthenticatedRequest, res: Response) {
    try {
      const { data, error } = await supabase
        .from('work_schedules')
        .select('*')
        .order('is_default', { ascending: false })
        .order('name');

      if (error) throw error;
      res.json({ success: true, data });
    } catch (err) {
      console.error('[schedules] list error:', err);
      res.status(500).json({ success: false, error: 'Ошибка загрузки графиков' });
    }
  },

  /** POST /api/schedules — создать шаблон */
  async create(req: AuthenticatedRequest, res: Response) {
    try {
      const parsed = createScheduleSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ success: false, error: parsed.error.issues });

      const body = {
        ...parsed.data,
        work_start: normalizeTime(parsed.data.work_start),
        work_end: normalizeTime(parsed.data.work_end),
        day_overrides: normalizeDayOverrides(parsed.data.day_overrides),
      };

      const { data, error } = await supabase
        .from('work_schedules')
        .insert(body)
        .select()
        .single();

      if (error) throw error;
      res.status(201).json({ success: true, data });
    } catch (err) {
      console.error('[schedules] create error:', err);
      res.status(500).json({ success: false, error: 'Ошибка создания графика' });
    }
  },

  /** PUT /api/schedules/:id — обновить шаблон */
  async update(req: AuthenticatedRequest, res: Response) {
    try {
      const { id } = req.params;

      const parsed = baseScheduleSchema.partial().safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ success: false, error: parsed.error.issues });

      const body: Record<string, unknown> = { ...parsed.data, updated_at: new Date().toISOString() };
      if (parsed.data.work_start) body.work_start = normalizeTime(parsed.data.work_start);
      if (parsed.data.work_end) body.work_end = normalizeTime(parsed.data.work_end);
      if (parsed.data.day_overrides !== undefined) body.day_overrides = normalizeDayOverrides(parsed.data.day_overrides);

      const { data, error } = await supabase
        .from('work_schedules')
        .update(body)
        .eq('id', id)
        .select()
        .single();

      if (error) throw error;
      res.json({ success: true, data });
    } catch (err) {
      console.error('[schedules] update error:', err);
      res.status(500).json({ success: false, error: 'Ошибка обновления графика' });
    }
  },

  /** DELETE /api/schedules/:id — удалить шаблон (если не привязан к категории) */
  async remove(req: AuthenticatedRequest, res: Response) {
    try {
      const { id } = req.params;

      const [{ count: catCount }, { count: empCount }] = await Promise.all([
        supabase
          .from('category_schedules')
          .select('id', { count: 'exact', head: true })
          .eq('schedule_id', id),
        supabase
          .from('employee_schedule_assignments')
          .select('id', { count: 'exact', head: true })
          .eq('schedule_id', id),
      ]);

      if ((catCount || 0) > 0) {
        return res.status(409).json({ success: false, error: 'График привязан к категории труда, удалить нельзя' });
      }
      if ((empCount || 0) > 0) {
        return res.status(409).json({ success: false, error: 'График назначен сотрудникам, удалить нельзя' });
      }

      const { error } = await supabase
        .from('work_schedules')
        .delete()
        .eq('id', id)
        .eq('is_default', false);

      if (error) throw error;
      res.json({ success: true });
    } catch (err) {
      console.error('[schedules] remove error:', err);
      res.status(500).json({ success: false, error: 'Ошибка удаления графика' });
    }
  },

  /** GET /api/schedules/resolve/:empId?date=YYYY-MM-DD — resolve для сотрудника */
  async resolve(req: AuthenticatedRequest, res: Response) {
    try {
      const empId = parseInt(req.params.empId);
      const date = (req.query.date as string) || new Date().toISOString().slice(0, 10);

      const { data: emp } = await supabase
        .from('employees')
        .select('work_category')
        .eq('id', empId)
        .maybeSingle();

      const schedule = await resolveSchedule(
        empId,
        null,
        date,
        (emp?.work_category as string | null) || null,
      );
      res.json({ success: true, data: schedule });
    } catch (err) {
      console.error('[schedules] resolve error:', err);
      res.status(500).json({ success: false, error: 'Ошибка определения графика' });
    }
  },

  /** GET /api/schedules/resolve-bulk?employee_ids=1,2,3&date=YYYY-MM-DD */
  async resolveBulk(req: AuthenticatedRequest, res: Response) {
    try {
      const idsParam = req.query.employee_ids as string;
      if (!idsParam) return res.status(400).json({ success: false, error: 'employee_ids обязателен' });

      const employeeIds = idsParam.split(',').map(Number).filter(n => !isNaN(n));
      const date = (req.query.date as string) || new Date().toISOString().slice(0, 10);

      const { data: emps } = await supabase
        .from('employees')
        .select('id, work_category')
        .in('id', employeeIds);

      const employees = (emps || []).map(e => ({
        id: e.id as number,
        work_category: (e.work_category as string | null) || null,
      }));
      const schedules = await resolveSchedulesBulk(employees, date);

      const result: Record<number, unknown> = {};
      for (const [id, sched] of schedules) {
        result[id] = sched;
      }

      res.json({ success: true, data: result });
    } catch (err) {
      console.error('[schedules] resolveBulk error:', err);
      res.status(500).json({ success: false, error: 'Ошибка массового определения графиков' });
    }
  },

  /** GET /api/schedules/categories — список привязок category → schedule */
  async listCategories(_req: AuthenticatedRequest, res: Response) {
    try {
      const { data, error } = await supabase
        .from('category_schedules')
        .select('*, work_schedules(*)')
        .order('category')
        .order('effective_from', { ascending: false });

      if (error) throw error;
      res.json({ success: true, data: data || [] });
    } catch (err) {
      console.error('[schedules] listCategories error:', err);
      res.status(500).json({ success: false, error: 'Ошибка загрузки привязок категорий' });
    }
  },

  /** GET /api/schedules/employees?employee_ids=1,2,3 — активные персональные графики сотрудников */
  async listEmployeeAssignments(req: AuthenticatedRequest, res: Response) {
    try {
      const idsParam = req.query.employee_ids as string | undefined;
      if (!idsParam) return res.status(400).json({ success: false, error: 'employee_ids обязателен' });
      const today = new Date().toISOString().slice(0, 10);

      const employeeIds = idsParam
        .split(',')
        .map(v => Number(v))
        .filter(v => Number.isInteger(v) && v > 0);

      if (employeeIds.length === 0) {
        return res.status(400).json({ success: false, error: 'employee_ids должны содержать корректные id сотрудников' });
      }

      const { data, error } = await supabase
        .from('employee_schedule_assignments')
        .select('*, work_schedules(*)')
        .in('employee_id', employeeIds)
        .lte('effective_from', today)
        .or(`effective_to.is.null,effective_to.gte.${today}`)
        .order('employee_id')
        .order('effective_from', { ascending: false });

      if (error) throw error;
      res.json({ success: true, data: data || [] });
    } catch (err) {
      console.error('[schedules] listEmployeeAssignments error:', err);
      res.status(500).json({ success: false, error: 'Ошибка загрузки персональных графиков сотрудников' });
    }
  },

  /** PUT /api/schedules/category/:category — назначить график категории */
  async assignCategory(req: AuthenticatedRequest, res: Response) {
    try {
      const parsedCat = workCategoryCodeSchema.safeParse(req.params.category);
      if (!parsedCat.success) return res.status(400).json({ success: false, error: 'Неверная категория' });

      const parsed = assignCategorySchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ success: false, error: parsed.error.issues });

      await supabase
        .from('category_schedules')
        .update({ effective_to: previousIsoDate(parsed.data.effective_from) })
        .eq('category', parsedCat.data)
        .is('effective_to', null);

      const { data, error } = await supabase
        .from('category_schedules')
        .insert({
          category: parsedCat.data,
          schedule_id: parsed.data.schedule_id,
          effective_from: parsed.data.effective_from,
          effective_to: parsed.data.effective_to || null,
          created_by: req.user.employee_id,
        })
        .select('*, work_schedules(*)')
        .single();

      if (error) throw error;
      res.json({ success: true, data });
    } catch (err) {
      console.error('[schedules] assignCategory error:', err);
      res.status(500).json({ success: false, error: 'Ошибка назначения графика категории' });
    }
  },

  /** DELETE /api/schedules/category/:category — закрыть все активные привязки */
  async removeCategoryAssignment(req: AuthenticatedRequest, res: Response) {
    try {
      const parsedCat = workCategoryCodeSchema.safeParse(req.params.category);
      if (!parsedCat.success) return res.status(400).json({ success: false, error: 'Неверная категория' });

      const today = new Date().toISOString().slice(0, 10);
      const { error } = await supabase
        .from('category_schedules')
        .update({ effective_to: previousIsoDate(today) })
        .eq('category', parsedCat.data)
        .is('effective_to', null);

      if (error) throw error;
      res.json({ success: true });
    } catch (err) {
      console.error('[schedules] removeCategoryAssignment error:', err);
      res.status(500).json({ success: false, error: 'Ошибка снятия привязки категории' });
    }
  },

  /** PUT /api/schedules/employee/:employeeId — назначить персональный график сотруднику */
  async assignEmployee(req: AuthenticatedRequest, res: Response) {
    try {
      const parsedEmployeeId = employeeIdParamSchema.safeParse(req.params.employeeId);
      if (!parsedEmployeeId.success) {
        return res.status(400).json({ success: false, error: 'Неверный employeeId' });
      }

      const parsed = assignEmployeeSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ success: false, error: parsed.error.issues });

      const data = await assignEmployeeSchedule(
        parsedEmployeeId.data,
        parsed.data.schedule_id,
        parsed.data.effective_from,
        req.user.employee_id,
        parsed.data.effective_to,
      );

      res.json({ success: true, data });
    } catch (err) {
      console.error('[schedules] assignEmployee error:', err);
      res.status(500).json({ success: false, error: 'Ошибка назначения персонального графика сотруднику' });
    }
  },

  /** POST /api/schedules/brigades/bulk — массово назначить график сотрудникам выбранных бригад */
  async bulkApplyToBrigades(req: AuthenticatedRequest, res: Response) {
    try {
      const scope = await resolveRequestDataScope(req);
      if (!scope || scope === 'self') {
        return res.status(403).json({ success: false, error: 'Недостаточно прав для массового назначения графика по бригадам' });
      }

      const parsed = bulkBrigadeScheduleSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ success: false, error: parsed.error.issues });

      const { department_ids: departmentIds, action, schedule_id: scheduleId, effective_date: effectiveDate } = parsed.data;
      if (scope === 'department') {
        if (!req.user.department_id || departmentIds.some(id => id !== req.user.department_id)) {
          return res.status(403).json({ success: false, error: 'Можно назначать график только по своей бригаде' });
        }
      }

      const { data: departments, error: departmentsError } = await supabase
        .from('org_departments')
        .select('id, name')
        .in('id', departmentIds);

      if (departmentsError) throw departmentsError;

      if ((departments || []).length !== departmentIds.length) {
        return res.status(400).json({ success: false, error: 'Переданы несуществующие бригады' });
      }

      const invalidDepartments = (departments || []).filter(department => !isBrigadeDepartmentName(department.name as string | null | undefined));
      if (invalidDepartments.length > 0) {
        return res.status(400).json({ success: false, error: 'Можно выбирать только отделы-бригады' });
      }

      const { data: employees, error: employeesError } = await supabase
        .from('employees')
        .select('id')
        .in('org_department_id', departmentIds)
        .eq('is_archived', false)
        .neq('employment_status', 'fired');

      if (employeesError) throw employeesError;

      const employeeIds = (employees || []).map(row => row.id as number);
      let employeesUpdated = 0;
      const CHUNK_SIZE = 20;

      for (let index = 0; index < employeeIds.length; index += CHUNK_SIZE) {
        const chunk = employeeIds.slice(index, index + CHUNK_SIZE);
        const results = await Promise.all(chunk.map(async (employeeId) => {
          if (action === 'assign') {
            await assignEmployeeSchedule(employeeId, scheduleId!, effectiveDate, req.user.employee_id);
            return true;
          }
          return removeEmployeeSchedule(employeeId, effectiveDate);
        }));
        employeesUpdated += results.filter(Boolean).length;
      }

      res.json({
        success: true,
        data: {
          departments_processed: departmentIds.length,
          employees_matched: employeeIds.length,
          employees_updated: employeesUpdated,
        },
      });
    } catch (err) {
      console.error('[schedules] bulkApplyToBrigades error:', err);
      res.status(500).json({ success: false, error: 'Ошибка массового назначения графика по бригадам' });
    }
  },

  /** DELETE /api/schedules/employee/:employeeId — снять активный персональный график */
  async removeEmployeeAssignment(req: AuthenticatedRequest, res: Response) {
    try {
      const parsedEmployeeId = employeeIdParamSchema.safeParse(req.params.employeeId);
      if (!parsedEmployeeId.success) {
        return res.status(400).json({ success: false, error: 'Неверный employeeId' });
      }

      const parsedEffectiveTo = req.query.effective_to
        ? effectiveDateSchema.safeParse(req.query.effective_to)
        : { success: true as const, data: new Date().toISOString().slice(0, 10) };
      if (!parsedEffectiveTo.success) {
        return res.status(400).json({ success: false, error: 'Некорректная дата effective_to' });
      }

      const updated = await removeEmployeeSchedule(parsedEmployeeId.data, parsedEffectiveTo.data);
      if (!updated) {
        return res.json({ success: true });
      }
      res.json({ success: true });
    } catch (err) {
      console.error('[schedules] removeEmployeeAssignment error:', err);
      res.status(500).json({ success: false, error: 'Ошибка снятия персонального графика сотрудника' });
    }
  },
};
