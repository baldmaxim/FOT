import { Response } from 'express';
import ExcelJS from 'exceljs';
import type { AuthenticatedRequest } from '../types/index.js';
import { fetchTimesheetDataForDepartment, type TimesheetExportHalf } from '../services/timesheet-export.service.js';
import { buildTimesheetSheet } from '../services/timesheet-excel.service.js';
import { resolveRequestDataScope, resolveScopedDepartmentId } from '../services/data-scope.service.js';

const MONTH_NAMES = ['', 'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

/** GET /api/timesheet/export?month=YYYY-MM&department_id=...&presentation=hr|manager */
export async function exportTimesheet(req: AuthenticatedRequest, res: Response) {
  try {
    const { month, department_id, half, presentation } = req.query;

    if (!month || typeof month !== 'string') {
      return res.status(400).json({ success: false, error: 'Параметр month обязателен' });
    }

    const exportHalf: TimesheetExportHalf = half === 'H1' || half === 'H2' || half === 'FULL'
      ? half
      : 'FULL';
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
    const data = await fetchTimesheetDataForDepartment(month, deptId, exportHalf, displayMode);

    const wb = new ExcelJS.Workbook();
    buildTimesheetSheet(wb, 'Табель', data);

    const buf = await wb.xlsx.writeBuffer();
    const segmentSuffix = data.exportHalf === 'FULL'
      ? ''
      : `_${data.exportHalf === 'H1' ? '1-15' : `16-${data.daysInMonth}`}`;
    const presentationSuffix = explicitPresentation === 'manager' ? '_Руководитель' : '';

    const safeFileName = `${data.departmentName}_${MONTH_NAMES[data.mon]}_${data.year}${segmentSuffix}${presentationSuffix}.xlsx`
      .replace(/[\/\\?%*:|"<>]/g, '_');

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',
      `attachment; filename="${encodeURIComponent(safeFileName)}"; filename*=UTF-8''${encodeURIComponent(safeFileName)}`);
    res.send(Buffer.from(buf));
  } catch (err) {
    console.error('timesheet.export error:', err);
    res.status(500).json({ success: false, error: 'Ошибка экспорта' });
  }
}
