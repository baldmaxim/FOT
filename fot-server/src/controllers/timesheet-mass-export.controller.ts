import { Response } from 'express';
import ExcelJS from 'exceljs';
import archiver from 'archiver';
import type { AuthenticatedRequest } from '../types/index.js';
import {
  fetchTimesheetDataForDepartment,
  type TimesheetExportGrouping,
  type TimesheetExportHalf,
  type TimesheetExportPresentation,
} from '../services/timesheet-export.service.js';
import {
  build1CObjectTimesheetWorkbook,
  build1CTimesheetWorkbook,
  buildObjectTimesheetSheet,
  buildTimesheetSheet,
  listObjectExportTargets,
  sanitizeSheetName,
} from '../services/timesheet-excel.service.js';

const MONTH_NAMES = ['', 'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

const normalizeGrouping = (value: unknown): TimesheetExportGrouping => (
  value === 'objects' ? 'objects' : 'employees'
);

const normalizePresentation = (value: unknown): TimesheetExportPresentation => (
  value === 'manager' ? 'manager' : 'hr'
);

const normalizeBoolean = (value: unknown): boolean => (
  value === true || value === 'true' || value === 1 || value === '1'
);

const getPresentationFileSuffix = (presentation: TimesheetExportPresentation): string => (
  presentation === 'manager' ? '_Руководитель' : ''
);

/** POST /api/timesheet/export-mass  body: { month, department_ids, half } */
export async function exportTimesheetMass(req: AuthenticatedRequest, res: Response) {
  try {
    const { month, department_ids, half, group_by, presentation, export_as_1c } = req.body;

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
    const exportGrouping = normalizeGrouping(group_by);
    const exportPresentation = normalizePresentation(presentation);
    const exportAs1C = normalizeBoolean(export_as_1c);
    const displayMode = exportPresentation === 'manager' ? 'capped_to_schedule' : 'actual';
    const daysInMonth = new Date(year, mon, 0).getDate();
    const segmentSuffix = exportHalf === 'FULL'
      ? ''
      : `_${exportHalf === 'H1' ? '1-15' : `16-${daysInMonth}`}`;
    const presentationSuffix = getPresentationFileSuffix(exportPresentation);
    const templateSuffix = exportAs1C ? '_1С' : '';

    const zipPrefix = exportGrouping === 'objects' ? 'Табели_по_объектам' : 'Табели';
    const zipFileName = `${zipPrefix}${templateSuffix}_${MONTH_NAMES[mon]}_${year}${segmentSuffix}${presentationSuffix}.zip`
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
        batch.map((deptId: string) => fetchTimesheetDataForDepartment(month, deptId, exportHalf, displayMode))
      );

      for (const data of results) {
        if (exportGrouping === 'objects') {
          for (const target of listObjectExportTargets(data)) {
            const wb = exportAs1C
              ? await build1CObjectTimesheetWorkbook(sanitizeSheetName(target.object_name), data, target)
              : new ExcelJS.Workbook();

            if (!exportAs1C) {
              buildObjectTimesheetSheet(wb, sanitizeSheetName(target.object_name), data, target);
            }

            const buf = await wb.xlsx.writeBuffer();

            let baseName = `${data.departmentName}_${target.object_name}_${MONTH_NAMES[mon]}_${year}`
              .replace(/[\/\\?%*:|"<>]/g, '_');
            if (data.exportHalf !== 'FULL') {
              baseName += `_${data.exportHalf === 'H1' ? '1-15' : `16-${data.daysInMonth}`}`;
            }
            baseName += templateSuffix;
            baseName += presentationSuffix;
            if (usedNames.has(baseName)) {
              let suffix = 2;
              while (usedNames.has(`${baseName}_${suffix}`)) suffix++;
              baseName = `${baseName}_${suffix}`;
            }
            usedNames.add(baseName);

            archive.append(Buffer.from(buf), { name: `${baseName}.xlsx` });
          }
          continue;
        }

        const wb = exportAs1C
          ? await build1CTimesheetWorkbook(sanitizeSheetName(data.departmentName), data)
          : new ExcelJS.Workbook();

        if (!exportAs1C) {
          buildTimesheetSheet(wb, sanitizeSheetName(data.departmentName), data);
        }

        const buf = await wb.xlsx.writeBuffer();

        let baseName = `${data.departmentName}_${MONTH_NAMES[mon]}_${year}`
          .replace(/[\/\\?%*:|"<>]/g, '_');
        if (data.exportHalf !== 'FULL') {
          baseName += `_${data.exportHalf === 'H1' ? '1-15' : `16-${data.daysInMonth}`}`;
        }
        baseName += templateSuffix;
        baseName += presentationSuffix;
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
