import { Response } from 'express';
import ExcelJS from 'exceljs';
import type { AuthenticatedRequest } from '../types/index.js';
import {
  fetchTimesheetDataForDepartment,
  type TimesheetExportRangeArg,
} from '../services/timesheet-export.service.js';
import { buildTimesheetSheet, writeTimesheetWorkbookBuffer } from '../services/timesheet-excel.service.js';
import { resolveRequestDataScope, resolveScopedDepartmentId } from '../services/data-scope.service.js';
import { isDepartmentMonthAllowed, monthAccessFromUser, DEPARTMENT_MONTH_FORBIDDEN_MESSAGE } from '../utils/timesheet-month-access.js';

const MONTH_NAMES = ['', 'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function resolveExportRangeArg(query: Record<string, unknown>): TimesheetExportRangeArg {
  const from = query.from;
  const to = query.to;
  if (typeof from === 'string' && typeof to === 'string'
    && ISO_DATE_REGEX.test(from) && ISO_DATE_REGEX.test(to)
    && to >= from
  ) {
    return { startDate: from, endDate: to };
  }

  const half = query.half;
  return half === 'H1' || half === 'H2' || half === 'FULL' ? half : 'FULL';
}

/** GET /api/timesheet/export?month=YYYY-MM&department_id=...&employee_id=...&from=YYYY-MM-DD&to=YYYY-MM-DD&presentation=hr|manager */
export async function exportTimesheet(req: AuthenticatedRequest, res: Response) {
  try {
    const { month, department_id, presentation, employee_id } = req.query;

    if (!month || typeof month !== 'string') {
      return res.status(400).json({ success: false, error: 'Параметр month обязателен' });
    }

    const employeeIdRaw = typeof employee_id === 'string' ? Number.parseInt(employee_id, 10) : NaN;
    const employeeId = Number.isInteger(employeeIdRaw) && employeeIdRaw > 0 ? employeeIdRaw : null;

    const rangeArg = resolveExportRangeArg(req.query as Record<string, unknown>);
    const requestedDepartmentId = department_id && typeof department_id === 'string' ? department_id : null;
    const scope = await resolveRequestDataScope(req);
    const deptId = await resolveScopedDepartmentId(req, requestedDepartmentId);
    if (scope === 'department' && !deptId) {
      return res.status(403).json({ success: false, error: 'Нет доступа к выбранной бригаде для экспорта' });
    }
    if (scope === 'department') {
      const [yearStr, monthStr] = month.split('-');
      const year = Number.parseInt(yearStr, 10);
      const mon = Number.parseInt(monthStr, 10);
      if (Number.isFinite(year) && Number.isFinite(mon) && !isDepartmentMonthAllowed(year, mon, monthAccessFromUser(req.user))) {
        return res.status(403).json({ success: false, error: DEPARTMENT_MONTH_FORBIDDEN_MESSAGE });
      }
    }
    const explicitPresentation: 'hr' | 'manager' | null = presentation === 'manager'
      ? 'manager'
      : presentation === 'hr'
        ? 'hr'
        : null;
    const displayMode: 'actual' | 'capped_to_schedule' = explicitPresentation
      ? (explicitPresentation === 'manager' ? 'capped_to_schedule' : 'actual')
      : (scope === 'department' ? 'capped_to_schedule' : 'actual');
    const data = await fetchTimesheetDataForDepartment(
      month,
      deptId,
      rangeArg,
      displayMode,
      displayMode === 'actual',
    );

    // Выгрузка по одному сотруднику: оставляем в табеле только его строку.
    // buildTimesheetSheet итерирует только data.employees, остальные мапы
    // читаются по emp.id — лишние ключи безвредны.
    let exportData = data;
    let selectedEmployeeName: string | null = null;
    if (employeeId !== null) {
      const emp = data.employees.find(e => e.id === employeeId);
      if (!emp) {
        return res.status(404).json({ success: false, error: 'Сотрудник не найден в табеле бригады' });
      }
      exportData = { ...data, employees: [emp] };
      selectedEmployeeName = emp.full_name;
    }

    const wb = new ExcelJS.Workbook();
    buildTimesheetSheet(wb, 'Табель', exportData);

    const buf = await writeTimesheetWorkbookBuffer(wb);
    const isCustomRange = typeof rangeArg === 'object';
    let segmentSuffix = '';
    if (isCustomRange) {
      const [, , sd] = rangeArg.startDate.split('-');
      const [, , ed] = rangeArg.endDate.split('-');
      segmentSuffix = `_${Number(sd)}-${Number(ed)}`;
    } else if (data.exportHalf !== 'FULL') {
      segmentSuffix = `_${data.exportHalf === 'H1' ? '1-15' : `16-${data.daysInMonth}`}`;
    }
    const presentationSuffix = explicitPresentation === 'manager' ? '_Руководитель' : '';

    const rawFileName = selectedEmployeeName
      ? `Табель_${selectedEmployeeName}_${MONTH_NAMES[data.mon]}_${data.year}${segmentSuffix}.xlsx`
      : `${data.departmentName}_${MONTH_NAMES[data.mon]}_${data.year}${segmentSuffix}${presentationSuffix}.xlsx`;
    const safeFileName = rawFileName.replace(/[\/\\?%*:|"<>]/g, '_');

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',
      `attachment; filename="${encodeURIComponent(safeFileName)}"; filename*=UTF-8''${encodeURIComponent(safeFileName)}`);
    res.send(buf);
  } catch (err) {
    console.error('timesheet.export error:', err);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: 'Ошибка экспорта' });
    }
  }
}
