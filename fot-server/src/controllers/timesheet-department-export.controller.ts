import { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';
import { query } from '../config/postgres.js';
import { resolveScopedDepartmentIds } from '../services/data-scope.service.js';
import { collectDeptIds } from '../services/skud-shared.service.js';
import {
  listScopedMembersByDepartment,
  resolveDepartmentIdsForEmployeesInPeriod,
} from '../services/timesheet-department-assignments.service.js';
import {
  filterEmployeeIdsByTimesheetScope,
  resolveTimesheetScope,
  resolveTimesheetScopedDepartmentId,
} from '../services/timesheet-scope.service.js';
import {
  isTimekeeper,
  resolveTimekeeperLiObshestroyPresenceIds,
  LI_OBSHESTROY_DEPARTMENT_ID,
} from '../services/timekeeper-scope.service.js';
import { buildUnified1CBuffer, parseStrictExportPeriod } from '../services/timesheet-unified-export.service.js';
import { listBrigadeSupervisorEmployeeIdsForDepartments } from './timesheet-assigned-export.controller.js';
import { isDepartmentMonthAllowed, isTimesheetWindowExempt, DEPARTMENT_MONTH_FORBIDDEN_MESSAGE } from '../utils/timesheet-month-access.js';

const MONTH_NAMES = ['', 'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/timesheet/export-department-unified
 * body: { department_id, month: 'YYYY-MM', from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }
 *
 * Единый файл для 1С по ОДНОМУ отделу со страницы «Табель» — тот же формат и те же
 * правила отбора, что у выгрузки «Единый файл для 1С» в «Табели HR».
 * Отдельный эндпоинт (а не расширение /export-mass-unified): один отдел вместо
 * произвольного набора + поддерево раскрывается на сервере, т.к. страница табеля,
 * в отличие от HR-дерева, шлёт один узел.
 */
export async function exportTimesheetDepartmentUnified(req: AuthenticatedRequest, res: Response) {
  try {
    const parsed = parseStrictExportPeriod(req.body ?? {});
    if (!parsed.ok) {
      return res.status(400).json({ success: false, error: parsed.error });
    }
    const { month, year, mon, startDate, endDate, rangeArg, segmentSuffix } = parsed.period;

    // UUID проверяем ДО резолвера: resolveScopedDepartmentId нормализует мусор в null
    // и возвращает первый доступный отдел — экспорт ушёл бы не по тому подразделению.
    const departmentId = typeof req.body?.department_id === 'string' ? req.body.department_id.trim() : '';
    if (!departmentId || !UUID_RE.test(departmentId)) {
      return res.status(400).json({ success: false, error: 'Не указан отдел для выгрузки' });
    }

    const scope = await resolveTimesheetScope(req);
    if (!scope) {
      return res.status(403).json({ success: false, error: 'Недостаточно прав для выгрузки табеля' });
    }
    if (!isTimesheetWindowExempt(req.user, scope) && !isDepartmentMonthAllowed(year, mon, {
      monthsBack: req.user.timesheet_months_back,
      monthsForward: req.user.timesheet_months_forward,
      referenceDate: new Date(),
    })) {
      return res.status(403).json({ success: false, error: DEPARTMENT_MONTH_FORBIDDEN_MESSAGE });
    }

    const scopedDepartmentId = await resolveTimesheetScopedDepartmentId(req, departmentId);
    if (scopedDepartmentId !== departmentId) {
      return res.status(403).json({ success: false, error: 'Нет доступа к выбранному отделу' });
    }

    let memberByEmp: Map<number, string | null>;
    let supervisorSet = new Set<number>();

    if (isTimekeeper(req) && departmentId === LI_OBSHESTROY_DEPARTMENT_ID) {
      // Табельщица на «ЛИНИЯ-Общестрой»: состав — не всё подразделение, а её люди
      // по присутствию на объектах за период (как в гриде).
      const liIds = [...await resolveTimekeeperLiObshestroyPresenceIds(req, startDate, endDate)];
      memberByEmp = await resolveDepartmentIdsForEmployeesInPeriod(liIds, startDate, endDate);
    } else {
      // Грид отдела показывает всё поддерево (collectDeptIds), а listScopedMembersByDepartment
      // потомков не раскрывает — раскрываем здесь и повторно пересекаем со скоупом.
      const expandedIds = await collectDeptIds(departmentId);
      const scopedDeptIds = await resolveScopedDepartmentIds(req, expandedIds);
      if (scopedDeptIds.length === 0) {
        return res.status(403).json({ success: false, error: 'Нет доступа к выбранному отделу' });
      }
      supervisorSet = await listBrigadeSupervisorEmployeeIdsForDepartments(scopedDeptIds);
      memberByEmp = new Map<number, string | null>(
        await listScopedMembersByDepartment(scopedDeptIds, startDate, endDate),
      );
    }

    const visible = await filterEmployeeIdsByTimesheetScope(req, [...memberByEmp.keys()], supervisorSet);
    if (visible.length !== memberByEmp.size) {
      const visibleSet = new Set(visible);
      memberByEmp = new Map([...memberByEmp].filter(([empId]) => visibleSet.has(empId)));
    }

    if (memberByEmp.size === 0) {
      return res.status(422).json({ success: false, error: 'Нет сотрудников для выгрузки за выбранный период' });
    }

    const buffer = await buildUnified1CBuffer({
      month, rangeArg, memberByEmp, exemptEmployeeIds: supervisorSet,
    });

    const deptRow = await query<{ name: string }>(
      'SELECT name FROM org_departments WHERE id = $1::uuid',
      [departmentId],
    );
    const deptName = deptRow[0]?.name ?? 'Отдел';
    const fileName = `Единый_1С_${deptName}_${MONTH_NAMES[mon]}_${year}${segmentSuffix}.xlsx`
      .replace(/[\/\\?%*:|"<>]/g, '_');

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',
      `attachment; filename="${encodeURIComponent(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    res.setHeader('Content-Length', String(buffer.length));
    res.end(buffer);
  } catch (err) {
    console.error('timesheet.exportDepartmentUnified error:', err);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: 'Ошибка единого экспорта для 1С' });
    }
  }
}
