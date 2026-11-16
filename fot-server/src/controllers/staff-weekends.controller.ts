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
import { listBranchCandidateIds } from '../services/staff-branch-ownership.service.js';
import { listWeekendsByBranch } from '../services/staff-weekends.service.js';
import {
  attachWeekendPeriods,
  listActiveUnlockBranchIds,
  weekendHalfRange,
} from '../services/staff-weekends-periods.service.js';
import { canToggleTimesheetLock } from '../utils/timesheet-lock-toggle.js';
import { handlePayrollZodError } from './payroll-dictionary.helpers.js';
import { sendTableSnapshotXlsx } from './table-snapshot-export.js';

const WEEKENDS_SHEET = { sheetName: 'Выходные', tableName: 'Weekends' } as const;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Отделы в охвате пользователя, как раньше: список кадров без ограничений или «все отделы» — все, иначе доступные. */
export const filterBranchesByScope = async (req: AuthenticatedRequest, branchIds: readonly string[]): Promise<string[]> => {
  if (await resolveStaffRosterEmployeeIds(req) === 'all') return [...branchIds];
  const accessible = await resolveAccessibleDepartmentIds(req);
  if (accessible === 'all') return [...branchIds];
  const allowed = new Set(accessible);
  return branchIds.filter(id => allowed.has(id));
};

export interface IWeekendBranches {
  /** Все кандидаты месяца — по ним определяется владелец дня. */
  ownership: string[];
  /** Что видит пользователь: кандидаты и отделы с открытым кнопкой табелем, в его охвате. */
  visible: string[];
}

/**
 * Отделы вкладки за месяц. Отдел с открытым кнопкой табелем виден, даже если выпал из кандидатов: иначе открытое
 * нечем закрыть.
 */
export const resolveWeekendBranches = async (req: AuthenticatedRequest, month: string): Promise<IWeekendBranches> => {
  const halves = [weekendHalfRange(month, 1), weekendHalfRange(month, 2)]
    .flatMap(range => (range ? [range.startDate] : []));
  const [ownership, unlocked] = await Promise.all([
    listBranchCandidateIds(month),
    listActiveUnlockBranchIds(halves),
  ]);
  return { ownership, visible: await filterBranchesByScope(req, [...new Set([...ownership, ...unlocked])]) };
};

/**
 * Открывать и закрывать табель с вкладки: право снимать замок и охват «все отделы» — личные подачи администратору
 * компании недоступны и в обычном /open. Перед этим нужен resolveTimesheetLockToggle.
 */
export const canManageWeekendPeriods = async (req: AuthenticatedRequest): Promise<boolean> => (
  canToggleTimesheetLock(req.user) && (await resolveRequestDataScope(req)) === 'all'
);

/** GET /api/staff-weekends/grid?month=2026-10 — отделы месяца и их люди с днями без корректировки. */
const grid = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const month = req.query.month;
    if (typeof month !== 'string' || !MONTH_RE.test(month)) {
      res.status(400).json({ success: false, error: 'Выберите месяц' });
      return;
    }
    const { ownership, visible } = await resolveWeekendBranches(req, month);
    const branches = await listWeekendsByBranch(month, { ownershipBranchIds: ownership, visibleBranchIds: visible });
    const canManagePeriods = await canManageWeekendPeriods(req);
    const withPeriods = canManagePeriods
      ? await attachWeekendPeriods(month, branches)
      : branches.map(branch => ({ ...branch, periods: [] }));
    res.json({
      success: true,
      data: {
        // Отдел без людей нужен только с кнопкой: открытый табель надо уметь закрыть.
        branches: withPeriods.filter(branch => branch.rows.length > 0 || branch.periods.length > 0),
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

export const staffWeekendsController = { grid, exportTable };
