/**
 * «Выходные» (миграция 346): вкладка «Управления кадрами», право /staff-control/weekends.
 * Что попадает в список — staff-weekends.service.ts.
 *
 * Охват — по отделу на дату, как в табеле, а не по текущему отделу сотрудника: уволенный уже в общей папке
 * «Уволенные», и по текущему отделу администратор компании его бы не увидел.
 */
import type { Response } from 'express';

import type { AuthenticatedRequest } from '../types/index.js';
import { resolveAccessibleDepartmentIds, resolveRequestDataScope } from '../services/data-scope.service.js';
import { resolveStaffRosterEmployeeIds } from '../services/employee-scope-filter.service.js';
import {
  listWeekendsByBranch,
  listWeekendsWithoutCorrection,
  STAFF_WEEKENDS_BRANCH_IDS,
  STAFF_WEEKENDS_MAX_MONTHS,
} from '../services/staff-weekends.service.js';
import { attachWeekendPeriods } from '../services/staff-weekends-periods.service.js';
import { canToggleTimesheetLock } from '../utils/timesheet-lock-toggle.js';
import { handlePayrollZodError, parsePayrollMonthsQuery } from './payroll-dictionary.helpers.js';
import { sendTableSnapshotXlsx } from './table-snapshot-export.js';

const WEEKENDS_SHEET = { sheetName: 'Выходные', tableName: 'Weekends' } as const;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Отделы списка в охвате пользователя: список кадров без ограничений или отдел среди доступных. */
export const visibleBranchIds = async (req: AuthenticatedRequest): Promise<string[]> => {
  if (await resolveStaffRosterEmployeeIds(req) === 'all') return [...STAFF_WEEKENDS_BRANCH_IDS];
  const accessible = await resolveAccessibleDepartmentIds(req);
  if (accessible === 'all') return [...STAFF_WEEKENDS_BRANCH_IDS];
  return STAFF_WEEKENDS_BRANCH_IDS.filter(id => accessible.includes(id));
};

/**
 * Открывать и закрывать табель с вкладки: право снимать замок и охват «все отделы» — личные подачи администратору
 * компании недоступны и в обычном /open. Перед этим нужен resolveTimesheetLockToggle.
 */
export const canManageWeekendPeriods = async (req: AuthenticatedRequest): Promise<boolean> => (
  canToggleTimesheetLock(req.user) && (await resolveRequestDataScope(req)) === 'all'
);

/** GET /api/staff-weekends?months=2026-10,2026-11 — месяцы обязательны, «весь период» не поддерживается. */
const list = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const months = parsePayrollMonthsQuery(req.query.months);
    if (months === null || months === 'all') {
      res.status(400).json({ success: false, error: 'Выберите месяц' });
      return;
    }
    if (months.length > STAFF_WEEKENDS_MAX_MONTHS) {
      res.status(400).json({ success: false, error: 'Слишком много месяцев' });
      return;
    }
    res.json({ success: true, data: await listWeekendsWithoutCorrection(months, await visibleBranchIds(req)) });
  } catch (err) {
    if (handlePayrollZodError(err, res)) return;
    console.error('staffWeekends.list error:', err);
    res.status(500).json({ success: false, error: 'Не удалось загрузить список' });
  }
};

/** GET /api/staff-weekends/grid?month=2026-10 — сетка вкладки: отделы и их люди с днями без корректировки. */
const grid = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const month = req.query.month;
    if (typeof month !== 'string' || !MONTH_RE.test(month)) {
      res.status(400).json({ success: false, error: 'Выберите месяц' });
      return;
    }
    const branches = await listWeekendsByBranch(month, await visibleBranchIds(req));
    const canManagePeriods = await canManageWeekendPeriods(req);
    res.json({
      success: true,
      data: {
        branches: canManagePeriods
          ? await attachWeekendPeriods(month, branches)
          : branches.map(branch => ({ ...branch, periods: [] })),
        can_manage_periods: canManagePeriods,
      },
    });
  } catch (err) {
    console.error('staffWeekends.grid error:', err);
    res.status(500).json({ success: false, error: 'Не удалось загрузить список' });
  }
};

/** POST /api/staff-weekends/export — снимок таблицы экрана в xlsx. */
const exportTable = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    await sendTableSnapshotXlsx(res, req.body, WEEKENDS_SHEET);
  } catch (err) {
    if (handlePayrollZodError(err, res)) return;
    console.error('staffWeekends.export error:', err);
    res.status(500).json({ success: false, error: 'Не удалось выгрузить таблицу' });
  }
};

export const staffWeekendsController = { list, grid, exportTable };
