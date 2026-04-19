import { Response } from 'express';
import ExcelJS from 'exceljs';
import archiver from 'archiver';
import { supabase } from '../config/database.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { resolveRequestDataScope, resolveManagedDepartmentIds } from '../services/data-scope.service.js';
import { loadEmployeeAccessMap } from '../services/department-access.service.js';
import {
  fetchTimesheetDataForDepartment,
  type TimesheetExportGrouping,
  type TimesheetExportHalf,
} from '../services/timesheet-export.service.js';
import {
  build1CObjectTimesheetWorkbook,
  build1CTimesheetWorkbook,
  buildObjectTimesheetSheet,
  buildTimesheetSheet,
  listObjectExportTargets,
  sanitizeSheetName,
} from '../services/timesheet-excel.service.js';
import { formatAssignedFolderName, formatNameWithInitials } from '../utils/fio.utils.js';

const MONTH_NAMES = ['', 'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

const sanitizeFileName = (value: string): string =>
  value.replace(/[\/\\?%*:|"<>]/g, '_').trim();

const normalizeGrouping = (value: unknown): TimesheetExportGrouping => (
  value === 'objects' ? 'objects' : 'employees'
);

const normalizeBoolean = (value: unknown): boolean => (
  value === true || value === 'true' || value === 1 || value === '1'
);

interface IAssignedEmployee {
  id: number;
  full_name: string;
  department_ids: string[];
}

async function collectAssignedEmployees(req: AuthenticatedRequest): Promise<{
  employees: IAssignedEmployee[];
  scope: 'all' | 'department';
} | { error: { status: number; message: string } }> {
  const scope = await resolveRequestDataScope(req);
  if (!scope || scope === 'self') {
    return { error: { status: 403, message: 'Недостаточно прав для экспорта назначенных' } };
  }

  const { data: rawEmployees, error: employeesError } = await supabase
    .from('employees')
    .select('id, full_name, employment_status, is_archived')
    .eq('employment_status', 'active')
    .eq('is_archived', false);
  if (employeesError) throw employeesError;

  const employeeIds = (rawEmployees || []).map(row => Number(row.id)).filter(Number.isFinite);
  const accessMap = await loadEmployeeAccessMap(employeeIds);

  let managedDepartmentIdsSet: Set<string> | null = null;
  if (scope === 'department') {
    const managed = await resolveManagedDepartmentIds(req);
    managedDepartmentIdsSet = new Set(managed);
    if (managedDepartmentIdsSet.size === 0) {
      return { error: { status: 403, message: 'Нет доступных отделов в области видимости' } };
    }
  }

  const employees: IAssignedEmployee[] = [];
  for (const row of rawEmployees || []) {
    const id = Number(row.id);
    const fullName = String(row.full_name || '').trim();
    const deptIds = accessMap.get(id) || [];
    const filteredDeptIds = managedDepartmentIdsSet
      ? deptIds.filter(dId => managedDepartmentIdsSet!.has(dId))
      : deptIds;
    if (filteredDeptIds.length === 0) continue;
    employees.push({ id, full_name: fullName, department_ids: filteredDeptIds });
  }

  employees.sort((a, b) => a.full_name.localeCompare(b.full_name, 'ru'));
  return { employees, scope: scope as 'all' | 'department' };
}

function dedupeName(usedNames: Set<string>, base: string): string {
  if (!usedNames.has(base)) {
    usedNames.add(base);
    return base;
  }
  let suffix = 2;
  while (usedNames.has(`${base}_${suffix}`)) suffix++;
  const next = `${base}_${suffix}`;
  usedNames.add(next);
  return next;
}

async function buildInnerZipBuffer(files: Array<{ name: string; data: Buffer }>): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const inner = archiver('zip', { zlib: { level: 5 } });
    const chunks: Buffer[] = [];
    inner.on('data', (chunk: Buffer) => chunks.push(chunk));
    inner.on('end', () => resolve(Buffer.concat(chunks)));
    inner.on('error', reject);
    for (const file of files) {
      inner.append(file.data, { name: file.name });
    }
    inner.finalize();
  });
}

