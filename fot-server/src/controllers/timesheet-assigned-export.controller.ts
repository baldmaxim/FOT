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
  fetchTimesheetDataForEmployees,
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
import { isDepartmentMonthAllowed, monthAccessFromUser, DEPARTMENT_MONTH_FORBIDDEN_MESSAGE } from '../utils/timesheet-month-access.js';

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
  direct_employee_ids: number[];
}

async function collectAssignedEmployees(req: AuthenticatedRequest): Promise<{
  employees: IAssignedEmployee[];
  scope: 'all' | 'department';
} | { error: { status: number; message: string } }> {
  const scope = await resolveRequestDataScope(req);
  if (!scope || scope === 'self') {
    return { error: { status: 403, message: 'Недостаточно прав для экспорта назначенных' } };
  }

  let managedIds: string[] | null = null;
  if (scope === 'department') {
    managedIds = await resolveManagedDepartmentIds(req);
    if (managedIds.length === 0) {
      return { error: { status: 403, message: 'Нет доступных отделов в области видимости' } };
    }
  }

  // 1) Назначения отделов через employee_department_access.
  // Только пользователи с ролью site_supervisor («Начальник участка»)
  // попадают в выгрузку.
  const edaWhere: string[] = [
    `eda.is_active = true`,
    `eda.source <> 'sigur_sync'`,
    `e.employment_status = 'active'`,
    `e.is_archived = false`,
    `e.excluded_from_timesheet = false`,
    `od.is_active = true`,
    `sr.code = 'site_supervisor'`,
  ];
  const edaParams: unknown[] = [];
  if (managedIds) {
    edaParams.push(managedIds);
    edaWhere.push(`eda.department_id = ANY($${edaParams.length}::uuid[])`);
  }

  const edaRows = await query<{
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
       INNER JOIN user_profiles up ON up.employee_id = e.id
       INNER JOIN system_roles sr ON sr.id = up.system_role_id
      WHERE ${edaWhere.join(' AND ')}`,
    edaParams,
  );

  // 2) Прямые назначения сотрудников через user_employee_access (миграция 090).
  // leader = user_profile.employee_id, подчинённый = uea.employee_id.
  // Department-scope: подчинённый должен попадать по primary org_department_id.
  const ueaWhere: string[] = [
    'uea.is_active = true',
    `sr.code = 'site_supervisor'`,
    `leader.employment_status = 'active'`,
    `leader.is_archived = false`,
    `direct.employment_status = 'active'`,
    `direct.is_archived = false`,
    `direct.excluded_from_timesheet = false`,
  ];
  const ueaParams: unknown[] = [];
  if (managedIds) {
    ueaParams.push(managedIds);
    ueaWhere.push(`direct.org_department_id = ANY($${ueaParams.length}::uuid[])`);
  }

  const ueaRows = await query<{
    leader_employee_id: number;
    direct_employee_id: number;
    leader_full_name: string | null;
    leader_email: string | null;
  }>(
    `SELECT leader.id   AS leader_employee_id,
            direct.id   AS direct_employee_id,
            leader.full_name AS leader_full_name,
            leader.email     AS leader_email
       FROM user_employee_access uea
       INNER JOIN user_profiles up ON up.id = uea.user_id
       INNER JOIN system_roles sr ON sr.id = up.system_role_id
       INNER JOIN employees leader ON leader.id = up.employee_id
       INNER JOIN employees direct ON direct.id = uea.employee_id
      WHERE ${ueaWhere.join(' AND ')}`,
    ueaParams,
  );

  type Entry = {
    full_name: string;
    email: string | null;
    department_ids: string[];
    direct_employee_ids: number[];
  };
  const byEmployee = new Map<number, Entry>();

  for (const row of edaRows) {
    const id = Number(row.employee_id);
    const departmentId = row.department_id;
    const fullName = String(row.full_name ?? '').trim();
    const email = typeof row.email === 'string' ? (row.email || null) : null;
    if (!Number.isFinite(id) || typeof departmentId !== 'string' || !departmentId.trim()) continue;
    const entry = byEmployee.get(id);
    if (entry) {
      if (!entry.department_ids.includes(departmentId)) entry.department_ids.push(departmentId);
    } else {
      byEmployee.set(id, { full_name: fullName, email, department_ids: [departmentId], direct_employee_ids: [] });
    }
  }

  for (const row of ueaRows) {
    const leaderId = Number(row.leader_employee_id);
    const directId = Number(row.direct_employee_id);
    const fullName = String(row.leader_full_name ?? '').trim();
    const email = typeof row.leader_email === 'string' ? (row.leader_email || null) : null;
    if (!Number.isFinite(leaderId) || !Number.isFinite(directId)) continue;
    const entry = byEmployee.get(leaderId);
    if (entry) {
      if (!entry.direct_employee_ids.includes(directId)) entry.direct_employee_ids.push(directId);
    } else {
      byEmployee.set(leaderId, {
        full_name: fullName,
        email,
        department_ids: [],
        direct_employee_ids: [directId],
      });
    }
  }

  const employees: IAssignedEmployee[] = Array.from(byEmployee.entries()).map(([id, value]) => ({
    id,
    full_name: value.full_name,
    email: value.email,
    department_ids: value.department_ids,
    direct_employee_ids: value.direct_employee_ids,
  }));

  employees.sort((a, b) => {
    const aHasDirect = a.direct_employee_ids.length > 0 ? 1 : 0;
    const bHasDirect = b.direct_employee_ids.length > 0 ? 1 : 0;
    if (aHasDirect !== bHasDirect) return bHasDirect - aHasDirect;
    return a.full_name.localeCompare(b.full_name, 'ru');
  });
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

  // Прямые сотрудники (миграция 090, user_employee_access).
  // Один сводный xlsx — fetchTimesheetDataForEmployees собирает по
  // явному списку id, без привязки к одному отделу.
  if (employee.direct_employee_ids.length > 0) {
    const directName = 'Прямые сотрудники';
    const directData = await fetchTimesheetDataForEmployees(
      month, employee.direct_employee_ids, directName, rangeArg, displayMode, showActualHours,
    );
    if (directData.employees.length > 0) {
      const wb = exportAs1C
        ? await build1CTimesheetWorkbook(sanitizeSheetName(directName), directData)
        : new ExcelJS.Workbook();
      if (!exportAs1C) {
        buildTimesheetSheet(wb, sanitizeSheetName(directName), directData);
      }
      const buf = await writeTimesheetWorkbookBuffer(wb);
      let base = sanitizeFileName(`${directName}_${MONTH_NAMES[mon]}_${year}_${leaderFio || 'Руководитель'}`);
      base += rangeSuffix;
      base += templateSuffix;
      base += presentationSuffix;
      const unique = dedupeName(usedNames, base);
      files.push({ name: `${unique}.xlsx`, data: buf });
    }
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
        direct_employee_count: employee.direct_employee_ids.length,
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

/**
 * Активные начальники участка (site_supervisor), закреплённые за бригадой через
 * ручную привязку employee_department_access (source <> 'sigur_sync'). Упорядочены
 * по ФИО. Вызывающий гарантирует, что departmentId — бригада (kind не проверяется).
 */
async function queryBrigadeSupervisorRows(
  departmentId: string,
): Promise<Array<{ id: number; full_name: string }>> {
  const rows = await query<{ id: number; full_name: string | null }>(
    `SELECT DISTINCT e.id, e.full_name
       FROM employee_department_access eda
       INNER JOIN employees e        ON e.id = eda.employee_id
       INNER JOIN org_departments od ON od.id = eda.department_id
       INNER JOIN user_profiles up   ON up.employee_id = e.id
       INNER JOIN system_roles sr    ON sr.id = up.system_role_id
      WHERE eda.department_id = $1
        AND eda.is_active = true
        AND eda.source <> 'sigur_sync'
        AND e.employment_status = 'active'
        AND e.is_archived = false
        AND od.is_active = true
        AND sr.code = 'site_supervisor'
      ORDER BY e.full_name`,
    [departmentId],
  );
  return rows
    .filter(row => Number.isFinite(Number(row.id)))
    .map(row => ({ id: Number(row.id), full_name: String(row.full_name ?? '').trim() }));
}

/**
 * ID начальников участка бригады для строки «Начальник участка» в сетке табеля.
 * Для не-бригад (и несуществующих отделов) возвращает []. Единый источник правды
 * с шапкой табеля (getDepartmentSupervisor).
 */
export async function listBrigadeSupervisorEmployeeIds(departmentId: string): Promise<number[]> {
  const dept = await query<{ kind: string | null }>(
    `SELECT kind FROM org_departments WHERE id = $1`,
    [departmentId],
  );
  if (dept.length === 0 || (dept[0].kind ?? 'department') !== 'brigade') return [];
  const rows = await queryBrigadeSupervisorRows(departmentId);
  return rows.map(row => row.id);
}

/**
 * GET /api/timesheet/department-supervisor?department_id=UUID
 * Начальник участка (site_supervisor), за которым закреплена бригада через
 * employee_department_access. Возвращает kind отдела и supervisor (или null).
 * Для не-бригад supervisor всегда null — поле на фронте скрывается по kind.
 */
export async function getDepartmentSupervisor(req: AuthenticatedRequest, res: Response) {
  try {
    const departmentId = typeof req.query.department_id === 'string' ? req.query.department_id.trim() : '';
    if (!departmentId) {
      return res.status(400).json({ success: false, error: 'Не указан department_id' });
    }

    const dept = await query<{ kind: string | null }>(
      `SELECT kind FROM org_departments WHERE id = $1`,
      [departmentId],
    );
    if (dept.length === 0) {
      return res.status(404).json({ success: false, error: 'Отдел не найден' });
    }
    const kind = dept[0].kind ?? 'department';

    let supervisor: { id: number; full_name: string } | null = null;
    if (kind === 'brigade') {
      const rows = await queryBrigadeSupervisorRows(departmentId);
      if (rows[0]) supervisor = rows[0];
    }

    return res.json({
      success: true,
      data: { department_id: departmentId, kind, supervisor },
    });
  } catch (err) {
    console.error('timesheet.getDepartmentSupervisor error:', err);
    return res.status(500).json({ success: false, error: 'Ошибка загрузки начальника участка' });
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
    if (collected.scope === 'department' && Number.isFinite(year) && Number.isFinite(mon) && !isDepartmentMonthAllowed(year, mon, monthAccessFromUser(req.user))) {
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
          showActualHours: displayMode === 'actual',
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
    if (collected.scope === 'department' && Number.isFinite(year) && Number.isFinite(mon) && !isDepartmentMonthAllowed(year, mon, monthAccessFromUser(req.user))) {
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
          showActualHours: displayMode === 'actual',
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
