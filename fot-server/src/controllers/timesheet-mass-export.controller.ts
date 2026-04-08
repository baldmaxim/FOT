import { Response } from 'express';
import ExcelJS from 'exceljs';
import archiver from 'archiver';
import type { AuthenticatedRequest } from '../types/index.js';
import { fetchTimesheetDataForDepartment } from '../services/timesheet-export.service.js';
import { buildTimesheetSheet, sanitizeSheetName, NORMAL_RULES, BRIGADE_RULES } from '../services/timesheet-excel.service.js';

const MONTH_NAMES = ['', 'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

/** POST /api/timesheet/export-mass  body: { month, department_ids } */
export async function exportTimesheetMass(req: AuthenticatedRequest, res: Response) {
  try {
    const { month, department_ids } = req.body;

    if (!month || typeof month !== 'string') {
      return res.status(400).json({ success: false, error: 'Параметр month обязателен' });
    }
    if (!Array.isArray(department_ids) || department_ids.length === 0) {
      return res.status(400).json({ success: false, error: 'Нужно выбрать хотя бы один отдел' });
    }

    const [yearStr, monthStr] = month.split('-');
    const year = parseInt(yearStr);
    const mon = parseInt(monthStr);

    const zipFileName = `Табели_${MONTH_NAMES[mon]}_${year}.zip`
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
        batch.map((deptId: string) => fetchTimesheetDataForDepartment(month, deptId))
      );

      for (const data of results) {
        const rules = data.isBrigade ? BRIGADE_RULES : NORMAL_RULES;
        const wb = new ExcelJS.Workbook();
        buildTimesheetSheet(wb, sanitizeSheetName(data.departmentName), data, rules);

        const buf = await wb.xlsx.writeBuffer();

        let baseName = `${data.departmentName}_${MONTH_NAMES[mon]}_${year}`
          .replace(/[\/\\?%*:|"<>]/g, '_');
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
