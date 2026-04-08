import { Response } from 'express';
import ExcelJS from 'exceljs';
import type { AuthenticatedRequest } from '../types/index.js';
import { fetchTimesheetDataForDepartment } from '../services/timesheet-export.service.js';
import { buildTimesheetSheet, NORMAL_RULES, BRIGADE_RULES } from '../services/timesheet-excel.service.js';

const MONTH_NAMES = ['', 'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

/** GET /api/timesheet/export?month=YYYY-MM&department_id=... */
export async function exportTimesheet(req: AuthenticatedRequest, res: Response) {
  try {
    const { month, department_id } = req.query;

    if (!month || typeof month !== 'string') {
      return res.status(400).json({ success: false, error: 'Параметр month обязателен' });
    }

    const deptId = department_id && typeof department_id === 'string' ? department_id : null;
    const data = await fetchTimesheetDataForDepartment(month, deptId);

    const rules = data.isBrigade ? BRIGADE_RULES : NORMAL_RULES;

    const wb = new ExcelJS.Workbook();
    buildTimesheetSheet(wb, 'Табель', data, rules);

    const buf = await wb.xlsx.writeBuffer();

    const safeFileName = `${data.departmentName}_${MONTH_NAMES[data.mon]}_${data.year}.xlsx`
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
