import type { Request, Response } from 'express';
import { query } from '../config/postgres.js';
import { dataApiKeyService } from '../services/data-api-key.service.js';
import {
  fetchTimesheetDataForEmployees,
  type TimesheetExportHalf,
  type TimesheetExportRangeArg,
} from '../services/timesheet-export.service.js';
import {
  getDayNormHours,
  getFullDayThresholdHoursForDate,
  getScheduleForDate,
  isWorkingDay,
} from '../services/schedule.service.js';
import {
  listScopedMembersByDepartment,
  resolveTimesheetDateRange,
  resolveTimesheetPeriodRange,
} from '../services/timesheet-department-assignments.service.js';
import type { DataApiKeyContext } from '../middleware/dataApiAuth.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH_RE = /^\d{4}-\d{2}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_EMPLOYEE_EVENTS_RANGE_DAYS = 366;
const MAX_EMPLOYEE_EVENTS_LIMIT = 1000;

interface IDayValue {
  status: string;
  hours: number;
  corrected: boolean;
  hours_overridden: boolean;
  correction: {
    reason: string | null;
    corrected_by_name: string | null;
    corrected_at: string | null;
    approval_status: string | null;
    source_type: string | null;
  } | null;
}

interface IDayPlanValue {
  schedule_id: string;
  schedule_name: string | null;
  schedule_type: string;
  schedule_source: string;
  is_working_day: boolean;
  planned_hours: number;
  full_day_threshold_hours: number;
  work_start: string | null;
  work_end: string | null;
  lunch_minutes: number;
}

