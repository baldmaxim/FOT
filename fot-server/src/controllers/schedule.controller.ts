/**
 * Контроллер графиков работы: CRUD шаблонов, назначение отделам/сотрудникам.
 */
import { Response } from 'express';
import { z } from 'zod';
import { execute, query, queryOne } from '../config/postgres.js';
import { resolveSchedule, resolveSchedulesBulk, computeNetWorkHours } from '../services/schedule.service.js';
import { canAccessEmployeeInScope, resolveRequestDataScope, resolveScopedDepartmentIds } from '../services/data-scope.service.js';
import { collectDeptIds } from '../services/skud-shared.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

const scheduleTypeEnum = z.enum(['office', 'remote', 'hybrid', 'shift']);
const patternTypeEnum = z.enum(['5+0', '5+2', '6+0', 'custom', 'cycle']);
const weekDayArray = z.array(z.number().int().min(1).max(7)).min(1).max(7);

// work_hours принимается опционально и игнорируется — бэк сам пересчитывает из shift − lunch.
const dayOverrideSchema = z.object({
  work_start: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  work_end: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  work_hours: z.number().min(0).max(24).optional(),
  lunch_minutes: z.number().int().min(0).max(240).optional(),
});

const cycleDaySchema = z.object({
  work_hours: z.number().min(0).max(24),
  work_start: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(),
  work_end: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(),
  lunch_minutes: z.number().int().min(0).max(240).optional(),
});

const isoDateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const baseScheduleSchema = z.object({
  name: z.string().min(1).max(100),
  schedule_type: scheduleTypeEnum,
  work_start: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  work_end: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  work_hours: z.number().min(0).max(24).optional(),
  // work_days обязателен для не-cycle графиков; для cycle игнорируется (БД дефолт {1,2,3,4,5}).
  work_days: weekDayArray.optional(),
  office_days: weekDayArray.nullable().optional(),
  late_threshold_minutes: z.number().int().min(0).max(120).optional(),
  day_overrides: z.record(z.string().regex(/^[1-7]$/), dayOverrideSchema).nullable().optional(),
  lunch_minutes: z.number().int().min(0).max(240).optional(),
  respects_holidays: z.boolean().optional(),
  pattern_type: patternTypeEnum.optional(),
  expected_saturdays_per_month: z.number().int().min(0).max(5).optional(),
  full_day_threshold_minutes: z.number().int().min(0).max(1440).nullable().optional(),
  weekend_full_day_threshold_minutes: z.number().int().min(0).max(1440).nullable().optional(),
  cycle_length: z.number().int().min(2).max(28).nullable().optional(),
  cycle_days: z.array(cycleDaySchema).max(28).nullable().optional(),
  anchor_date: isoDateString.nullable().optional(),
});

const validateScheduleConsistency = (
  data: z.infer<typeof baseScheduleSchema>,
  ctx: z.RefinementCtx,
): void => {
  if (data.day_overrides && data.work_days) {
    const missing = Object.keys(data.day_overrides).find(
      (k) => !data.work_days!.includes(Number(k)),
    );
    if (missing) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'day_overrides keys must be in work_days', path: ['day_overrides'] });
    }
  }

  if (data.pattern_type === 'cycle') {
    if (data.cycle_length == null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'cycle_length обязателен для cycle', path: ['cycle_length'] });
    }
    if (!Array.isArray(data.cycle_days)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'cycle_days обязателен для cycle', path: ['cycle_days'] });
    } else if (data.cycle_length != null && data.cycle_days.length !== data.cycle_length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `cycle_days длина (${data.cycle_days.length}) не совпадает с cycle_length (${data.cycle_length})`,
        path: ['cycle_days'],
      });
    }
    if (!data.anchor_date) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'anchor_date обязателен для cycle', path: ['anchor_date'] });
    }
  } else {
    if (!data.work_days || data.work_days.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'work_days обязателен для не-cycle графика', path: ['work_days'] });
    }
  }
};

