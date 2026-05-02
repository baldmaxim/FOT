/**
 * Контроллер графиков работы: CRUD шаблонов, назначение отделам/сотрудникам.
 */
import { Response } from 'express';
import { z } from 'zod';
import { supabase } from '../config/database.js';
import { resolveSchedule, resolveSchedulesBulk, computeNetWorkHours } from '../services/schedule.service.js';
import { canAccessEmployeeInScope, resolveRequestDataScope, resolveScopedDepartmentIds } from '../services/data-scope.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

const scheduleTypeEnum = z.enum(['office', 'remote', 'hybrid', 'shift']);
const patternTypeEnum = z.enum(['5+0', '5+2', '6+0', 'custom']);
const weekDayArray = z.array(z.number().int().min(1).max(7)).min(1).max(7);

// work_hours принимается опционально и игнорируется — бэк сам пересчитывает из shift − lunch.
const dayOverrideSchema = z.object({
  work_start: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  work_end: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  work_hours: z.number().min(0).max(24).optional(),
});

const baseScheduleSchema = z.object({
  name: z.string().min(1).max(100),
  schedule_type: scheduleTypeEnum,
  work_start: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  work_end: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  work_hours: z.number().min(0).max(24).optional(),
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

const assignmentBodySchema = z.object({
  schedule_id: z.string().uuid(),
  effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  effective_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});
const employeeIdParamSchema = z.coerce.number().int().positive();
const objectIdParamSchema = z.string().uuid();
const assignEmployeeSchema = assignmentBodySchema;
const assignObjectSchema = assignmentBodySchema;
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

type ObjectScheduleRow = {
  id: string;
  schedule_id: string;
  effective_from: string;
  effective_to: string | null;
};

const shiftIsoDate = (date: string, days: number): string => {
  const cursor = new Date(`${date}T00:00:00Z`);
  cursor.setUTCDate(cursor.getUTCDate() + days);
  return cursor.toISOString().slice(0, 10);
};

const previousIsoDate = (date: string): string => shiftIsoDate(date, -1);

/** Нормализация HH:MM → HH:MM:SS */
const normalizeTime = (t: string): string => (t.length === 5 ? t + ':00' : t);

/**
 * Нормализация day_overrides: time → HH:MM:SS, work_hours пересчитывается бэком как нетто
 * (shift − lunch_minutes/60) — что прислал клиент в work_hours, игнорируется.
 */
const normalizeDayOverrides = (
  overrides: Record<string, { work_start: string; work_end: string; work_hours?: number }> | null | undefined,
  lunchMinutes: number,
): Record<string, { work_start: string; work_end: string; work_hours: number }> | null => {
  if (!overrides) return null;
  const result: Record<string, { work_start: string; work_end: string; work_hours: number }> = {};
  for (const [key, val] of Object.entries(overrides)) {
    const start = normalizeTime(val.work_start);
    const end = normalizeTime(val.work_end);
    result[key] = {
      work_start: start,
      work_end: end,
      work_hours: computeNetWorkHours(start, end, lunchMinutes),
    };
  }
  return result;
};

const loadEmployeeScheduleRows = async (employeeId: number): Promise<EmployeeScheduleRow[]> => {
  const { data, error } = await supabase
    .from('employee_schedule_assignments')
    .select('id, schedule_id, effective_from, effective_to')
    .eq('employee_id', employeeId)
    .order('effective_from', { ascending: true });

  if (error) throw error;
  return (data || []) as EmployeeScheduleRow[];
};

const loadEmployeeScheduleRowsBatch = async (
  employeeIds: number[],
): Promise<Map<number, EmployeeScheduleRow[]>> => {
  const result = new Map<number, EmployeeScheduleRow[]>();
  if (!employeeIds.length) return result;
  for (const id of employeeIds) result.set(id, []);

  const { data, error } = await supabase
    .from('employee_schedule_assignments')
    .select('id, employee_id, schedule_id, effective_from, effective_to')
    .in('employee_id', employeeIds)
    .order('effective_from', { ascending: true });

  if (error) throw error;

  for (const row of data || []) {
    const employeeId = Number((row as { employee_id?: unknown }).employee_id);
    if (!Number.isFinite(employeeId)) continue;
    const bucket = result.get(employeeId);
    if (!bucket) continue;
    bucket.push({
      id: (row as EmployeeScheduleRow).id,
      schedule_id: (row as EmployeeScheduleRow).schedule_id,
      effective_from: (row as EmployeeScheduleRow).effective_from,
      effective_to: (row as EmployeeScheduleRow).effective_to,
    });
  }
  return result;
};

const loadObjectScheduleRows = async (objectId: string): Promise<ObjectScheduleRow[]> => {
  const { data, error } = await supabase
    .from('object_schedule_assignments')
    .select('id, schedule_id, effective_from, effective_to')
    .eq('object_id', objectId)
    .order('effective_from', { ascending: true });

  if (error) throw error;
  return (data || []) as ObjectScheduleRow[];
};

const assignEmployeeSchedule = async (
  employeeId: number,
  scheduleId: string,
  effectiveFrom: string,
  createdBy: number | null,
  effectiveTo?: string | null,
  preloadedRows?: EmployeeScheduleRow[],
): Promise<unknown> => {
  const rows = preloadedRows ?? await loadEmployeeScheduleRows(employeeId);
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
  preloadedRows?: EmployeeScheduleRow[],
): Promise<boolean> => {
  const rows = preloadedRows ?? await loadEmployeeScheduleRows(employeeId);
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

const assignObjectSchedule = async (
  objectId: string,
  scheduleId: string,
  effectiveFrom: string,
  createdBy: number | null,
  effectiveTo?: string | null,
): Promise<unknown> => {
  const rows = await loadObjectScheduleRows(objectId);
  const nowIso = new Date().toISOString();
  const activeAtDate = rows.find(row => row.effective_from <= effectiveFrom && (row.effective_to === null || row.effective_to >= effectiveFrom)) || null;
  const nextAssignment = rows.find(row => row.effective_from > effectiveFrom) || null;

  if (activeAtDate?.effective_from === effectiveFrom) {
    const nextEffectiveTo = effectiveTo ?? (nextAssignment ? previousIsoDate(nextAssignment.effective_from) : activeAtDate.effective_to ?? null);
    const { data, error } = await supabase
      .from('object_schedule_assignments')
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
      .from('object_schedule_assignments')
      .update({ effective_to: previousIsoDate(effectiveFrom), updated_at: nowIso })
      .eq('id', activeAtDate.id);
    if (error) throw error;
  }

  const nextEffectiveTo = effectiveTo ?? (nextAssignment ? previousIsoDate(nextAssignment.effective_from) : null);
  const { data, error } = await supabase
    .from('object_schedule_assignments')
    .insert({
      object_id: objectId,
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

const removeObjectSchedule = async (
  objectId: string,
  effectiveDate: string,
): Promise<boolean> => {
  const rows = await loadObjectScheduleRows(objectId);
  const nowIso = new Date().toISOString();
  const exactRow = rows.find(row => row.effective_from === effectiveDate) || null;
  if (exactRow) {
    const { error } = await supabase
      .from('object_schedule_assignments')
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
    .from('object_schedule_assignments')
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

      const workStart = normalizeTime(parsed.data.work_start);
      const workEnd = normalizeTime(parsed.data.work_end);
      const lunchMinutes = parsed.data.lunch_minutes ?? 0;

      // work_hours хранится как нетто. Любое значение от клиента игнорируется
      // и пересчитывается на бэке из (shift_duration − lunch_minutes/60).
      const body = {
        ...parsed.data,
        work_start: workStart,
        work_end: workEnd,
        work_hours: computeNetWorkHours(workStart, workEnd, lunchMinutes),
        day_overrides: normalizeDayOverrides(parsed.data.day_overrides, lunchMinutes),
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

      // Если изменилось хотя бы одно из полей, влияющих на work_hours
      // (work_start / work_end / lunch_minutes / day_overrides), пересчитываем нетто.
      const affectsWorkHours = (
        parsed.data.work_start !== undefined
        || parsed.data.work_end !== undefined
        || parsed.data.lunch_minutes !== undefined
        || parsed.data.day_overrides !== undefined
      );

      const body: Record<string, unknown> = { ...parsed.data, updated_at: new Date().toISOString() };

      if (affectsWorkHours) {
        const { data: current, error: loadError } = await supabase
          .from('work_schedules')
          .select('work_start, work_end, lunch_minutes, day_overrides')
          .eq('id', id)
          .single();
        if (loadError) throw loadError;

        const workStart = normalizeTime(parsed.data.work_start ?? current!.work_start);
        const workEnd = normalizeTime(parsed.data.work_end ?? current!.work_end);
        const lunchMinutes = parsed.data.lunch_minutes ?? current!.lunch_minutes ?? 0;
        const overridesSource = parsed.data.day_overrides !== undefined
          ? parsed.data.day_overrides
          : current!.day_overrides;

        body.work_start = workStart;
        body.work_end = workEnd;
        body.work_hours = computeNetWorkHours(workStart, workEnd, lunchMinutes);
        body.day_overrides = normalizeDayOverrides(overridesSource as never, lunchMinutes);
      } else {
        // Безопасное игнорирование work_hours от клиента, если ничего связанного не менялось.
        delete body.work_hours;
      }

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

      const [{ count: empCount }, { count: objectCount }] = await Promise.all([
        supabase
          .from('employee_schedule_assignments')
          .select('id', { count: 'exact', head: true })
          .eq('schedule_id', id),
        supabase
          .from('object_schedule_assignments')
          .select('id', { count: 'exact', head: true })
          .eq('schedule_id', id),
      ]);

      if ((empCount || 0) > 0) {
        return res.status(409).json({ success: false, error: 'График назначен сотрудникам, удалить нельзя' });
      }
      if ((objectCount || 0) > 0) {
        return res.status(409).json({ success: false, error: 'График назначен объектам, удалить нельзя' });
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

      const schedule = await resolveSchedule(empId, null, date);
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

      const employees = employeeIds.map(id => ({ id }));
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

  /** GET /api/schedules/objects — список привязок object → schedule */
  async listObjectAssignments(_req: AuthenticatedRequest, res: Response) {
    try {
      const { data, error } = await supabase
        .from('object_schedule_assignments')
        .select('*, work_schedules(*)')
        .order('object_id')
        .order('effective_from', { ascending: false });

      if (error) throw error;
      res.json({ success: true, data: data || [] });
    } catch (err) {
      console.error('[schedules] listObjectAssignments error:', err);
      res.status(500).json({ success: false, error: 'Ошибка загрузки графиков объектов' });
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

      if (!(await canAccessEmployeeInScope(req, parsedEmployeeId.data))) {
        return res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      }

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

  /** PUT /api/schedules/object/:objectId — назначить график объекту */
  async assignObject(req: AuthenticatedRequest, res: Response) {
    try {
      const parsedObjectId = objectIdParamSchema.safeParse(req.params.objectId);
      if (!parsedObjectId.success) {
        return res.status(400).json({ success: false, error: 'Неверный objectId' });
      }

      const parsed = assignObjectSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ success: false, error: parsed.error.issues });

      const data = await assignObjectSchedule(
        parsedObjectId.data,
        parsed.data.schedule_id,
        parsed.data.effective_from,
        req.user.employee_id,
        parsed.data.effective_to,
      );

      res.json({ success: true, data });
    } catch (err) {
      console.error('[schedules] assignObject error:', err);
      res.status(500).json({ success: false, error: 'Ошибка назначения графика объекту' });
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
        const scopedDepartmentIds = await resolveScopedDepartmentIds(req, departmentIds);
        if (scopedDepartmentIds.length !== departmentIds.length) {
          return res.status(403).json({ success: false, error: 'Можно назначать график только по своей бригаде' });
        }
      }

      const { data: departments, error: departmentsError } = await supabase
        .from('org_departments')
        .select('id, name, kind')
        .in('id', departmentIds);

      if (departmentsError) throw departmentsError;

      if ((departments || []).length !== departmentIds.length) {
        return res.status(400).json({ success: false, error: 'Переданы несуществующие бригады' });
      }

      const invalidDepartments = (departments || []).filter(department => department.kind !== 'brigade');
      if (invalidDepartments.length > 0) {
        return res.status(400).json({ success: false, error: 'Можно выбирать только отделы-бригады' });
      }

      const { data: employees, error: employeesError } = await supabase
        .from('employees')
        .select('id')
        .in('org_department_id', departmentIds)
        .eq('is_archived', false)
        .eq('excluded_from_timesheet', false)
        .neq('employment_status', 'fired');

      if (employeesError) throw employeesError;

      const employeeIds = (employees || []).map(row => row.id as number);
      let employeesUpdated = 0;
      const CHUNK_SIZE = 20;

      const preloadedByEmployee = await loadEmployeeScheduleRowsBatch(employeeIds);

      for (let index = 0; index < employeeIds.length; index += CHUNK_SIZE) {
        const chunk = employeeIds.slice(index, index + CHUNK_SIZE);
        const results = await Promise.all(chunk.map(async (employeeId) => {
          const preloaded = preloadedByEmployee.get(employeeId) ?? [];
          if (action === 'assign') {
            await assignEmployeeSchedule(employeeId, scheduleId!, effectiveDate, req.user.employee_id, undefined, preloaded);
            return true;
          }
          return removeEmployeeSchedule(employeeId, effectiveDate, preloaded);
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

      if (!(await canAccessEmployeeInScope(req, parsedEmployeeId.data))) {
        return res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
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

  /** DELETE /api/schedules/object/:objectId — снять активный график объекта */
  async removeObjectAssignment(req: AuthenticatedRequest, res: Response) {
    try {
      const parsedObjectId = objectIdParamSchema.safeParse(req.params.objectId);
      if (!parsedObjectId.success) {
        return res.status(400).json({ success: false, error: 'Неверный objectId' });
      }

      const parsedEffectiveTo = req.query.effective_to
        ? effectiveDateSchema.safeParse(req.query.effective_to)
        : { success: true as const, data: new Date().toISOString().slice(0, 10) };
      if (!parsedEffectiveTo.success) {
        return res.status(400).json({ success: false, error: 'Некорректная дата effective_to' });
      }

      const updated = await removeObjectSchedule(parsedObjectId.data, parsedEffectiveTo.data);
      if (!updated) {
        return res.json({ success: true });
      }
      res.json({ success: true });
    } catch (err) {
      console.error('[schedules] removeObjectAssignment error:', err);
      res.status(500).json({ success: false, error: 'Ошибка снятия графика объекта' });
    }
  },
};