function parsePositiveInt(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseNonNegativeInt(value: unknown, fallback: number): number | null {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function getInclusiveRangeDays(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return Number.POSITIVE_INFINITY;
  return Math.floor((end - start) / 86_400_000) + 1;
}

function listIsoDates(from: string, to: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

export const publicDataApiController = {
  /**
   * GET /api/public/v1/employee-events
   *   ?employee_id=<FOT employee id>           — сотрудник, обязателен
   *   &from=YYYY-MM-DD&to=YYYY-MM-DD            — период, обязателен (до 366 дней)
   *   &limit=1..1000&offset=0                   — пагинация
   *
   * Возвращает только безопасную часть СКУД-событий: время, направление и точку
   * доступа. ФИО и номер карты намеренно не входят в контракт. Авторизация —
   * data-api Bearer токен; ключу должна быть открыта таблица skud_events.
   */
  async getEmployeeEvents(req: Request, res: Response): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');

    const keyCtx = (req as Request & { dataApiKey?: DataApiKeyContext }).dataApiKey;
    if (!keyCtx) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    let keyTables: Array<{ table_name: string; allowed_fields: string[] }>;
    try {
      keyTables = await dataApiKeyService.getKeyTables(keyCtx.id);
    } catch {
      res.status(500).json({ success: false, error: 'Failed to resolve key access' });
      return;
    }
    if (!keyTables.some(table => table.table_name === 'skud_events')) {
      res.status(403).json({
        success: false,
        error: 'Ключу не открыта таблица skud_events — события сотрудников недоступны',
      });
      return;
    }

    const employeeId = parsePositiveInt(req.query.employee_id);
    if (employeeId === null) {
      res.status(400).json({ success: false, error: 'employee_id должен быть положительным целым числом' });
      return;
    }

    const from = typeof req.query.from === 'string' ? req.query.from : '';
    const to = typeof req.query.to === 'string' ? req.query.to : '';
    if (!ISO_DATE_RE.test(from) || !ISO_DATE_RE.test(to) || to < from) {
      res.status(400).json({
        success: false,
        error: 'Параметры from и to обязательны в формате YYYY-MM-DD; to не может быть раньше from',
      });
      return;
    }
    if (getInclusiveRangeDays(from, to) > MAX_EMPLOYEE_EVENTS_RANGE_DAYS) {
      res.status(400).json({
        success: false,
        error: `Период событий не может превышать ${MAX_EMPLOYEE_EVENTS_RANGE_DAYS} дней`,
      });
      return;
    }

    const limit = parseNonNegativeInt(req.query.limit, 500);
    const offset = parseNonNegativeInt(req.query.offset, 0);
    if (limit === null || limit < 1 || limit > MAX_EMPLOYEE_EVENTS_LIMIT) {
      res.status(400).json({
        success: false,
        error: `limit должен быть целым числом от 1 до ${MAX_EMPLOYEE_EVENTS_LIMIT}`,
      });
      return;
    }
    if (offset === null) {
      res.status(400).json({ success: false, error: 'offset должен быть неотрицательным целым числом' });
      return;
    }

    try {
      const employeeRows = await query<{ id: number }>(
        'SELECT id FROM employees WHERE id = $1 LIMIT 1',
        [employeeId],
      );
      if (employeeRows.length === 0) {
        res.status(404).json({ success: false, error: 'Сотрудник не найден' });
        return;
      }

      const rows = await query<{
        id: number;
        employee_id: number;
        event_at: string | null;
        event_date: string;
        event_time: string;
        access_point: string | null;
        direction: 'entry' | 'exit' | null;
      }>(
        `SELECT id, employee_id, event_at, event_date, event_time, access_point, direction
           FROM skud_events
          WHERE employee_id = $1
            AND event_date >= $2
            AND event_date <= $3
          ORDER BY event_date DESC, event_time DESC, id DESC
          LIMIT $4 OFFSET $5`,
        [employeeId, from, to, limit + 1, offset],
      );
      const hasMore = rows.length > limit;

      res.json({
        success: true,
        period: { from, to },
        data: rows.slice(0, limit),
        pagination: {
          limit,
          offset,
          has_more: hasMore,
          next_offset: hasMore ? offset + limit : null,
        },
      });
    } catch (err) {
      console.error('publicDataApi.getEmployeeEvents error:', err);
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: 'Failed to fetch employee events' });
      }
    }
  },

  /**
   * GET /api/public/v1/timesheet
   *   ?department_id=<uuid[,uuid,...]>      — отдел(ы)/бригада(ы), обязателен
   *   &month=YYYY-MM                        — месяц, обязателен
   *   &half=FULL|H1|H2                      — половина месяца (по умолчанию FULL)
   *   ИЛИ &from=YYYY-MM-DD&to=YYYY-MM-DD     — произвольный диапазон внутри месяца
   *
   * Возвращает посчитанный табель (с учётом всех корректировок/adjustments) по
   * сотрудникам указанных отделов в формате «по дням». Авторизация — data-api
   * Bearer токен; ключу должна быть открыта таблица employees.
   *
   * Членство берётся ровно по переданным department_id (поддерево НЕ раскрывается —
   * чтобы включить подотделы/бригады, перечислите их id через запятую).
   */
  async getDepartmentTimesheet(req: Request, res: Response): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');

    const keyCtx = (req as Request & { dataApiKey?: DataApiKeyContext }).dataApiKey;
    if (!keyCtx) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    // Гейт: ключу должна быть открыта таблица employees (табель = данные сотрудников).
    let keyTables: Array<{ table_name: string; allowed_fields: string[] }>;
    try {
      keyTables = await dataApiKeyService.getKeyTables(keyCtx.id);
    } catch {
      res.status(500).json({ success: false, error: 'Failed to resolve key access' });
      return;
    }
    if (!keyTables.some(t => t.table_name === 'employees')) {
      res.status(403).json({ success: false, error: 'Ключу не открыта таблица employees — табель недоступен' });
      return;
    }

    // department_id: одна или несколько (через запятую) валидных UUID.
    const deptRaw = typeof req.query.department_id === 'string' ? req.query.department_id : '';
    const deptIds = [...new Set(deptRaw.split(',').map(s => s.trim()).filter(Boolean))];
    if (deptIds.length === 0) {
      res.status(400).json({ success: false, error: 'Параметр department_id обязателен' });
      return;
    }
    if (deptIds.some(id => !UUID_RE.test(id))) {
      res.status(400).json({ success: false, error: 'department_id должен быть UUID' });
      return;
    }

    const month = typeof req.query.month === 'string' ? req.query.month : '';
    if (!MONTH_RE.test(month)) {
      res.status(400).json({ success: false, error: 'Параметр month обязателен в формате YYYY-MM' });
      return;
    }

    const from = typeof req.query.from === 'string' ? req.query.from : undefined;
    const to = typeof req.query.to === 'string' ? req.query.to : undefined;
    const halfRaw = typeof req.query.half === 'string' ? req.query.half : '';
    const hasRange = !!from && !!to && ISO_DATE_RE.test(from) && ISO_DATE_RE.test(to) && to >= from;
    const exportHalf: TimesheetExportHalf =
      halfRaw === 'H1' || halfRaw === 'H2' || halfRaw === 'FULL' ? halfRaw : 'FULL';
    const rangeArg: TimesheetExportRangeArg = hasRange ? { startDate: from!, endDate: to! } : exportHalf;

    const periodRange = hasRange
      ? resolveTimesheetDateRange(month, from!, to!)
      : resolveTimesheetPeriodRange(month, exportHalf);
    if (!periodRange) {
      res.status(400).json({ success: false, error: 'Некорректный период' });
      return;
    }
    const { startDate, endDate } = periodRange;

    try {
      const deptNameRows = await query<{ id: string; name: string }>(
        'SELECT id, name FROM org_departments WHERE id = ANY($1::uuid[])',
        [deptIds],
      );
      const deptNameById = new Map(deptNameRows.map(r => [r.id, r.name]));

      // Членство сотрудников по отделам (assignment ∩ период ∪ snapshot ∪ dismissal-from).
      const memberByEmp = await listScopedMembersByDepartment(deptIds, startDate, endDate);
      const empIdsByDept = new Map<string, number[]>();
      for (const [empId, deptId] of memberByEmp) {
        const list = empIdsByDept.get(deptId);
        if (list) list.push(empId);
        else empIdsByDept.set(deptId, [empId]);
      }
      const allEmployeeIds = [...memberByEmp.keys()];

      // Один bulk-прогон сборщика табеля на всех сотрудников (тот же расчёт, что в «Едином 1С»).
      const bulk = await fetchTimesheetDataForEmployees(
        month, allEmployeeIds, 'API', rangeArg, 'actual', true,
      );

      const tabRows = allEmployeeIds.length > 0
        ? await query<{ id: number; tab_number: string | null }>(
          'SELECT id, tab_number FROM employees WHERE id = ANY($1::int[])',
          [allEmployeeIds],
        )
        : [];
      const tabById = new Map(tabRows.map(r => [r.id, r.tab_number]));
      const empById = new Map(bulk.employees.map(e => [e.id, e]));
      const entryByEmployeeDate = new Map(
        bulk.entries.map(entry => [`${entry.employee_id}|${entry.work_date}`, entry]),
      );
      const periodDates = listIsoDates(startDate, endDate);

      const departments = deptIds.map(deptId => {
        const empIds = empIdsByDept.get(deptId) ?? [];
        const employees = empIds.map(id => {
          const e = empById.get(id);
          const dayMap = bulk.dataMap.get(id);
          const days: Record<string, IDayValue> = {};
          const plans: Record<string, IDayPlanValue> = {};
          let total = 0;
          if (dayMap) {
            for (const [date, v] of dayMap) {
              const entry = entryByEmployeeDate.get(`${id}|${date}`);
              days[date] = {
                status: v.status,
                hours: v.hours,
                corrected: Boolean(v.corrected),
                hours_overridden: Boolean(v.hoursOverridden),
                correction: v.corrected ? {
                  reason: entry?.reason ?? entry?.notes ?? null,
                  corrected_by_name: entry?.corrected_by_name ?? null,
                  corrected_at: entry?.corrected_at ?? null,
                  approval_status: entry?.approval_status ?? null,
                  source_type: entry?.source_type ?? null,
                } : null,
              };
              if (typeof v.hours === 'number') total += v.hours;
            }
          }
          const employeeSchedules = bulk.dailySchedulesMap.get(id);
          for (const date of periodDates) {
            const schedule = employeeSchedules?.get(date);
            if (!schedule) continue;
            const [dateYear, dateMonth, dateDay] = date.split('-').map(Number);
            const dateObject = new Date(dateYear, dateMonth - 1, dateDay);
            const isWorking = isWorkingDay(schedule, dateObject, bulk.calendarMonth);
            const daySchedule = getScheduleForDate(schedule, dateObject);
            plans[date] = {
              schedule_id: schedule.schedule_id,
              schedule_name: schedule.name ?? null,
              schedule_type: schedule.schedule_type,
              schedule_source: schedule.source,
              is_working_day: isWorking,
              planned_hours: getDayNormHours(schedule, dateObject, bulk.calendarMonth),
              full_day_threshold_hours: isWorking
                ? getFullDayThresholdHoursForDate(schedule, dateObject, bulk.calendarMonth)
                : 0,
              work_start: isWorking ? daySchedule.work_start : null,
              work_end: isWorking ? daySchedule.work_end : null,
              lunch_minutes: isWorking ? daySchedule.lunch_minutes : 0,
            };
          }
          return {
            id,
            full_name: e?.full_name ?? null,
            tab_number: tabById.get(id) ?? null,
            sigur_employee_id: e?.sigur_employee_id ?? null,
            position: e?.position_id ? (bulk.posMap.get(e.position_id) ?? null) : null,
            total_hours: Math.round(total * 100) / 100,
            days,
            plans,
          };
        });
        return { id: deptId, name: deptNameById.get(deptId) ?? null, employees };
      });

      res.json({
        period: { month, start: startDate, end: endDate, half: hasRange ? 'RANGE' : exportHalf },
        departments,
      });
    } catch (err) {
      console.error('publicDataApi.getDepartmentTimesheet error:', err);
      // Текст ошибки уходит в data_api_request_logs через dataApiRequestLog.
      res.locals.dataApiError = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: 'Failed to build timesheet' });
      }
    }
  },
};
