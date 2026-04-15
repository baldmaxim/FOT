import { Response } from 'express';
import ExcelJS from 'exceljs';
import archiver from 'archiver';
import type { AuthenticatedRequest } from '../types/index.js';
import { fetchTimesheetDataForDepartment, type TimesheetExportHalf } from '../services/timesheet-export.service.js';
import { buildTimesheetSheet, sanitizeSheetName } from '../services/timesheet-excel.service.js';

const MONTH_NAMES = ['', 'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

/** POST /api/timesheet/export-mass  body: { month, department_ids, half } */
export async function exportTimesheetMass(req: AuthenticatedRequest, res: Response) {
  try {
    const { month, department_ids, half } = req.body;

    if (!month || typeof month !== 'string') {
      return res.status(400).json({ success: false, error: 'Параметр month обязателен' });
    }
    if (!Array.isArray(department_ids) || department_ids.length === 0) {
      return res.status(400).json({ success: false, error: 'Нужно выбрать хотя бы один отдел' });
    }

    const [yearStr, monthStr] = month.split('-');
    const year = parseInt(yearStr);
    const mon = parseInt(monthStr);
    const exportHalf: TimesheetExportHalf = half === 'H1' || half === 'H2' || half === 'FULL'
      ? half
      : 'FULL';
    const daysInMonth = new Date(year, mon, 0).getDate();
    const segmentSuffix = exportHalf === 'FULL'
      ? ''
      : `_${exportHalf === 'H1' ? '1-15' : `16-${daysInMonth}`}`;

    const zipFileName = `Табели_${MONTH_NAMES[mon]}_${year}${segmentSuffix}.zip`
      .replace(/[\/\\?%*:|"<>]/g, '_');

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition',
      `attachment; filename="${encodeURIComponent(zipFileName)}"; filename*=UTF-8''${encodeURIComponent(zipFileName)}`);

    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.pipe(res);

    // Обрабатываем по 5 отделов параллельно
    const CONCURRENCY = 5;
    const usedNames = new Set<string>();

    for (let i = 0; i < department_ids.length; i += CONCURRENCY) {
      const batch = department_ids.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map((deptId: string) => fetchTimesheetDataForDepartment(month, deptId, exportHalf))
      );

      for (const data of results) {
        const wb = new ExcelJS.Workbook();
        buildTimesheetSheet(wb, sanitizeSheetName(data.departmentName), data);

        const buf = await wb.xlsx.writeBuffer();

        let baseName = `${data.departmentName}_${MONTH_NAMES[mon]}_${year}`
          .replace(/[\/\\?%*:|"<>]/g, '_');
        if (data.exportHalf !== 'FULL') {
          baseName += `_${data.exportHalf === 'H1' ? '1-15' : `16-${data.daysInMonth}`}`;
        }
        if (usedNames.has(baseName)) {
          let suffix = 2;
          while (usedNames.has(`${baseName}_${suffix}`)) suffix++;
          baseName = `${baseName}_${suffix}`;
        }
        usedNames.add(baseName);

        archive.append(Buffer.from(buf), { name: `${baseName}.xlsx` });
      }
    }

    await archive.finalize();
  } catch (err) {
    console.error('timesheet.exportMass error:', err);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: 'Ошибка массового экспорта' });
    }
  }
}
