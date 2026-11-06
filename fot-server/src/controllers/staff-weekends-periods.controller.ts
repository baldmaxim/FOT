/** «Выходные»: кнопки «Открыть табель» и «Закрыть табель» у отдела. Правила — staff-weekends-periods.service. */
import type { NextFunction, Response } from 'express';
import { z } from 'zod';

import { listWeekendsByBranch, type IStaffWeekendBranch } from '../services/staff-weekends.service.js';
import {
  approvalLabel,
  findWeekendOperation,
  listActiveUnlocks,
  listLockingApprovalIds,
  loadApprovalsForAccessCheck,
  openApprovalsTogether,
  previewWeekendPeriod,
  weekendHalfRange,
  WeekendPeriodConflictError,
  type IWeekendPeriodApprovalRow,
  type WeekendHalf,
} from '../services/staff-weekends-periods.service.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { canManageWeekendPeriods, visibleBranchIds } from './staff-weekends.controller.js';
import {
  announceApprovalOpened,
  closeApprovalPeriod,
  ensureApprovalAccess,
  invalidateTimesheetGridCaches,
  UNLOCK_REASON_MAX_LENGTH,
} from './timesheet-approval.controller.js';

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const halfSchema = z.union([z.literal(1), z.literal(2)]);

const previewSchema = z.object({
  month: monthSchema,
  half: z.enum(['1', '2']).transform((value): WeekendHalf => (value === '1' ? 1 : 2)),
  branch_id: z.string().uuid(),
});
const closeSchema = z.object({ month: monthSchema, half: halfSchema, branch_id: z.string().uuid() });
const openSchema = closeSchema.extend({
  operation_id: z.string().uuid(),
  expected_approval_ids: z.array(z.number().int().positive()).min(1).max(500),
  reason: z.string().trim().max(UNLOCK_REASON_MAX_LENGTH).nullish(),
});

export const requireWeekendPeriodManage = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (await canManageWeekendPeriods(req)) {
      next();
      return;
    }
    res.status(403).json({ success: false, error: 'Нет права открывать и закрывать табель' });
  } catch (err) {
    next(err);
  }
};

/** Отдел с его списком за месяц, считается заново; вне охвата — null. */
const loadBranch = async (
  req: AuthenticatedRequest,
  month: string,
  branchId: string,
): Promise<IStaffWeekendBranch | null> => {
  const visible = await visibleBranchIds(req);
  if (!visible.includes(branchId)) return null;
  const branches = await listWeekendsByBranch(month, visible);
  return branches.find(branch => branch.id === branchId) ?? null;
};

const sameIds = (a: readonly number[], b: readonly number[]): boolean => {
  const sortedA = [...a].sort((x, y) => x - y);
  const sortedB = [...b].sort((x, y) => x - y);
  return sortedA.length === sortedB.length && sortedA.every((value, index) => value === sortedB[index]);
};

const respondBadRequest = (res: Response, err: z.ZodError): void => {
  res.status(400).json({ success: false, error: err.issues[0]?.message ?? 'Неверные данные' });
};

/** GET /api/staff-weekends/periods/preview?month&half&branch_id — что откроется и кого затронет. */
const preview = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const parsed = previewSchema.safeParse(req.query);
    if (!parsed.success) {
      respondBadRequest(res, parsed.error);
      return;
    }
    const { month, half, branch_id: branchId } = parsed.data;
    const branch = await loadBranch(req, month, branchId);
    if (!branch) {
      res.status(403).json({ success: false, error: 'Отдел вне вашего охвата' });
      return;
    }
    res.json({ success: true, data: await previewWeekendPeriod(month, half, branch) });
  } catch (err) {
    console.error('staffWeekends.preview error:', err);
    res.status(500).json({ success: false, error: 'Не удалось загрузить состав табелей' });
  }
};

/**
 * POST /api/staff-weekends/periods/open. Все подачи разом или ни одной. Повтор с тем же operation_id возвращает
 * прежний результат, без новых записей и аудита: двойной клик и обрыв связи ничего не задвоят.
 */
