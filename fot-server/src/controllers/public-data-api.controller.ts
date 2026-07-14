import type { Request, Response } from 'express';
import { query } from '../config/postgres.js';
import { dataApiKeyService } from '../services/data-api-key.service.js';
import {
  fetchTimesheetDataForEmployees,
  type TimesheetExportHalf,
  type TimesheetExportRangeArg,
} from '../services/timesheet-export.service.js';
import {
  listScopedMembersByDepartment,
  resolveTimesheetDateRange,
  resolveTimesheetPeriodRange,
} from '../services/timesheet-department-assignments.service.js';
import type { DataApiKeyContext } from '../middleware/dataApiAuth.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH_RE = /^\d{4}-\d{2}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface IDayValue {
  status: string;
  hours: number;
  corrected: boolean;
  hours_overridden: boolean;
}

export const publicDataApiController = {
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

      const departments = deptIds.map(deptId => {
        const empIds = empIdsByDept.get(deptId) ?? [];
        const employees = empIds.map(id => {
          const e = empById.get(id);
          const dayMap = bulk.dataMap.get(id);
          const days: Record<string, IDayValue> = {};
          let total = 0;
          if (dayMap) {
            for (const [date, v] of dayMap) {
              days[date] = {
                status: v.status,
                hours: v.hours,
                corrected: Boolean(v.corrected),
                hours_overridden: Boolean(v.hoursOverridden),
              };
              if (typeof v.hours === 'number') total += v.hours;
            }
          }
          return {
            id,
            full_name: e?.full_name ?? null,
            tab_number: tabById.get(id) ?? null,
            sigur_employee_id: e?.sigur_employee_id ?? null,
            position: e?.position_id ? (bulk.posMap.get(e.position_id) ?? null) : null,
            total_hours: Math.round(total * 100) / 100,
            days,
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
