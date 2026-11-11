/** «Табель» → «По отделу»: «Открыть табель» и «Закрыть табель» отдела. Правила — timesheet-department-period.service. */
import type { Response } from 'express';
import { z } from 'zod';

import { resolveScopedDepartmentId } from '../services/data-scope.service.js';
import {
  approvalLabel,
  findWeekendOperation,
  WeekendPeriodConflictError,
  type WeekendHalf,
} from '../services/staff-weekends-periods.service.js';
import {
  getDepartmentPeriodState,
  listDepartmentPeriodCloseTargets,
  openDepartmentPeriod,
  previewDepartmentPeriod,
  resolveDepartmentPeriodRange,
  type IDepartmentPeriodRange,
  type TApprovalAccessCheck,
} from '../services/timesheet-department-period.service.js';
import type { AuthenticatedRequest } from '../types/index.js';
import {
  announceApprovalOpened,
  closeApprovalPeriod,
  ensureApprovalAccess,
  invalidateTimesheetGridCaches,
  UNLOCK_REASON_MAX_LENGTH,
} from './timesheet-approval.controller.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const rangeSchema = z.object({
  department_id: z.string().uuid(),
  start_date: isoDate,
  end_date: isoDate,
});
const openSchema = rangeSchema.extend({
  operation_ids: z.object({ 1: z.string().uuid().optional(), 2: z.string().uuid().optional() }),
  expected_approval_ids: z.array(z.number().int().positive()).min(1).max(500),
  reason: z.string().trim().max(UNLOCK_REASON_MAX_LENGTH).nullish(),
});

const respondBadRequest = (res: Response, message: string): void => {
  res.status(400).json({ success: false, error: message });
};

/** Диапазон и доступ к отделу. Ответ уже отправлен — null. */
const resolveRequestRange = async (
  req: AuthenticatedRequest,
  res: Response,
  input: unknown,
): Promise<{ departmentId: string; range: IDepartmentPeriodRange } | null> => {
  const parsed = rangeSchema.safeParse(input);
  if (!parsed.success) {
    respondBadRequest(res, parsed.error.issues[0]?.message ?? 'Неверные данные');
    return null;
  }
  const range = resolveDepartmentPeriodRange(parsed.data.start_date, parsed.data.end_date);
  if (!range) {
    respondBadRequest(res, 'Период — 1–15, 16–последний день или весь месяц');
    return null;
  }
  const departmentId = parsed.data.department_id;
  if ((await resolveScopedDepartmentId(req, departmentId)) !== departmentId) {
    res.status(403).json({ success: false, error: 'Нет доступа к отделу', code: 'DEPARTMENT_ACCESS_DENIED' });
    return null;
  }
  return { departmentId, range };
};

const accessCheck = (req: AuthenticatedRequest): TApprovalAccessCheck => approval => ensureApprovalAccess(req, approval);

/** GET /api/timesheet-approvals/department-period?department_id&start_date&end_date — кнопки по половинам. */
const getState = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const resolved = await resolveRequestRange(req, res, req.query);
    if (!resolved) return;
    res.json({ success: true, data: await getDepartmentPeriodState(resolved.departmentId, resolved.range, accessCheck(req)) });
  } catch (err) {
    console.error('timesheetDepartmentPeriod.getState error:', err);
    res.status(500).json({ success: false, error: 'Не удалось загрузить состояние табеля' });
  }
};

/** GET /api/timesheet-approvals/department-period/preview — что откроется и кого ещё затронет. */
const preview = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const resolved = await resolveRequestRange(req, res, req.query);
    if (!resolved) return;
    res.json({ success: true, data: await previewDepartmentPeriod(resolved.departmentId, resolved.range, accessCheck(req)) });
  } catch (err) {
    console.error('timesheetDepartmentPeriod.preview error:', err);
    res.status(500).json({ success: false, error: 'Не удалось загрузить состав табелей' });
  }
};

/**
 * POST /api/timesheet-approvals/department-period/open. Все подачи разом или ни одной. Повтор с теми же operation_ids
 * возвращает прежний результат без новых записей и аудита: двойной клик и обрыв связи ничего не задвоят.
 */
