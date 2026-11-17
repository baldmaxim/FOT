/**
 * GET /api/timesheet/employees/:employeeId/schedule-plan?month=YYYY-MM — блок «График работы» под табелем
 * «По сотруднику»: план графика на год месяца табеля (employee-schedule-plan.service.ts).
 *
 * Проверки — в порядке getAll табеля: формат месяца, скоуп, окно месяцев роли, доступ к сотруднику за месяц.
 * Доступ к месяцу намеренно открывает план графика всего его года (шаблон, не табельные часы других месяцев).
 * Без кеша: после смены назначения график должен быть свежим.
 */
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';
import { buildEmployeeSchedulePlan } from '../services/employee-schedule-plan.service.js';
import { canAccessEmployeeForTimesheetPeriod, resolveTimesheetScope } from '../services/timesheet-scope.service.js';
import {
  DEPARTMENT_MONTH_FORBIDDEN_MESSAGE,
  isDepartmentMonthAllowed,
  isTimesheetWindowExempt,
} from '../utils/timesheet-month-access.js';

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export const timesheetSchedulePlanController = {
  async get(req: AuthenticatedRequest, res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const employeeId = Number.parseInt(String(req.params.employeeId), 10);
      if (!Number.isInteger(employeeId) || employeeId <= 0 || String(employeeId) !== String(req.params.employeeId)) {
        return res.status(400).json({ success: false, error: 'Некорректный ID сотрудника' });
      }
      const match = typeof req.query.month === 'string' ? MONTH_RE.exec(req.query.month) : null;
      if (!match) {
        return res.status(400).json({ success: false, error: 'Параметр month обязателен (формат YYYY-MM)' });
      }
      const year = Number(match[1]);
      const month = Number(match[2]);

      const scope = await resolveTimesheetScope(req);
      if (!scope) {
        return res.status(403).json({ success: false, error: 'Data scope не настроен для роли' });
      }
      if (!isTimesheetWindowExempt(req.user, scope) && !isDepartmentMonthAllowed(year, month, {
        monthsBack: req.user.timesheet_months_back,
        monthsForward: req.user.timesheet_months_forward,
        referenceDate: new Date(),
      })) {
        return res.status(403).json({ success: false, error: DEPARTMENT_MONTH_FORBIDDEN_MESSAGE });
      }

      const monthStart = `${match[1]}-${match[2]}-01`;
      const monthEnd = `${match[1]}-${match[2]}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, '0')}`;
      if (!(await canAccessEmployeeForTimesheetPeriod(req, employeeId, monthStart, monthEnd))) {
        return res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      }

      const plan = await buildEmployeeSchedulePlan(employeeId, year);
      if (!plan) {
        return res.status(404).json({ success: false, error: 'Сотрудник не найден' });
      }
      return res.json({ success: true, data: plan });
    } catch (err) {
      console.error('timesheetSchedulePlan.get error:', err);
      return res.status(500).json({ success: false, error: 'Ошибка получения графика сотрудника' });
    }
  },
};
