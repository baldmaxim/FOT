import { Response } from 'express';
import ExcelJS from 'exceljs';
import archiver from 'archiver';
import type { AuthenticatedRequest } from '../types/index.js';
import { resolveRequestDataScope, resolveScopedDepartmentIds } from '../services/data-scope.service.js';
import {
  fetchTimesheetDataForDepartment,
  type TimesheetExportGrouping,
  type TimesheetExportHalf,
  type TimesheetExportPresentation,
  type TimesheetExportRangeArg,
} from '../services/timesheet-export.service.js';
import {
  build1CObjectTimesheetWorkbook,
  build1CTimesheetWorkbook,
  buildObjectTimesheetSheet,
  buildTimesheetSheet,
  listObjectExportTargets,
  sanitizeSheetName,
  writeTimesheetWorkbookBuffer,
} from '../services/timesheet-excel.service.js';
import { isDepartmentMonthAllowed, monthAccessFromUser, DEPARTMENT_MONTH_FORBIDDEN_MESSAGE } from '../utils/timesheet-month-access.js';

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

/** POST /api/timesheet/export-mass  body: { month, department_ids, half?|from?/to?, ... } */
export async function exportTimesheetMass(req: AuthenticatedRequest, res: Response) {
  try {
    const { month, department_ids, half, from, to, group_by, presentation, export_as_1c } = req.body;

    if (!month || typeof month !== 'string') {
      return res.status(400).json({ success: false, error: 'Параметр month обязателен' });
    }
    if (!Array.isArray(department_ids) || department_ids.length === 0) {
      return res.status(400).json({ success: false, error: 'Нужно выбрать хотя бы один отдел' });
    }
    const scope = await resolveRequestDataScope(req);
    if (!scope || scope === 'self') {
      return res.status(403).json({ success: false, error: 'Недостаточно прав для массового экспорта табелей' });
    }
    const requestedDepartmentIds = [...new Set(
      department_ids
        .map((value: unknown) => typeof value === 'string' ? value : null)
        .filter((value): value is string => Boolean(value)),
    )];
    const scopedDepartmentIds = await resolveScopedDepartmentIds(req, requestedDepartmentIds);
    if (scope === 'department' && scopedDepartmentIds.length !== requestedDepartmentIds.length) {
      return res.status(403).json({ success: false, error: 'В массовый экспорт можно включать только назначенные бригады' });
    }
    if (scopedDepartmentIds.length === 0) {
      return res.status(400).json({ success: false, error: 'Нужно выбрать хотя бы один отдел' });
    }

    const [yearStr, monthStr] = month.split('-');
    const year = parseInt(yearStr);
    const mon = parseInt(monthStr);
    if (scope === 'department' && Number.isFinite(year) && Number.isFinite(mon) && !isDepartmentMonthAllowed(year, mon, monthAccessFromUser(req.user))) {
      return res.status(403).json({ success: false, error: DEPARTMENT_MONTH_FORBIDDEN_MESSAGE });
    }
    const isoDate = /^\d{4}-\d{2}-\d{2}$/;
    const hasRange = typeof from === 'string' && typeof to === 'string'
      && isoDate.test(from) && isoDate.test(to) && to >= from;
    const exportHalf: TimesheetExportHalf = half === 'H1' || half === 'H2' || half === 'FULL'
      ? half
      : 'FULL';
    const rangeArg: TimesheetExportRangeArg = hasRange
      ? { startDate: from as string, endDate: to as string }
      : exportHalf;
    const exportGrouping = normalizeGrouping(group_by);
    const exportPresentation = normalizePresentation(presentation);
    const exportAs1C = normalizeBoolean(export_as_1c);
    const displayMode = exportPresentation === 'manager' ? 'capped_to_schedule' : 'actual';
    const daysInMonth = new Date(year, mon, 0).getDate();
    let segmentSuffix = '';
    if (hasRange) {
      const sd = Number((from as string).slice(-2));
      const ed = Number((to as string).slice(-2));
      segmentSuffix = `_${sd}-${ed}`;
    } else if (exportHalf !== 'FULL') {
      segmentSuffix = `_${exportHalf === 'H1' ? '1-15' : `16-${daysInMonth}`}`;
    }
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

    for (let i = 0; i < scopedDepartmentIds.length; i += CONCURRENCY) {
      const batch = scopedDepartmentIds.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map((deptId: string) => fetchTimesheetDataForDepartment(
          month, deptId, rangeArg, displayMode, displayMode === 'actual',
        )),
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

            const buf = await writeTimesheetWorkbookBuffer(wb);

            let baseName = `${data.departmentName}_${target.object_name}_${MONTH_NAMES[mon]}_${year}`
              .replace(/[\/\\?%*:|"<>]/g, '_');
            baseName += segmentSuffix;
            baseName += templateSuffix;
            baseName += presentationSuffix;
            if (usedNames.has(baseName)) {
              let suffix = 2;
              while (usedNames.has(`${baseName}_${suffix}`)) suffix++;
              baseName = `${baseName}_${suffix}`;
            }
            usedNames.add(baseName);

            archive.append(buf, { name: `${baseName}.xlsx` });
          }
          continue;
        }

        const wb = exportAs1C
          ? await build1CTimesheetWorkbook(sanitizeSheetName(data.departmentName), data)
          : new ExcelJS.Workbook();

        if (!exportAs1C) {
          buildTimesheetSheet(wb, sanitizeSheetName(data.departmentName), data);
        }

        const buf = await writeTimesheetWorkbookBuffer(wb);

        let baseName = `${data.departmentName}_${MONTH_NAMES[mon]}_${year}`
          .replace(/[\/\\?%*:|"<>]/g, '_');
        baseName += segmentSuffix;
        baseName += templateSuffix;
        baseName += presentationSuffix;
        if (usedNames.has(baseName)) {
          let suffix = 2;
          while (usedNames.has(`${baseName}_${suffix}`)) suffix++;
          baseName = `${baseName}_${suffix}`;
        }
        usedNames.add(baseName);

        archive.append(buf, { name: `${baseName}.xlsx` });
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