const createScheduleSchema = baseScheduleSchema.superRefine(validateScheduleConsistency);

const assignmentBodySchema = z.object({
  schedule_id: z.string().uuid(),
  effective_from: isoDateString,
  effective_to: isoDateString.nullable().optional(),
  anchor_date: isoDateString.nullable().optional(),
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

// Возвращает SELECT-список колонок таблицы назначений + work_schedules как jsonb,
// эмулируя `select('*, work_schedules(*)')` из Supabase.
const SCHEDULE_ASSIGNMENT_JOIN = (
  table: 'employee_schedule_assignments' | 'object_schedule_assignments',
  alias = 'a',
): string => {
  return `${alias}.*, to_jsonb(ws.*) AS work_schedules
     FROM ${table} ${alias}
     LEFT JOIN work_schedules ws ON ws.id = ${alias}.schedule_id`;
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
 * (shift − effectiveLunch/60). Если per-day lunch_minutes задан — используется он;
 * иначе fallback на глобальный schedule.lunch_minutes.
 */
const normalizeDayOverrides = (
  overrides: Record<string, { work_start: string; work_end: string; work_hours?: number; lunch_minutes?: number }> | null | undefined,
  lunchMinutes: number,
): Record<string, { work_start: string; work_end: string; work_hours: number; lunch_minutes?: number }> | null => {
  if (!overrides) return null;
  const result: Record<string, { work_start: string; work_end: string; work_hours: number; lunch_minutes?: number }> = {};
  for (const [key, val] of Object.entries(overrides)) {
    const start = normalizeTime(val.work_start);
    const end = normalizeTime(val.work_end);
    const effectiveLunch = val.lunch_minutes ?? lunchMinutes;
    result[key] = {
      work_start: start,
      work_end: end,
      work_hours: computeNetWorkHours(start, end, effectiveLunch),
      ...(val.lunch_minutes !== undefined ? { lunch_minutes: val.lunch_minutes } : {}),
    };
  }
  return result;
};

const loadEmployeeScheduleRows = async (employeeId: number): Promise<EmployeeScheduleRow[]> => {
  return query<EmployeeScheduleRow>(
    `SELECT id, schedule_id, effective_from, effective_to
       FROM employee_schedule_assignments
      WHERE employee_id = $1
      ORDER BY effective_from ASC`,
    [employeeId],
  );
};

const loadEmployeeScheduleRowsBatch = async (
  employeeIds: number[],
): Promise<Map<number, EmployeeScheduleRow[]>> => {
  const result = new Map<number, EmployeeScheduleRow[]>();
  if (!employeeIds.length) return result;
  for (const id of employeeIds) result.set(id, []);

  const data = await query<{ id: string; employee_id: number; schedule_id: string; effective_from: string; effective_to: string | null }>(
    `SELECT id, employee_id, schedule_id, effective_from, effective_to
       FROM employee_schedule_assignments
      WHERE employee_id = ANY($1::int[])
      ORDER BY effective_from ASC`,
    [employeeIds],
  );

  for (const row of data) {
    const employeeId = Number(row.employee_id);
    if (!Number.isFinite(employeeId)) continue;
    const bucket = result.get(employeeId);
    if (!bucket) continue;
    bucket.push({
      id: row.id,
      schedule_id: row.schedule_id,
      effective_from: row.effective_from,
      effective_to: row.effective_to,
    });
  }
  return result;
};

const loadObjectScheduleRows = async (objectId: string): Promise<ObjectScheduleRow[]> => {
  return query<ObjectScheduleRow>(
    `SELECT id, schedule_id, effective_from, effective_to
       FROM object_schedule_assignments
      WHERE object_id = $1
      ORDER BY effective_from ASC`,
    [objectId],
  );
};

const assignEmployeeSchedule = async (
  employeeId: number,
  scheduleId: string,
  effectiveFrom: string,
  createdBy: number | null,
  effectiveTo?: string | null,
  preloadedRows?: EmployeeScheduleRow[],
  anchorDate?: string | null,
): Promise<unknown> => {
  const rows = preloadedRows ?? await loadEmployeeScheduleRows(employeeId);
  const nowIso = new Date().toISOString();
  const activeAtDate = rows.find(row => row.effective_from <= effectiveFrom && (row.effective_to === null || row.effective_to >= effectiveFrom)) || null;
  const nextAssignment = rows.find(row => row.effective_from > effectiveFrom) || null;

  if (activeAtDate?.effective_from === effectiveFrom) {
    const nextEffectiveTo = effectiveTo ?? (nextAssignment ? previousIsoDate(nextAssignment.effective_from) : activeAtDate.effective_to ?? null);
    if (anchorDate !== undefined) {
      await execute(
        `UPDATE employee_schedule_assignments
            SET schedule_id = $1, effective_to = $2, updated_at = $3, anchor_date = $4
          WHERE id = $5`,
        [scheduleId, nextEffectiveTo, nowIso, anchorDate, activeAtDate.id],
      );
    } else {
      await execute(
        `UPDATE employee_schedule_assignments
            SET schedule_id = $1, effective_to = $2, updated_at = $3
          WHERE id = $4`,
        [scheduleId, nextEffectiveTo, nowIso, activeAtDate.id],
      );
    }
    const updated = await queryOne<Record<string, unknown>>(
      `SELECT ${SCHEDULE_ASSIGNMENT_JOIN('employee_schedule_assignments')} WHERE a.id = $1`,
      [activeAtDate.id],
    );
    if (!updated) throw new Error('Failed to load updated employee_schedule_assignment');
    return updated;
  }

  if (activeAtDate && activeAtDate.effective_from < effectiveFrom) {
    await execute(
      `UPDATE employee_schedule_assignments
          SET effective_to = $1, updated_at = $2
        WHERE id = $3`,
      [previousIsoDate(effectiveFrom), nowIso, activeAtDate.id],
    );
  }

  const nextEffectiveTo = effectiveTo ?? (nextAssignment ? previousIsoDate(nextAssignment.effective_from) : null);
  const inserted = await queryOne<{ id: string }>(
    anchorDate !== undefined
      ? `INSERT INTO employee_schedule_assignments
           (employee_id, schedule_id, effective_from, effective_to, created_by, anchor_date)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`
      : `INSERT INTO employee_schedule_assignments
           (employee_id, schedule_id, effective_from, effective_to, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    anchorDate !== undefined
      ? [employeeId, scheduleId, effectiveFrom, nextEffectiveTo, createdBy, anchorDate]
      : [employeeId, scheduleId, effectiveFrom, nextEffectiveTo, createdBy],
  );
  if (!inserted) throw new Error('Failed to insert employee_schedule_assignment');
  const data = await queryOne<Record<string, unknown>>(
    `SELECT ${SCHEDULE_ASSIGNMENT_JOIN('employee_schedule_assignments')} WHERE a.id = $1`,
    [inserted.id],
  );
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
    await execute('DELETE FROM employee_schedule_assignments WHERE id = $1', [exactRow.id]);
    return true;
  }

  const activeAtDate = rows.find(row => row.effective_from < effectiveDate && (row.effective_to === null || row.effective_to >= effectiveDate)) || null;
  if (!activeAtDate) {
    return false;
  }

  await execute(
    `UPDATE employee_schedule_assignments
        SET effective_to = $1, updated_at = $2
      WHERE id = $3`,
    [previousIsoDate(effectiveDate), nowIso, activeAtDate.id],
  );
  return true;
};

const assignObjectSchedule = async (
  objectId: string,
  scheduleId: string,
  effectiveFrom: string,
  createdBy: number | null,
  effectiveTo?: string | null,
  anchorDate?: string | null,
): Promise<unknown> => {
  const rows = await loadObjectScheduleRows(objectId);
  const nowIso = new Date().toISOString();
  const activeAtDate = rows.find(row => row.effective_from <= effectiveFrom && (row.effective_to === null || row.effective_to >= effectiveFrom)) || null;
  const nextAssignment = rows.find(row => row.effective_from > effectiveFrom) || null;

  if (activeAtDate?.effective_from === effectiveFrom) {
    const nextEffectiveTo = effectiveTo ?? (nextAssignment ? previousIsoDate(nextAssignment.effective_from) : activeAtDate.effective_to ?? null);
    if (anchorDate !== undefined) {
      await execute(
        `UPDATE object_schedule_assignments
            SET schedule_id = $1, effective_to = $2, updated_at = $3, anchor_date = $4
          WHERE id = $5`,
        [scheduleId, nextEffectiveTo, nowIso, anchorDate, activeAtDate.id],
      );
    } else {
      await execute(
        `UPDATE object_schedule_assignments
            SET schedule_id = $1, effective_to = $2, updated_at = $3
          WHERE id = $4`,
        [scheduleId, nextEffectiveTo, nowIso, activeAtDate.id],
      );
    }
    const updated = await queryOne<Record<string, unknown>>(
      `SELECT ${SCHEDULE_ASSIGNMENT_JOIN('object_schedule_assignments')} WHERE a.id = $1`,
      [activeAtDate.id],
    );
    if (!updated) throw new Error('Failed to load updated object_schedule_assignment');
    return updated;
  }

  if (activeAtDate && activeAtDate.effective_from < effectiveFrom) {
    await execute(
      `UPDATE object_schedule_assignments
          SET effective_to = $1, updated_at = $2
        WHERE id = $3`,
      [previousIsoDate(effectiveFrom), nowIso, activeAtDate.id],
    );
  }

  const nextEffectiveTo = effectiveTo ?? (nextAssignment ? previousIsoDate(nextAssignment.effective_from) : null);
  const inserted = await queryOne<{ id: string }>(
    anchorDate !== undefined
      ? `INSERT INTO object_schedule_assignments
           (object_id, schedule_id, effective_from, effective_to, created_by, anchor_date)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`
      : `INSERT INTO object_schedule_assignments
           (object_id, schedule_id, effective_from, effective_to, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    anchorDate !== undefined
      ? [objectId, scheduleId, effectiveFrom, nextEffectiveTo, createdBy, anchorDate]
      : [objectId, scheduleId, effectiveFrom, nextEffectiveTo, createdBy],
  );
  if (!inserted) throw new Error('Failed to insert object_schedule_assignment');
  const data = await queryOne<Record<string, unknown>>(
    `SELECT ${SCHEDULE_ASSIGNMENT_JOIN('object_schedule_assignments')} WHERE a.id = $1`,
    [inserted.id],
  );
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
    await execute('DELETE FROM object_schedule_assignments WHERE id = $1', [exactRow.id]);
    return true;
  }

  const activeAtDate = rows.find(row => row.effective_from < effectiveDate && (row.effective_to === null || row.effective_to >= effectiveDate)) || null;
  if (!activeAtDate) {
    return false;
  }

  await execute(
    `UPDATE object_schedule_assignments
        SET effective_to = $1, updated_at = $2
      WHERE id = $3`,
    [previousIsoDate(effectiveDate), nowIso, activeAtDate.id],
  );
  return true;
};

export const scheduleController = {
  /** GET /api/schedules — шаблоны */
  async list(_req: AuthenticatedRequest, res: Response) {
    try {
      const data = await query<Record<string, unknown>>(
        'SELECT * FROM work_schedules ORDER BY is_default DESC, name ASC',
      );
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

      const cols = Object.keys(body);
      const placeholders = cols.map((_, idx) => `$${idx + 1}`).join(', ');
      const values = cols.map(c => {
        const v = (body as Record<string, unknown>)[c];
        // jsonb-поля упаковываем как JSON; arrays оставляем как есть.
        if (c === 'day_overrides' || c === 'cycle_days') {
          return v == null ? null : JSON.stringify(v);
        }
        return v;
      });
      const data = await queryOne<Record<string, unknown>>(
        `INSERT INTO work_schedules (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`,
        values,
      );
      if (!data) throw new Error('Insert work_schedules вернул пустой результат');
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
        const current = await queryOne<{
          work_start: string;
          work_end: string;
          lunch_minutes: number | null;
          day_overrides: Record<string, unknown> | null;
        }>(
          'SELECT work_start, work_end, lunch_minutes, day_overrides FROM work_schedules WHERE id = $1',
          [id],
        );
        if (!current) throw new Error('График не найден');

        const workStart = normalizeTime(parsed.data.work_start ?? current.work_start);
        const workEnd = normalizeTime(parsed.data.work_end ?? current.work_end);
        const lunchMinutes = parsed.data.lunch_minutes ?? current.lunch_minutes ?? 0;
        const overridesSource = parsed.data.day_overrides !== undefined
          ? parsed.data.day_overrides
          : current.day_overrides;

        body.work_start = workStart;
        body.work_end = workEnd;
        body.work_hours = computeNetWorkHours(workStart, workEnd, lunchMinutes);
        body.day_overrides = normalizeDayOverrides(overridesSource as never, lunchMinutes);
      } else {
        // Безопасное игнорирование work_hours от клиента, если ничего связанного не менялось.
        delete body.work_hours;
      }

      const cols = Object.keys(body);
      if (cols.length === 0) {
        const data = await queryOne<Record<string, unknown>>(
          'SELECT * FROM work_schedules WHERE id = $1',
          [id],
        );
        return res.json({ success: true, data });
      }
      const setExpr = cols.map((c, idx) => `${c} = $${idx + 1}`).join(', ');
      const values = cols.map(c => {
        const v = body[c];
        if (c === 'day_overrides' || c === 'cycle_days') {
          return v == null ? null : JSON.stringify(v);
        }
        return v;
      });
      values.push(id);
      const data = await queryOne<Record<string, unknown>>(
        `UPDATE work_schedules SET ${setExpr} WHERE id = $${cols.length + 1} RETURNING *`,
        values,
      );
      if (!data) throw new Error('График не найден');
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

      const [empCountRow, objectCountRow] = await Promise.all([
        queryOne<{ count: string }>(
          'SELECT COUNT(*)::int AS count FROM employee_schedule_assignments WHERE schedule_id = $1',
          [id],
        ),
        queryOne<{ count: string }>(
          'SELECT COUNT(*)::int AS count FROM object_schedule_assignments WHERE schedule_id = $1',
          [id],
        ),
      ]);
      const empCount = Number(empCountRow?.count ?? 0);
      const objectCount = Number(objectCountRow?.count ?? 0);

      if (empCount > 0) {
        return res.status(409).json({ success: false, error: 'График назначен сотрудникам, удалить нельзя' });
      }
      if (objectCount > 0) {
        return res.status(409).json({ success: false, error: 'График назначен объектам, удалить нельзя' });
      }

      await execute(
        'DELETE FROM work_schedules WHERE id = $1 AND is_default = false',
        [id],
      );
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

      const data = await query<Record<string, unknown>>(
        `SELECT ${SCHEDULE_ASSIGNMENT_JOIN('employee_schedule_assignments')}
          WHERE a.employee_id = ANY($1::int[])
            AND a.effective_from <= $2
            AND (a.effective_to IS NULL OR a.effective_to >= $2)
          ORDER BY a.employee_id ASC, a.effective_from DESC`,
        [employeeIds, today],
      );
      res.json({ success: true, data });
    } catch (err) {
      console.error('[schedules] listEmployeeAssignments error:', err);
      res.status(500).json({ success: false, error: 'Ошибка загрузки персональных графиков сотрудников' });
    }
  },

  /** GET /api/schedules/objects — список привязок object → schedule */
  async listObjectAssignments(_req: AuthenticatedRequest, res: Response) {
    try {
      const data = await query<Record<string, unknown>>(
        `SELECT ${SCHEDULE_ASSIGNMENT_JOIN('object_schedule_assignments')}
          ORDER BY a.object_id ASC, a.effective_from DESC`,
      );
      res.json({ success: true, data });
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
        undefined,
        parsed.data.anchor_date,
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
        parsed.data.anchor_date,
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

      const departments = await query<{ id: string; name: string | null; kind: string | null }>(
        'SELECT id, name, kind FROM org_departments WHERE id = ANY($1::uuid[])',
        [departmentIds],
      );

      if (departments.length !== departmentIds.length) {
        return res.status(400).json({ success: false, error: 'Переданы несуществующие бригады' });
      }

      const invalidDepartments = departments.filter(department => department.kind !== 'brigade');
      if (invalidDepartments.length > 0) {
        return res.status(400).json({ success: false, error: 'Можно выбирать только отделы-бригады' });
      }

      // Расширяем выбор дочерними отделами бригады (collectDeptIds = отдел +
      // все потомки). Бригады обычно плоские, но это страхует случай, когда
      // сотрудники сидят на под-отделе бригады и иначе молча пропускались бы.
      const expandedDeptIds = Array.from(new Set(
        (await Promise.all(departmentIds.map(id => collectDeptIds(id)))).flat(),
      ));

      const employees = await query<{ id: number }>(
        `SELECT id FROM employees
          WHERE org_department_id = ANY($1::uuid[])
            AND is_archived = false
            AND excluded_from_timesheet = false
            AND employment_status <> 'fired'`,
        [expandedDeptIds],
      );

      const employeeIds = employees.map(row => row.id);
      let employeesUpdated = 0;
      let employeesFailed = 0;
      const sampleErrors: string[] = [];
      const CHUNK_SIZE = 20;

      const preloadedByEmployee = await loadEmployeeScheduleRowsBatch(employeeIds);

      // allSettled + per-employee try/catch: одна сбойная запись больше НЕ
      // роняет весь батч (раньше Promise.all → reject чанка → 500 → ни одной
      // выбранной бригаде график не выставлялся).
      for (let index = 0; index < employeeIds.length; index += CHUNK_SIZE) {
        const chunk = employeeIds.slice(index, index + CHUNK_SIZE);
        const results = await Promise.allSettled(chunk.map(async (employeeId) => {
          const preloaded = preloadedByEmployee.get(employeeId) ?? [];
          if (action === 'assign') {
            await assignEmployeeSchedule(employeeId, scheduleId!, effectiveDate, req.user.employee_id, undefined, preloaded);
            return true;
          }
          return removeEmployeeSchedule(employeeId, effectiveDate, preloaded);
        }));
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          if (r.status === 'fulfilled') {
            if (r.value) employeesUpdated++;
          } else {
            employeesFailed++;
            if (sampleErrors.length < 5) {
              sampleErrors.push(`emp ${chunk[i]}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
            }
          }
        }
      }

      const note = employeeIds.length === 0
        ? 'В выбранных бригадах нет активных сотрудников (исключённые из табеля, архивные и уволенные не учитываются)'
        : employeesFailed > 0
          ? `Не удалось обновить ${employeesFailed} из ${employeeIds.length}`
          : undefined;

      res.json({
        success: true,
        data: {
          departments_processed: departmentIds.length,
          employees_matched: employeeIds.length,
          employees_updated: employeesUpdated,
          employees_failed: employeesFailed,
          sample_errors: sampleErrors,
          ...(note ? { note } : {}),
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
