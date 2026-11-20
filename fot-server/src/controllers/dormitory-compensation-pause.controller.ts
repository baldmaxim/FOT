/**
 * «Проживание» → «Компенсация аренды»: приостановить, возобновить, завершить паузу (миграция 374). Право — запись
 * вкладки «Проживание» (гард dormitoryEdit в dormitory.routes.ts), по сотруднику — canWriteStay, как у правки записи.
 * Аудит — DORMITORY_STAY_UPDATED / DORMITORY_STAY_ADDED с action; повтор того же запроса — 200 без записи и аудита.
 */
import type { Response } from 'express';
import { z } from 'zod';

import type { AuthenticatedRequest } from '../types/index.js';
import { auditService } from '../services/audit.service.js';
import {
  finishCompensationPause,
  resumeCompensation,
  suspendCompensation,
  type CompensationPauseResult,
} from '../services/dormitory-compensation-pause.service.js';
import { getStay } from '../services/dormitory-stays.service.js';
import { DormitoryAllowanceConflictError } from '../services/payroll/payroll-dormitory-allowances.service.js';
import { canWriteStay } from './dormitory-access.js';
import { dormitoryStayAuditDetails, stayDateSchema } from './dormitory-stay-input.js';

const NOT_FOUND = { success: false, error: 'Запись не найдена' };

const FAILURES: Record<string, { status: number; error: string }> = {
  not_found: { status: 404, error: 'Запись не найдена' },
  not_compensation: { status: 400, error: 'Приостанавливают только компенсацию аренды' },
  before_check_in: { status: 400, error: 'Дата приостановки должна быть позже начала компенсации' },
  not_open: { status: 400, error: 'К этой дате компенсация уже закончилась' },
  not_latest: { status: 400, error: 'Приостанавливают последнюю компенсацию сотрудника' },
  already_paused: { status: 409, error: 'Компенсация уже приостановлена с другой даты' },
  not_paused: { status: 400, error: 'Компенсация не приостановлена' },
  before_pause: { status: 400, error: 'Дата возобновления — не раньше даты приостановки' },
  already_resumed: { status: 409, error: 'Компенсация уже возобновлена с другой даты' },
  overlap: { status: 409, error: 'В эти даты у сотрудника уже есть проживание — в общежитии или квартире' },
};

const parseId = (req: AuthenticatedRequest): number | null => {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const dateBodySchema = z.object({ date: stayDateSchema('Укажите дату') });

type Action = 'suspend' | 'resume' | 'finish';

const handle = (
  action: Action,
  apply: (id: number, body: unknown) => Promise<CompensationPauseResult>,
) => async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = parseId(req);
    const current = id === null ? null : await getStay(id);
    if (id === null || !current) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    if (!(await canWriteStay(req, current.employee_id))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }
    const result = await apply(id, req.body ?? {});
    if (typeof result === 'string') {
      const failure = FAILURES[result];
      res.status(failure.status).json({ success: false, error: failure.error });
      return;
    }
    if (!result.repeated) {
      if (action === 'resume') {
        await auditService.logFromRequest(req, req.user.id, 'DORMITORY_STAY_ADDED', {
          entityType: 'employee_dormitory_stays',
          entityId: String(result.after.id),
          details: { action, ...dormitoryStayAuditDetails(result.after) },
        });
      } else {
        await auditService.logFromRequest(req, req.user.id, 'DORMITORY_STAY_UPDATED', {
          entityType: 'employee_dormitory_stays',
          entityId: String(result.after.id),
          details: { action, from: dormitoryStayAuditDetails(result.before), to: dormitoryStayAuditDetails(result.after) },
        });
      }
    }
    res.json({ success: true, data: result.after });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ success: false, error: err.errors[0]?.message ?? 'Некорректные данные' });
      return;
    }
    if (err instanceof DormitoryAllowanceConflictError) {
      res.status(409).json({ success: false, error: err.message, code: err.code });
      return;
    }
    console.error(`dormitoryCompensation.${action} error:`, err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения' });
  }
};

export const dormitoryCompensationPauseController = {
  /** POST /api/dormitory/stays/:id/suspend { date } — приостановить с даты. */
  suspend: handle('suspend', (id, body) => suspendCompensation(id, dateBodySchema.parse(body).date)),
  /** POST /api/dormitory/stays/:id/resume { date } — возобновить с даты (не раньше паузы). */
  resume: handle('resume', (id, body) => resumeCompensation(id, dateBodySchema.parse(body).date)),
  /** POST /api/dormitory/stays/:id/finish-pause — пауза становится окончанием. */
  finish: handle('finish', id => finishCompensationPause(id)),
};