const open = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const parsed = openSchema.safeParse(req.body);
    if (!parsed.success) {
      respondBadRequest(res, parsed.error.issues[0]?.message ?? 'Неверные данные');
      return;
    }
    const resolved = await resolveRequestRange(req, res, req.body);
    if (!resolved) return;
    const { departmentId, range } = resolved;
    const operationIds: Partial<Record<WeekendHalf, string>> = {};
    for (const { half } of range.halves) {
      const operationId = parsed.data.operation_ids[half];
      if (!operationId) {
        respondBadRequest(res, 'Нет идентификатора операции');
        return;
      }
      operationIds[half] = operationId;
    }
    if (new Set(Object.values(operationIds)).size !== range.halves.length) {
      respondBadRequest(res, 'Идентификаторы операций должны различаться');
      return;
    }
    const reason = parsed.data.reason || null;

    const repeatResult = async (): Promise<boolean> => {
      const opened = new Set<number>();
      let found = false;
      for (const half of range.halves) {
        const existing = await findWeekendOperation(operationIds[half.half] as string);
        if (existing.length === 0) continue;
        found = true;
        if (!existing.every(row => row.branch_id === departmentId && row.period_start === half.startDate)) {
          throw new WeekendPeriodConflictError('OPERATION_ID_REUSED', 'Операция уже выполнена для другого табеля');
        }
        for (const row of existing) opened.add(Number(row.approval_id));
      }
      if (!found) return false;
      res.json({ success: true, data: { opened: [...opened].sort((a, b) => a - b), repeated: true } });
      return true;
    };
    if (await repeatResult()) return;

    let updated;
    try {
      updated = await openDepartmentPeriod({
        departmentId,
        range,
        operationIds,
        expectedIds: parsed.data.expected_approval_ids,
        userId: req.user.id,
        reason,
        canAccess: accessCheck(req),
      });
    } catch (err) {
      // Параллельный повтор той же операции успел первым: отвечаем её результатом.
      if (err instanceof WeekendPeriodConflictError && await repeatResult()) return;
      throw err;
    }

    for (const approval of updated) {
      await announceApprovalOpened(req, approval, {
        reason,
        source: 'timesheet_department_period',
        department_period_id: departmentId,
        operation_ids: operationIds,
      });
    }
    invalidateTimesheetGridCaches();
    res.json({ success: true, data: { opened: updated.map(row => Number(row.id)).sort((a, b) => a - b), repeated: false } });
  } catch (err) {
    if (err instanceof WeekendPeriodConflictError) {
      res.status(409).json({ success: false, error: err.message, code: err.code });
      return;
    }
    console.error('timesheetDepartmentPeriod.open error:', err);
    res.status(500).json({ success: false, error: 'Ошибка открытия табеля' });
  }
};

/**
 * POST /api/timesheet-approvals/department-period/close: по одной подаче — у каждой свои блокировки и редакция для 1С.
 * Ошибка одной не мешает остальным; повтор закрывает только оставшиеся.
 */
const close = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const resolved = await resolveRequestRange(req, res, req.body);
    if (!resolved) return;
    const targets = await listDepartmentPeriodCloseTargets(resolved.departmentId, resolved.range, accessCheck(req));

    const closed: number[] = [];
    const failed: Array<{ id: number; label: string; error: string; code?: string }> = [];
    for (const approval of targets) {
      const id = Number(approval.id);
      const label = approvalLabel(approval);
      try {
        const result = await closeApprovalPeriod(req, approval);
        if (result.ok || result.body.code === 'ALREADY_LOCKED') {
          closed.push(id);
        } else {
          failed.push({ id, label, error: result.body.error, code: result.body.code });
        }
      } catch (err) {
        console.error('timesheetDepartmentPeriod.close approval error:', id, err);
        failed.push({ id, label, error: 'Ошибка закрытия табеля' });
      }
    }
    res.json({ success: true, data: { closed, failed } });
  } catch (err) {
    console.error('timesheetDepartmentPeriod.close error:', err);
    res.status(500).json({ success: false, error: 'Ошибка закрытия табеля' });
  }
};

export const timesheetDepartmentPeriodController = { getState, preview, open, close };
