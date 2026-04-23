import { Response } from 'express';
import ExcelJS from 'exceljs';
import type { AuthenticatedRequest } from '../types/index.js';
import {
  fetchTimesheetDataForDepartment,
  type TimesheetExportRangeArg,
} from '../services/timesheet-export.service.js';
import { buildTimesheetSheet } from '../services/timesheet-excel.service.js';
import { resolveRequestDataScope, resolveScopedDepartmentId } from '../services/data-scope.service.js';

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

/** GET /api/timesheet/export?month=YYYY-MM&department_id=...&from=YYYY-MM-DD&to=YYYY-MM-DD&presentation=hr|manager */
export async function exportTimesheet(req: AuthenticatedRequest, res: Response) {
  try {
    const { month, department_id, presentation } = req.query;

    if (!month || typeof month !== 'string') {
      return res.status(400).json({ success: false, error: 'Параметр month обязателен' });
    }

    const rangeArg = resolveExportRangeArg(req.query as Record<string, unknown>);
    const requestedDepartmentId = department_id && typeof department_id === 'string' ? department_id : null;
    const scope = await resolveRequestDataScope(req);
    const deptId = await resolveScopedDepartmentId(req, requestedDepartmentId);
    if (scope === 'department' && !deptId) {
      return res.status(403).json({ success: false, error: 'Нет доступа к выбранной бригаде для экспорта' });
    }
    const explicitPresentation: 'hr' | 'manager' | null = presentation === 'manager'
      ? 'manager'
      : presentation === 'hr'
        ? 'hr'
        : null;
    const displayMode: 'actual' | 'capped_to_schedule' = explicitPresentation
      ? (explicitPresentation === 'manager' ? 'capped_to_schedule' : 'actual')
      : (scope === 'department' ? 'capped_to_schedule' : 'actual');
    const data = await fetchTimesheetDataForDepartment(month, deptId, rangeArg, displayMode);

    const wb = new ExcelJS.Workbook();
    buildTimesheetSheet(wb, 'Табель', data);

    const buf = await wb.xlsx.writeBuffer();
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

    const safeFileName = `${data.departmentName}_${MONTH_NAMES[data.mon]}_${data.year}${segmentSuffix}${presentationSuffix}.xlsx`
      .replace(/[\/\\?%*:|"<>]/g, '_');

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',
      `attachment; filename="${encodeURIComponent(safeFileName)}"; filename*=UTF-8''${encodeURIComponent(safeFileName)}`);
    res.send(Buffer.from(buf));
  } catch (err) {
    console.error('timesheet.export error:', err);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: 'Ошибка экспорта' });
    }
  }
}