async function buildFilesForAssignedEmployee(params: {
  employee: IAssignedEmployee;
  month: string;
  year: number;
  mon: number;
  exportHalf: TimesheetExportHalf;
  exportGrouping: TimesheetExportGrouping;
  exportAs1C: boolean;
  templateSuffix: string;
  presentationSuffix: string;
}): Promise<Array<{ name: string; data: Buffer }>> {
  const {
    employee,
    month,
    year,
    mon,
    exportHalf,
    exportGrouping,
    exportAs1C,
    templateSuffix,
    presentationSuffix,
  } = params;

  const leaderFio = formatNameWithInitials(employee.full_name);
  const usedNames = new Set<string>();
  const files: Array<{ name: string; data: Buffer }> = [];

  for (const departmentId of employee.department_ids) {
    const data = await fetchTimesheetDataForDepartment(month, departmentId, exportHalf, 'capped_to_schedule');
    if (data.employees.length === 0) continue;

    const halfSuffix = data.exportHalf === 'FULL'
      ? ''
      : `_${data.exportHalf === 'H1' ? '1-15' : `16-${data.daysInMonth}`}`;

    if (exportGrouping === 'objects') {
      for (const target of listObjectExportTargets(data)) {
        const wb = exportAs1C
          ? await build1CObjectTimesheetWorkbook(sanitizeSheetName(target.object_name), data, target)
          : new ExcelJS.Workbook();
        if (!exportAs1C) {
          buildObjectTimesheetSheet(wb, sanitizeSheetName(target.object_name), data, target);
        }
        const buf = await wb.xlsx.writeBuffer();
        let base = sanitizeFileName(`${data.departmentName}_${target.object_name}_${MONTH_NAMES[mon]}_${year}`);
        base += halfSuffix;
        base += templateSuffix;
        base += presentationSuffix;
        const unique = dedupeName(usedNames, base);
        files.push({ name: `${unique}.xlsx`, data: Buffer.from(buf) });
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
    let base = sanitizeFileName(`${data.departmentName}_${MONTH_NAMES[mon]}_${year}_${leaderFio || 'Руководитель'}`);
    base += halfSuffix;
    base += templateSuffix;
    base += presentationSuffix;
    const unique = dedupeName(usedNames, base);
    files.push({ name: `${unique}.xlsx`, data: Buffer.from(buf) });
  }

  return files;
}

/** GET /api/timesheet/assigned-employees → [{ id, full_name, department_count }] */
export async function listAssignedEmployees(req: AuthenticatedRequest, res: Response) {
  try {
    const result = await collectAssignedEmployees(req);
    if ('error' in result) {
      return res.status(result.error.status).json({ success: false, error: result.error.message });
    }
    const data = result.employees.map(employee => ({
      id: employee.id,
      full_name: employee.full_name,
      department_count: employee.department_ids.length,
    }));
    return res.json({ success: true, data });
  } catch (err) {
    console.error('timesheet.listAssignedEmployees error:', err);
    return res.status(500).json({ success: false, error: 'Ошибка загрузки назначенных сотрудников' });
  }
}

/** POST /api/timesheet/export-assigned  body: { month, half, group_by, export_as_1c, employee_ids? } */
export async function exportTimesheetAssigned(req: AuthenticatedRequest, res: Response) {
  try {
    const { month, half, group_by, export_as_1c, employee_ids } = req.body;

    if (!month || typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ success: false, error: 'Параметр month обязателен (формат YYYY-MM)' });
    }

    const [yearStr, monthStr] = month.split('-');
    const year = parseInt(yearStr);
    const mon = parseInt(monthStr);
    const exportHalf: TimesheetExportHalf = half === 'H1' || half === 'H2' || half === 'FULL'
      ? half
      : 'FULL';
    const exportGrouping = normalizeGrouping(group_by);
    const exportAs1C = normalizeBoolean(export_as_1c);
    const daysInMonth = new Date(year, mon, 0).getDate();
    const segmentSuffix = exportHalf === 'FULL'
      ? ''
      : `_${exportHalf === 'H1' ? '1-15' : `16-${daysInMonth}`}`;
    const templateSuffix = exportAs1C ? '_1С' : '';
    const presentationSuffix = '_Руководитель';

    const collected = await collectAssignedEmployees(req);
    if ('error' in collected) {
      return res.status(collected.error.status).json({ success: false, error: collected.error.message });
    }

    let assignedEmployees = collected.employees;

    if (Array.isArray(employee_ids) && employee_ids.length > 0) {
      const requested = new Set(
        employee_ids
          .map(value => Number(value))
          .filter(value => Number.isInteger(value)),
      );
      assignedEmployees = assignedEmployees.filter(employee => requested.has(employee.id));
    }

    if (assignedEmployees.length === 0) {
      return res.status(404).json({ success: false, error: 'Нет назначенных сотрудников для выгрузки' });
    }

    const zipFileName = sanitizeFileName(`Назначенные${templateSuffix}_${MONTH_NAMES[mon]}_${year}${segmentSuffix}${presentationSuffix}.zip`);

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(zipFileName)}"; filename*=UTF-8''${encodeURIComponent(zipFileName)}`,
    );

    const outerArchive = archiver('zip', { zlib: { level: 5 } });
    outerArchive.pipe(res);

    const usedInnerNames = new Set<string>();

    // Параллельная генерация по 3 сотрудника
    const CONCURRENCY = 3;
    for (let i = 0; i < assignedEmployees.length; i += CONCURRENCY) {
      const batch = assignedEmployees.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map(async employee => {
        const files = await buildFilesForAssignedEmployee({
          employee,
          month,
          year,
          mon,
          exportHalf,
          exportGrouping,
          exportAs1C,
          templateSuffix,
          presentationSuffix,
        });
        return { employee, files };
      }));

      for (const { employee, files } of results) {
        if (files.length === 0) continue;
        const baseFolder = sanitizeFileName(formatAssignedFolderName(employee.full_name));
        const innerName = `${dedupeName(usedInnerNames, baseFolder)}.zip`;
        const innerBuffer = await buildInnerZipBuffer(files);
        outerArchive.append(innerBuffer, { name: innerName });
      }
    }

    await outerArchive.finalize();
  } catch (err) {
    console.error('timesheet.exportAssigned error:', err);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: 'Ошибка экспорта назначенных' });
    }
  }
}