const open = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const parsed = openSchema.safeParse(req.body);
    if (!parsed.success) {
      respondBadRequest(res, parsed.error);
      return;
    }
    const { operation_id: operationId, month, half, branch_id: branchId, expected_approval_ids: expected } = parsed.data;
    const reason = parsed.data.reason || null;
    const range = weekendHalfRange(month, half);
    if (!range) {
      res.status(400).json({ success: false, error: 'Выберите месяц' });
      return;
    }

    const repeatResult = async (): Promise<boolean> => {
      const existing = await findWeekendOperation(operationId);
      if (existing.length === 0) return false;
      const same = existing.every(row => row.branch_id === branchId && row.period_start === range.startDate);
      if (!same) throw new WeekendPeriodConflictError('OPERATION_ID_REUSED', 'Операция уже выполнена для другого табеля');
      res.json({
        success: true,
        data: { operation_id: operationId, opened: existing.map(row => Number(row.approval_id)), repeated: true },
      });
      return true;
    };
    if (await repeatResult()) return;

    const branch = await loadBranch(req, month, branchId);
    if (!branch) {
      res.status(403).json({ success: false, error: 'Отдел вне вашего охвата' });
      return;
    }

    // Состав считаем заново и сверяем с тем, что человек подтвердил.
    const approvalIds = await listLockingApprovalIds(branch.rows, half);
    if (!sameIds(approvalIds, expected)) {
      throw new WeekendPeriodConflictError('PERIOD_SET_CHANGED', 'Состав табелей изменился — откройте окно заново');
    }
    const approvals = await loadApprovalsForAccessCheck(approvalIds);
    for (const approval of approvals) {
      if (!(await ensureApprovalAccess(req, approval))) {
        res.status(403).json({ success: false, error: `Нет доступа: ${approvalLabel(approval)}`, code: 'DEPARTMENT_ACCESS_DENIED' });
        return;
      }
    }

    let updated;
    try {
      updated = await openApprovalsTogether({
        operationId, branchId, periodStart: range.startDate, approvalIds, userId: req.user.id, reason,
      });
    } catch (err) {
      // Параллельный повтор той же операции успел первым: отвечаем её результатом.
      if (err instanceof WeekendPeriodConflictError && await repeatResult()) return;
      throw err;
    }

    for (const approval of updated) {
      await announceApprovalOpened(req, approval, { reason, source: 'staff_weekends', operation_id: operationId });
    }
    invalidateTimesheetGridCaches();
    res.json({
      success: true,
      data: { operation_id: operationId, opened: updated.map(row => Number(row.id)), repeated: false },
    });
  } catch (err) {
    if (err instanceof WeekendPeriodConflictError) {
      res.status(409).json({ success: false, error: err.message, code: err.code });
      return;
    }
    console.error('staffWeekends.open error:', err);
    res.status(500).json({ success: false, error: 'Ошибка открытия табеля' });
  }
};

/**
 * POST /api/staff-weekends/periods/close: подачи, открытые кнопкой этого отдела за половину. У каждой свои блокировки
 * и редакция, поэтому по одной, с точным результатом. Повтор закрывает только оставшиеся.
 */
const close = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const parsed = closeSchema.safeParse(req.body);
    if (!parsed.success) {
      respondBadRequest(res, parsed.error);
      return;
    }
    const { month, half, branch_id: branchId } = parsed.data;
    const range = weekendHalfRange(month, half);
    if (!range) {
      res.status(400).json({ success: false, error: 'Выберите месяц' });
      return;
    }
    if (!(await visibleBranchIds(req)).includes(branchId)) {
      res.status(403).json({ success: false, error: 'Отдел вне вашего охвата' });
      return;
    }

    const closed: number[] = [];
    const failed: Array<{ id: number; label: string; error: string; code?: string }> = [];
    const active: IWeekendPeriodApprovalRow[] = await listActiveUnlocks([branchId], [range.startDate]);
    for (const approval of active) {
      const id = Number(approval.id);
      try {
        if (!(await ensureApprovalAccess(req, approval))) {
          failed.push({ id, label: approvalLabel(approval), error: 'Нет доступа к этой подаче', code: 'DEPARTMENT_ACCESS_DENIED' });
          continue;
        }
        const result = await closeApprovalPeriod(req, approval);
        if (result.ok || result.body.code === 'ALREADY_LOCKED') {
          closed.push(id);
        } else {
          failed.push({ id, label: approvalLabel(approval), error: result.body.error, code: result.body.code });
        }
      } catch (err) {
        console.error('staffWeekends.close approval error:', id, err);
        failed.push({ id, label: approvalLabel(approval), error: 'Ошибка закрытия табеля' });
      }
    }
    res.json({ success: true, data: { closed, failed } });
  } catch (err) {
    console.error('staffWeekends.close error:', err);
    res.status(500).json({ success: false, error: 'Ошибка закрытия табеля' });
  }
};

export const staffWeekendPeriodsController = { preview, open, close };
