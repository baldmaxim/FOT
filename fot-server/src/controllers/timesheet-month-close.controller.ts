import type { Response } from 'express';
import * as Sentry from '@sentry/node';
import { z } from 'zod';
import { query } from '../config/postgres.js';
import { invalidateCaches } from '../middleware/cacheResponse.js';
import { AUDIT_ACTIONS, auditService } from '../services/audit.service.js';
import { resolveEditableDepartmentIds } from '../services/data-scope.service.js';
import { emitDomainChange } from '../services/realtime-broadcast.service.js';
import {
  closeDepartmentMonth,
  MONTH_CLOSE_COMMENT,
  monthHalfRanges,
  type IMonthCloseChange,
  type IMonthCloseHalfResult,
} from '../services/timesheet-month-close.service.js';
import { isRangeWithinCompletedPeriods } from '../services/timesheet-period.service.js';
import { listTimesheetWorkflowRecipientIds } from '../services/timesheet-workflow-recipients.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

/** Отделов в одном запросе. Клиент шлёт чанками и досылает remaining_ids. */
const MAX_DEPARTMENTS = 10;
/**
 * Бюджет запроса. Меньше таймаута шлюза с запасом: отдел утверждается целиком (две
 * материализации версии), и начатый отдел всегда доводится до конца.
 */
const REQUEST_BUDGET_MS = 20_000;

const bodySchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  department_ids: z.array(z.string().uuid()).min(1).max(MAX_DEPARTMENTS),
});

interface IDepartmentCloseResult {
  department_id: string;
  name: string | null;
  halves: IMonthCloseHalfResult[];
}

/** Аудит и realtime по одной реально изменённой подаче. Основной ответ не валит. */
async function recordChange(
  req: AuthenticatedRequest,
  departmentId: string,
  departmentName: string | null,
  change: IMonthCloseChange,
): Promise<void> {
  const base = {
    department_id: departmentId,
    department_name: departmentName,
    manager_employee_id: null,
    start_date: change.startDate,
    end_date: change.endDate,
    source: 'month_close',
  };
  try {
    if (change.kind === 'closed') {
      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.TIMESHEET_APPROVAL_CLOSED, {
        entityType: 'timesheet_approval',
        entityId: String(change.approvalId),
        details: { ...base, status: 'approved' },
      });
    } else {
      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.TIMESHEET_APPROVAL_APPROVED, {
        entityType: 'timesheet_approval',
        entityId: String(change.approvalId),
        details: {
          ...base,
          from_status: change.fromStatus,
          to_status: 'approved',
          comment: MONTH_CLOSE_COMMENT,
          // Утверждено без подачи руководителя.
          forced: change.fromStatus !== 'submitted',
        },
      });
    }
  } catch (err) {
    console.error('timesheet-month-close audit error:', err);
  }

  try {
    // 'submit' — руководители и табельщицы: без них замок увидят только после обновления.
    const recipients = new Set<string>([req.user.id]);
    if (change.submittedBy) recipients.add(change.submittedBy);
    for (const userId of await listTimesheetWorkflowRecipientIds(departmentId, ['submit', 'review', 'monitor'])) {
      recipients.add(userId);
    }
    emitDomainChange({
      event: 'timesheet_approval:changed',
      targetUserIds: [...recipients],
      payload: { entityId: change.approvalId, action: change.kind === 'closed' ? 'close' : 'approved' },
    });
  } catch (err) {
    console.error('timesheet-month-close emit error:', err);
  }
}

/**
 * POST /api/timesheet-approvals/close-month  body: { month: 'YYYY-MM', department_ids }
 *
 * Закрывает табели отделов за завершённый месяц: открытые возвращает под замок, поданные
 * утверждает, неподанные утверждает от имени кадров. Отделы идут строго по очереди —
 * каждая материализация держит соединение и advisory-локи сотрудников.
 */
export async function closeTimesheetMonth(req: AuthenticatedRequest, res: Response): Promise<void> {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: `Нужен месяц в формате ГГГГ-ММ и от 1 до ${MAX_DEPARTMENTS} отделов`,
    });
    return;
  }
  const { month } = parsed.data;
  const departmentIds = parsed.data.department_ids.map(id => id.toLowerCase());
  if (new Set(departmentIds).size !== departmentIds.length) {
    res.status(400).json({ success: false, error: 'Отделы в запросе не должны повторяться' });
    return;
  }

  try {
    // Скоуп на ЗАПИСЬ, а не видимость: закрытие — согласующее действие. Частично
    // недоступный набор отклоняем целиком, молча ничего не пропускаем.
    const editable = await resolveEditableDepartmentIds(req);
    if (editable !== 'all') {
      const allowed = new Set(editable);
      if (departmentIds.some(id => !allowed.has(id))) {
        res.status(403).json({
          success: false,
          error: 'Нет доступа к одному из выбранных отделов',
          code: 'DEPARTMENT_ACCESS_DENIED',
        });
        return;
      }
    }

    const ranges = monthHalfRanges(month);
    // Незавершённый месяц закрывать нельзя: замок закрыл бы дни, которые ещё ведутся.
    if (!isRangeWithinCompletedPeriods(ranges[0].startDate, ranges[ranges.length - 1].endDate)) {
      res.status(409).json({
        success: false,
        error: 'Месяц ещё не завершён — закрыть табели можно после его окончания',
        code: 'MONTH_NOT_COMPLETED',
      });
      return;
    }

    const nameRows = await query<{ id: string; name: string | null }>(
      'SELECT id, name FROM org_departments WHERE id = ANY($1::uuid[])',
      [departmentIds],
    );
    const nameById = new Map(nameRows.map(row => [row.id, row.name]));

    const deadline = Date.now() + REQUEST_BUDGET_MS;
    const results: IDepartmentCloseResult[] = [];
    let remainingIds: string[] = [];

    try {
      for (let index = 0; index < departmentIds.length; index += 1) {
        if (index > 0 && Date.now() >= deadline) {
          remainingIds = departmentIds.slice(index);
          break;
        }
        const departmentId = departmentIds[index];
        const name = nameById.get(departmentId) ?? null;
        const { halves, changes, errors } = await closeDepartmentMonth(req.user.id, departmentId, month);
        for (const err of errors) {
          console.error(`timesheet-month-close: отдел ${departmentId}, ${month}:`, err);
          Sentry.captureException(err, { tags: { feature: 'timesheet_month_close' }, extra: { departmentId, month } });
        }
        for (const change of changes) await recordChange(req, departmentId, name, change);
        results.push({ department_id: departmentId, name, halves });
      }
    } finally {
      // Сбрасываем и при сбое посреди набора: часть подач уже могла измениться.
      invalidateCaches(
        'timesheet', 'timesheet:today', 'timesheet:overview', 'timesheet:overview:today',
        'timesheet-1c-status',
      );
    }

    res.json({ success: true, data: { results, remaining_ids: remainingIds } });
  } catch (err) {
    console.error('timesheet-month-close error:', err);
    res.status(500).json({ success: false, error: 'Ошибка закрытия табелей' });
  }
}
