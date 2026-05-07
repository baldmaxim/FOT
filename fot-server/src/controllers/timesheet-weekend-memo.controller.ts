import type { Response } from 'express';
import { supabase } from '../config/database.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { resolveScopedDepartmentId } from '../services/data-scope.service.js';
import {
  checkWeekendWorkRequirement,
  MANAGER_OBJ_ROLE_CODE,
} from '../services/timesheet-approval-weekend-check.service.js';
import { listEmployeeIdsAssignedToDepartmentPeriod } from '../services/timesheet-department-assignments.service.js';
import {
  generateWeekendMemoXlsx,
  loadWeekendMemoData,
} from '../services/timesheet-weekend-memo.service.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * POST /api/timesheet/weekend-memo/generate
 * Body: { department_id, start_date, end_date, reason }
 * Генерирует .xlsx-шаблон служебной записки. Список сотрудников и дат
 * собирается автоматически: те, у кого в attendance_adjustments статус 'work'
 * на календарный выходной в указанном диапазоне.
 * Доступ только для роли manager_obj.
 */
export const generateWeekendMemo = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (req.user.role_code !== MANAGER_OBJ_ROLE_CODE) {
      res.status(403).json({ success: false, error: 'Доступно только руководителям объектов (manager_obj)' });
      return;
    }

    const requestedDeptId = typeof req.body?.department_id === 'string' && req.body.department_id ? req.body.department_id : null;
    const startDate = typeof req.body?.start_date === 'string' ? req.body.start_date : '';
    const endDate = typeof req.body?.end_date === 'string' ? req.body.end_date : '';
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';

    if (!ISO_DATE.test(startDate) || !ISO_DATE.test(endDate) || endDate < startDate) {
      res.status(400).json({
        success: false,
        error: 'start_date и end_date обязательны (формат YYYY-MM-DD, end_date >= start_date)',
      });
      return;
    }

    const departmentId = await resolveScopedDepartmentId(req, requestedDeptId);
    if (requestedDeptId && !departmentId) {
      res.status(403).json({ success: false, error: 'Нет доступа к отделу', code: 'DEPARTMENT_ACCESS_DENIED' });
      return;
    }
    if (!departmentId) {
      res.status(400).json({ success: false, error: 'department_id обязателен' });
      return;
    }

    const weekend = await checkWeekendWorkRequirement({ departmentId, startDate, endDate });
    if (!weekend.requires) {
      res.status(400).json({
        success: false,
        error: 'В выбранном диапазоне нет работы в выходные',
        code: 'NO_WEEKEND_WORK',
      });
      return;
    }

    const employeeIds = await listEmployeeIdsAssignedToDepartmentPeriod(departmentId, startDate, endDate);
    if (employeeIds.length === 0) {
      res.status(404).json({ success: false, error: 'Нет сотрудников в отделе на выбранный период' });
      return;
    }

    const adjRes = await supabase
      .from('attendance_adjustments')
      .select('employee_id, work_date')
      .in('employee_id', employeeIds)
      .in('work_date', weekend.weekendWorkDates)
      .eq('status', 'work');
    if (adjRes.error) throw adjRes.error;
    const employeesWithWeekendWork = [...new Set((adjRes.data || []).map(r => Number(r.employee_id)))];

    if (employeesWithWeekendWork.length === 0) {
      res.status(404).json({
        success: false,
        error: 'Не найдено сотрудников с работой в выходные. Сначала создайте корректировку статуса «работа» на выходной день.',
      });
      return;
    }

    const data = await loadWeekendMemoData({
      managerUserId: req.user.id,
      employeeIds: employeesWithWeekendWork,
      weekendDates: weekend.weekendWorkDates,
      reason,
    });

    const buffer = await generateWeekendMemoXlsx(data);
    const fileName = `weekend-memo-${startDate}_${endDate}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', String(buffer.byteLength));
    res.end(buffer);
  } catch (err) {
    console.error('timesheet-weekend-memo.generate error:', err);
    res.status(500).json({ success: false, error: 'Ошибка формирования служебной записки' });
  }
};
