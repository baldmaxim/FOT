import { Response } from 'express';
import ExcelJS from 'exceljs';
import archiver from 'archiver';
import { query } from '../config/postgres.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { mailerService } from '../services/mailer.service.js';
import { localAuthService } from '../services/local-auth.service.js';
import { resolveRequestDataScope, resolveManagedDepartmentIds } from '../services/data-scope.service.js';
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
import { formatAssignedFolderName, formatNameWithInitials } from '../utils/fio.utils.js';
import { isDepartmentMonthAllowed, DEPARTMENT_MONTH_FORBIDDEN_MESSAGE } from '../utils/timesheet-month-access.js';

const MONTH_NAMES = ['', 'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

const sanitizeFileName = (value: string): string =>
  value.replace(/[\/\\?%*:|"<>]/g, '_').trim();

const normalizeGrouping = (value: unknown): TimesheetExportGrouping => (
  value === 'objects' ? 'objects' : 'employees'
);

const normalizePresentation = (value: unknown): TimesheetExportPresentation => (
  value === 'manager' ? 'manager' : 'hr'
);

const normalizeBoolean = (value: unknown): boolean => (
  value === true || value === 'true' || value === 1 || value === '1'
);

interface IAssignedEmployee {
  id: number;
  full_name: string;
  email: string | null;
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

  // Источники в employee_department_access:
  //   'sigur_sync' — членство (миграция 049 + employee-lifecycle), в HR-список не включаем.
  //   остальные (manual_admin_ui, excel_admin_ui, manager_excel_admin_ui, …) — ручные
  //   назначения начальников участков, их и показываем.
  const whereParts: string[] = [
    `eda.is_active = true`,
    `eda.source <> 'sigur_sync'`,
    `e.employment_status = 'active'`,
    `e.is_archived = false`,
    `e.excluded_from_timesheet = false`,
    `od.kind = 'brigade'`,
    `od.is_active = true`,
  ];
  const params: unknown[] = [];

  if (scope === 'department') {
    const managed = await resolveManagedDepartmentIds(req);
    if (managed.length === 0) {
      return { error: { status: 403, message: 'Нет доступных отделов в области видимости' } };
    }
    params.push(managed);
    whereParts.push(`eda.department_id = ANY($${params.length}::uuid[])`);
  }

  const accessRows = await query<{
    employee_id: number;
    department_id: string;
    full_name: string | null;
    email: string | null;
  }>(
    `SELECT eda.employee_id,
            eda.department_id,
            e.full_name,
            e.email
       FROM employee_department_access eda
       INNER JOIN employees e ON e.id = eda.employee_id
       INNER JOIN org_departments od ON od.id = eda.department_id
      WHERE ${whereParts.join(' AND ')}`,
    params,
  );

  const byEmployee = new Map<number, { full_name: string; email: string | null; department_ids: string[] }>();
  for (const row of accessRows) {
    const id = Number(row.employee_id);
    const departmentId = row.department_id;
    const fullName = String(row.full_name ?? '').trim();
    const email = typeof row.email === 'string' ? (row.email || null) : null;
    if (!Number.isFinite(id) || typeof departmentId !== 'string' || !departmentId.trim()) continue;
    const entry = byEmployee.get(id);
    if (entry) {
      if (!entry.department_ids.includes(departmentId)) entry.department_ids.push(departmentId);
    } else {
      byEmployee.set(id, { full_name: fullName, email, department_ids: [departmentId] });
    }
  }

  const employees: IAssignedEmployee[] = Array.from(byEmployee.entries()).map(([id, value]) => ({
    id,
    full_name: value.full_name,
    email: value.email,
    department_ids: value.department_ids,
  }));

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
  rangeArg: TimesheetExportRangeArg;
  rangeSuffix: string;
  exportGrouping: TimesheetExportGrouping;
  exportAs1C: boolean;
  templateSuffix: string;
  presentationSuffix: string;
  displayMode: 'actual' | 'capped_to_schedule';
  showActualHours: boolean;
}): Promise<Array<{ name: string; data: Buffer }>> {
  const {
    employee,
    month,
    year,
    mon,
    rangeArg,
    rangeSuffix,
    exportGrouping,
    exportAs1C,
    templateSuffix,
    presentationSuffix,
    displayMode,
    showActualHours,
  } = params;

  const leaderFio = formatNameWithInitials(employee.full_name);
  const usedNames = new Set<string>();
  const files: Array<{ name: string; data: Buffer }> = [];

  for (const departmentId of employee.department_ids) {
    const data = await fetchTimesheetDataForDepartment(
      month, departmentId, rangeArg, displayMode, showActualHours,
    );
    if (data.employees.length === 0) continue;

    const halfSuffix = rangeSuffix;

    if (exportGrouping === 'objects') {
      for (const target of listObjectExportTargets(data)) {
        const wb = exportAs1C
          ? await build1CObjectTimesheetWorkbook(sanitizeSheetName(target.object_name), data, target)
          : new ExcelJS.Workbook();
        if (!exportAs1C) {
          buildObjectTimesheetSheet(wb, sanitizeSheetName(target.object_name), data, target);
        }
        const buf = await writeTimesheetWorkbookBuffer(wb);
        let base = sanitizeFileName(`${data.departmentName}_${target.object_name}_${MONTH_NAMES[mon]}_${year}`);
        base += halfSuffix;
        base += templateSuffix;
        base += presentationSuffix;
        const unique = dedupeName(usedNames, base);
        files.push({ name: `${unique}.xlsx`, data: buf });
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
    let base = sanitizeFileName(`${data.departmentName}_${MONTH_NAMES[mon]}_${year}_${leaderFio || 'Руководитель'}`);
    base += halfSuffix;
    base += templateSuffix;
    base += presentationSuffix;
    const unique = dedupeName(usedNames, base);
    files.push({ name: `${unique}.xlsx`, data: buf });
  }

  return files;
}

/** GET /api/timesheet/assigned-employees → [{ id, full_name, department_count, email, departments: [{id, name}] }] */
export async function listAssignedEmployees(req: AuthenticatedRequest, res: Response) {
  try {
    const result = await collectAssignedEmployees(req);
    if ('error' in result) {
      return res.status(result.error.status).json({ success: false, error: result.error.message });
    }

    const allDeptIds = Array.from(new Set(result.employees.flatMap(employee => employee.department_ids)));
    const deptNameById = new Map<string, string>();
    if (allDeptIds.length > 0) {
      const depts = await query<{ id: string; name: string | null }>(
        `SELECT id, name FROM org_departments WHERE id = ANY($1::uuid[])`,
        [allDeptIds],
      );
      for (const row of depts) {
        if (typeof row.id === 'string' && typeof row.name === 'string') {
          deptNameById.set(row.id, row.name);
        }
      }
    }

    // Получаем email для каждого сотрудника через user_profiles → app_auth.users
    const employeeIds = result.employees.map(e => e.id);
    const emailByEmployeeId = new Map<number, string>();
    if (employeeIds.length > 0) {
      const profiles = await query<{ id: string; employee_id: number | null }>(
        `SELECT id, employee_id FROM user_profiles WHERE employee_id = ANY($1::int[])`,
        [employeeIds],
      );
      if (profiles.length > 0) {
        const profileIdToEmpId = new Map<string, number>();
        for (const p of profiles) {
          if (typeof p.id === 'string' && typeof p.employee_id === 'number') {
            profileIdToEmpId.set(p.id, p.employee_id);
          }
        }
        try {
          const emails = await localAuthService.getEmailsByUserIds([...profileIdToEmpId.keys()]);
          for (const [userId, email] of emails.entries()) {
            const empId = profileIdToEmpId.get(userId);
            if (empId !== undefined && email) {
              emailByEmployeeId.set(empId, email);
            }
          }
        } catch {
          // Email недоступен — продолжаем без него
        }
      }
    }

    const data = result.employees.map(employee => {
      const departments = employee.department_ids
        .map(id => ({ id, name: deptNameById.get(id) || 'Отдел' }))
        .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
      return {
        id: employee.id,
        full_name: employee.full_name,
        department_count: employee.department_ids.length,
        email: emailByEmployeeId.get(employee.id) ?? employee.email ?? null,
        departments,
      };
    });
    return res.json({ success: true, data });
  } catch (err) {
    console.error('timesheet.listAssignedEmployees error:', err);
    return res.status(500).json({ success: false, error: 'Ошибка загрузки назначенных сотрудников' });
  }
}

/** POST /api/timesheet/export-assigned  body: { month, half, group_by, export_as_1c, employee_ids? } */
export async function exportTimesheetAssigned(req: AuthenticatedRequest, res: Response) {
  try {
    const { month, half, from, to, group_by, export_as_1c, employee_ids, presentation } = req.body;

    if (!month || typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ success: false, error: 'Параметр month обязателен (формат YYYY-MM)' });
    }

    const [yearStr, monthStr] = month.split('-');
    const year = parseInt(yearStr);
    const mon = parseInt(monthStr);
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
    const displayMode: 'actual' | 'capped_to_schedule' = exportPresentation === 'manager'
      ? 'capped_to_schedule'
      : 'actual';
    const daysInMonth = new Date(year, mon, 0).getDate();
    let segmentSuffix = '';
    if (hasRange) {
      const sd = Number((from as string).slice(-2));
      const ed = Number((to as string).slice(-2));
      segmentSuffix = `_${sd}-${ed}`;
    } else if (exportHalf !== 'FULL') {
      segmentSuffix = `_${exportHalf === 'H1' ? '1-15' : `16-${daysInMonth}`}`;
    }
    const templateSuffix = exportAs1C ? '_1С' : '';
    const presentationSuffix = exportPresentation === 'manager' ? '_Руководитель' : '';

    const collected = await collectAssignedEmployees(req);
    if ('error' in collected) {
      return res.status(collected.error.status).json({ success: false, error: collected.error.message });
    }
    if (collected.scope === 'department' && Number.isFinite(year) && Number.isFinite(mon) && !isDepartmentMonthAllowed(year, mon)) {
      return res.status(403).json({ success: false, error: DEPARTMENT_MONTH_FORBIDDEN_MESSAGE });
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
          rangeArg,
          rangeSuffix: segmentSuffix,
          exportGrouping,
          exportAs1C,
          templateSuffix,
          presentationSuffix,
          displayMode,
          showActualHours: req.user.show_actual_hours,
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

/** POST /api/timesheet/email-assigned  body: { month, half, group_by, export_as_1c, employee_ids?, presentation? } */
export async function emailTimesheetAssigned(req: AuthenticatedRequest, res: Response) {
  try {
    if (!mailerService.isConfigured()) {
      return res.status(503).json({ success: false, error: 'Email-сервис не настроен (SMTP_HOST, SMTP_USER, SMTP_PASS)' });
    }

    const { month, half, from, to, group_by, export_as_1c, employee_ids, presentation } = req.body;

    if (!month || typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ success: false, error: 'Параметр month обязателен (формат YYYY-MM)' });
    }

    const [yearStr, monthStr] = month.split('-');
    const year = parseInt(yearStr);
    const mon = parseInt(monthStr);
    const isoDate = /^\d{4}-\d{2}-\d{2}$/;
    const hasRange = typeof from === 'string' && typeof to === 'string'
      && isoDate.test(from) && isoDate.test(to) && to >= from;
    const exportHalf: TimesheetExportHalf = half === 'H1' || half === 'H2' || half === 'FULL' ? half : 'FULL';
    const rangeArg: TimesheetExportRangeArg = hasRange
      ? { startDate: from as string, endDate: to as string }
      : exportHalf;
    const exportGrouping = normalizeGrouping(group_by);
    const exportPresentation = normalizePresentation(presentation);
    const exportAs1C = normalizeBoolean(export_as_1c);
    const displayMode: 'actual' | 'capped_to_schedule' = exportPresentation === 'manager' ? 'capped_to_schedule' : 'actual';
    const daysInMonth = new Date(year, mon, 0).getDate();
    let segmentSuffix = '';
    if (hasRange) {
      const sd = Number((from as string).slice(-2));
      const ed = Number((to as string).slice(-2));
      segmentSuffix = `_${sd}-${ed}`;
    } else if (exportHalf !== 'FULL') {
      segmentSuffix = `_${exportHalf === 'H1' ? '1-15' : `16-${daysInMonth}`}`;
    }
    const templateSuffix = exportAs1C ? '_1С' : '';
    const presentationSuffix = exportPresentation === 'manager' ? '_Руководитель' : '';

    const collected = await collectAssignedEmployees(req);
    if ('error' in collected) {
      return res.status(collected.error.status).json({ success: false, error: collected.error.message });
    }
    if (collected.scope === 'department' && Number.isFinite(year) && Number.isFinite(mon) && !isDepartmentMonthAllowed(year, mon)) {
      return res.status(403).json({ success: false, error: DEPARTMENT_MONTH_FORBIDDEN_MESSAGE });
    }

    let assignedEmployees = collected.employees;
    if (Array.isArray(employee_ids) && employee_ids.length > 0) {
      const requested = new Set(employee_ids.map(Number).filter(Number.isInteger));
      assignedEmployees = assignedEmployees.filter(e => requested.has(e.id));
    }

    if (assignedEmployees.length === 0) {
      return res.status(404).json({ success: false, error: 'Нет назначенных сотрудников для отправки' });
    }

    // Получаем email для выбранных сотрудников
    const empIds = assignedEmployees.map(e => e.id);
    const emailByEmployeeId = new Map<number, string>();
    const profiles = await query<{ id: string; employee_id: number | null }>(
      `SELECT id, employee_id FROM user_profiles WHERE employee_id = ANY($1::int[])`,
      [empIds],
    );
    if (profiles.length > 0) {
      const profileIdToEmpId = new Map<string, number>();
      for (const p of profiles) {
        if (typeof p.id === 'string' && typeof p.employee_id === 'number') {
          profileIdToEmpId.set(p.id, p.employee_id);
        }
      }
      const emails = await localAuthService.getEmailsByUserIds([...profileIdToEmpId.keys()]);
      for (const [userId, email] of emails.entries()) {
        const eid = profileIdToEmpId.get(userId);
        if (eid !== undefined && email) emailByEmployeeId.set(eid, email);
      }
    }
    // Фолбэк: брать email из таблицы employees, если auth-запись не найдена
    for (const e of assignedEmployees) {
      if (!emailByEmployeeId.has(e.id) && e.email) emailByEmployeeId.set(e.id, e.email);
    }

    const employeesWithEmail = assignedEmployees.filter(e => emailByEmployeeId.has(e.id));
    if (employeesWithEmail.length === 0) {
      return res.status(422).json({ success: false, error: 'Ни у одного из выбранных начальников участков нет email' });
    }

    const CONCURRENCY = 3;
    let sent = 0;
    let failed = 0;
    const errors: string[] = [];

    for (let i = 0; i < employeesWithEmail.length; i += CONCURRENCY) {
      const batch = employeesWithEmail.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async employee => {
        const email = emailByEmployeeId.get(employee.id)!;
        const files = await buildFilesForAssignedEmployee({
          employee,
          month,
          year,
          mon,
          rangeArg,
          rangeSuffix: segmentSuffix,
          exportGrouping,
          exportAs1C,
          templateSuffix,
          presentationSuffix,
          displayMode,
          showActualHours: req.user.show_actual_hours,
        });
        if (files.length === 0) return;

        const innerZip = await buildInnerZipBuffer(files);
        const zipName = sanitizeFileName(`${formatAssignedFolderName(employee.full_name)}${presentationSuffix}.zip`);
        const monthLabel = MONTH_NAMES[mon];
        try {
          await mailerService.sendWithAttachment({
            to: email,
            subject: `Табель ${monthLabel} ${year}${presentationSuffix ? ' (Руководитель)' : ''}`,
            text: `Здравствуйте,\n\nВо вложении табель за ${monthLabel} ${year}.\n\nС уважением, FOT`,
            attachments: [{ filename: zipName, content: innerZip, contentType: 'application/zip' }],
          });
          sent++;
        } catch (mailErr) {
          failed++;
          errors.push(`${employee.full_name} (${email}): ${mailErr instanceof Error ? mailErr.message : String(mailErr)}`);
        }
      }));
    }

    return res.json({
      success: true,
      data: { sent, failed, errors, skipped: assignedEmployees.length - employeesWithEmail.length },
    });
  } catch (err) {
    console.error('timesheet.emailAssigned error:', err);
    return res.status(500).json({ success: false, error: 'Ошибка отправки email' });
  }
}
