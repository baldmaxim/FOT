// Вкладка «Отпуска»: отпуска, поставленные корректировкой табеля (миграция 311).
// Список, «Ознакомлен», «Ознакомлен» по снятым дням, «Отказать» и файлы карточки.

import type { Response } from 'express';
import { getPool, withTransaction } from '../config/postgres.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { auditService } from '../services/audit.service.js';
import { notificationService } from '../services/notification.service.js';
import { pushService } from '../services/push.service.js';
import { emitDomainChange } from '../services/realtime-broadcast.service.js';
import { r2Service } from '../services/r2.service.js';
import { purgeCorrectionAttachments } from '../services/correction-attachments.service.js';
import {
  findCardByAdjustmentId,
  findVisibleCorrectionDocument,
  listHrRecipientIds,
} from '../services/correction-leave.service.js';
import { listHrCorrectionItems } from '../services/correction-leave-list.service.js';
import {
  CARD_CHANGED_MESSAGE,
  CorrectionLeaveClosedPeriodError,
  CorrectionLeaveConflictError,
  REJECT_REASON_MAX_LENGTH,
  acknowledgeCorrectionLeave,
  acknowledgeRemovedCorrectionLeave,
  rejectCorrectionLeaveInTx,
  rejectLockPairs,
} from '../services/correction-leave-decisions.service.js';
import { kickCorrectionLeaveReconcile } from '../services/correction-leave-reconcile.service.js';
import { failClosedPeriod } from '../utils/timesheet-lock-response.js';
import {
  reapproveEmployeeMonthTail,
  reportQuotaTailTransitions,
  withQuotaLocks,
} from './timesheet.controller.js';

/** Вкладка «Отпуска» у других кадровиков обновляется сразу. */
const emitToHr = async (): Promise<void> => {
  const recipients = await listHrRecipientIds();
  emitDomainChange({ event: 'leave_request:changed', targetUserIds: recipients, payload: { action: 'correction_leave' } });
};

const handleError = (res: Response, req: AuthenticatedRequest, err: unknown, context: string) => {
  if (err instanceof CorrectionLeaveConflictError) {
    res.status(409).json({ success: false, error: err.message });
    return;
  }
  if (err instanceof CorrectionLeaveClosedPeriodError) {
    failClosedPeriod(res, err.lock, req.user);
    return;
  }
  console.error(`correction-leaves.${context} error:`, err);
  res.status(500).json({ success: false, error: 'Ошибка обработки отпуска' });
};

const list = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    res.json({ success: true, data: await listHrCorrectionItems(getPool()) });
  } catch (err) {
    handleError(res, req, err, 'list');
  }
};

const acknowledge = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { adjustment_ids: adjustmentIds, version } = req.body ?? {};
    await withTransaction(client => acknowledgeCorrectionLeave(client, { adjustmentIds, version, userId: req.user.id }));
    void emitToHr().catch(e => console.warn('correction-leaves.acknowledge emit error:', e));
    res.json({ success: true });
  } catch (err) {
    handleError(res, req, err, 'acknowledge');
  }
};

const acknowledgeRemoved = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { adjustment_ids: adjustmentIds } = req.body ?? {};
    await withTransaction(client => acknowledgeRemovedCorrectionLeave(client, { adjustmentIds, userId: req.user.id }));
    void emitToHr().catch(e => console.warn('correction-leaves.acknowledgeRemoved emit error:', e));
    res.json({ success: true });
  } catch (err) {
    handleError(res, req, err, 'acknowledgeRemoved');
  }
};

const reject = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { adjustment_ids: adjustmentIds, version } = req.body ?? {};
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (reason.length === 0 || reason.length > REJECT_REASON_MAX_LENGTH) {
      res.status(400).json({ success: false, error: `Укажите причину отказа (до ${REJECT_REASON_MAX_LENGTH} символов).` });
      return;
    }
    const firstId = Array.isArray(adjustmentIds) ? Number(adjustmentIds[0]) : NaN;
    // Предварительное чтение — только чтобы знать, какие месяцы запереть. Решение — по
    // карточке, вычисленной заново уже под локами (версия обязана совпасть).
    const preview = Number.isInteger(firstId) ? await findCardByAdjustmentId(getPool(), firstId) : null;
    if (!preview) {
      res.status(409).json({ success: false, error: CARD_CHANGED_MESSAGE });
      return;
    }
    // Соседний день (в т.ч. в соседнем месяце) не должен появиться, пока идёт отказ.
    const result = await withQuotaLocks(rejectLockPairs(preview), client => rejectCorrectionLeaveInTx(
      client,
      { adjustmentIds, version, reason, userId: req.user.id },
      { reapproveTail: (employeeId, workDate, exec) => reapproveEmployeeMonthTail(employeeId, workDate, exec) },
    ));

    await reportQuotaTailTransitions(req, result.transitions, 'correction_leave_reject');
    // Файлы — последовательно: параллельная очистка общего файла могла бы оставить сироту.
    for (const adjustmentId of result.card.adjustment_ids) {
      try {
        const orphanedR2Keys = await purgeCorrectionAttachments(adjustmentId);
        if (orphanedR2Keys.length > 0 && await r2Service.isEnabledAsync()) {
          for (const key of orphanedR2Keys) await r2Service.deleteObject(key);
        }
      } catch (cleanupErr) {
        console.warn('correction-leaves.reject: attachments cleanup failed', cleanupErr);
      }
    }
    await auditService.logFromRequest(req, req.user.id, 'REJECT_CORRECTION_LEAVE', {
      entityType: 'timesheet_correction_leave_rejection',
      entityId: String(result.rejectionId),
      details: {
        employee_id: result.card.employee_id,
        leave_status: result.card.status,
        days: result.card.days,
        adjustment_ids: result.card.adjustment_ids,
        reason,
      },
    });
    await notificationService.emitInserted(result.notifications);
    for (const target of result.pushTargets) {
      await pushService.sendGenericNotification(target.userIds, target.title, target.body, { path: target.path })
        .catch(e => console.warn('correction-leaves.reject push error:', e));
    }
    void emitToHr().catch(e => console.warn('correction-leaves.reject emit error:', e));
    const timesheetTargets = [result.employeeUserId, result.card.author_id, req.user.id]
      .filter((id): id is string => !!id);
    emitDomainChange({
      event: 'correction:changed',
      targetUserIds: timesheetTargets,
      payload: { employeeId: result.card.employee_id, action: 'correction_leave_rejected' },
    });
    kickCorrectionLeaveReconcile();
    res.json({ success: true });
  } catch (err) {
    handleError(res, req, err, 'reject');
  }
};

const fileUrl = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const documentId = Number(req.params.documentId);
    if (!Number.isInteger(documentId) || documentId <= 0) {
      res.status(400).json({ success: false, error: 'Некорректный id файла' });
      return;
    }
    const doc = await findVisibleCorrectionDocument(getPool(), documentId);
    if (!doc) {
      res.status(404).json({ success: false, error: 'Файл не найден' });
      return;
    }
    const disposition = req.query.disposition === 'inline' ? 'inline' : 'attachment';
    const downloadUrl = await r2Service.generateDownloadUrl(doc.r2_key, doc.file_name, disposition);
    res.json({ success: true, data: { download_url: downloadUrl, file_name: doc.file_name } });
  } catch (err) {
    handleError(res, req, err, 'fileUrl');
  }
};

export const correctionLeavesController = {
  list,
  acknowledge,
  acknowledgeRemoved,
  reject,
  fileUrl,
};
