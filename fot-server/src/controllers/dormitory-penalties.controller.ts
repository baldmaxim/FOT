/**
 * «Проживание» → «Общежитие» → «История взысканий» (миграция 378): список, проверка для окна «Заселить» и правка
 * записей. Право — вкладки «Проживание» (/staff-control/dormitory): список — view, проверка и запись — edit (гарды в
 * dormitory.routes.ts); охват — список кадров (rosterEmployeeIds), по сотруднику — canWriteStay, как у проживаний:
 * чужой employee_id руками не подставить.
 */
import type { Response } from 'express';
import { z } from 'zod';

import type { AuthenticatedRequest } from '../types/index.js';
import { auditService } from '../services/audit.service.js';
import {
  addPenalty,
  getPenalty,
  listPenalties,
  penaltyMatchOf,
  removePenalty,
  updatePenalty,
  type IDormitoryPenalty,
  type IDormitoryPenaltyInput,
} from '../services/dormitory-penalties.service.js';
import { getEmployeeState } from '../services/dormitory-stays.service.js';
import { moscowTodayIso } from '../utils/date.utils.js';
import { canWriteStay, rosterEmployeeIds } from './dormitory-access.js';

const NOT_FOUND = { success: false, error: 'Запись не найдена' };
const NO_ACCESS = { success: false, error: 'Нет доступа к сотруднику' };
const ENTITY_TYPE = 'dormitory_penalties';
/** Как CHECK dormitory_penalty_note_length (миграция 378). */
export const PENALTY_NOTE_MAX_LENGTH = 1000;

const employeeIdSchema = z.coerce.number({ invalid_type_error: 'Выберите сотрудника' })
  .int('Выберите сотрудника')
  .positive('Выберите сотрудника');

const penaltyFieldsSchema = z.object({
  penalty_date: z.preprocess(
    value => (value === '' || value === undefined ? null : value),
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата — ДД.ММ.ГГГГ').nullable(),
  ),
  note: z.preprocess(
    value => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() || null : value ?? null),
    z.string().max(PENALTY_NOTE_MAX_LENGTH, `Информация — не длиннее ${PENALTY_NOTE_MAX_LENGTH} знаков`).nullable(),
  ),
});

/** Дата не в будущем (МСК) и реальная; дата или информация — хотя бы одно (как CHECK миграции 378). */
const parsePenaltyFields = (body: unknown): IDormitoryPenaltyInput => {
  const input = penaltyFieldsSchema.parse(body ?? {});
  if (input.penalty_date !== null) {
    const parsed = new Date(`${input.penalty_date}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== input.penalty_date) {
      throw new z.ZodError([{ code: 'custom', path: ['penalty_date'], message: 'Нет такой даты' }]);
    }
    if (input.penalty_date > moscowTodayIso()) {
      throw new z.ZodError([{ code: 'custom', path: ['penalty_date'], message: 'Дата взыскания — не позже сегодня' }]);
    }
  }
  if (input.penalty_date === null && input.note === null) {
    throw new z.ZodError([{ code: 'custom', path: ['note'], message: 'Укажите дату или информацию' }]);
  }
  return input;
};

const handleZodError = (error: unknown, res: Response): boolean => {
  if (error instanceof z.ZodError) {
    res.status(400).json({ success: false, error: error.errors[0]?.message ?? 'Некорректные данные' });
    return true;
  }
  return false;
};

const parseId = (req: AuthenticatedRequest): number | null => {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const auditDetails = (penalty: IDormitoryPenalty) => ({
  employee_id: penalty.employee_id,
  penalty_date: penalty.penalty_date,
  note: penalty.note,
  source: penalty.source,
});

/** GET /api/dormitory/penalties — «История взысканий» в охвате списка кадров. */
const list = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    res.json({ success: true, data: await listPenalties(await rosterEmployeeIds(req)) });
  } catch (err) {
    console.error('dormitoryPenalties.list error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения истории взысканий' });
  }
};

/** GET /api/dormitory/penalties/check?employee_id= — взыскания сотрудника для окна «Заселить» (только в охвате). */
const check = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = employeeIdSchema.parse(req.query.employee_id);
    if (!(await canWriteStay(req, employeeId))) {
      res.status(403).json(NO_ACCESS);
      return;
    }
    res.json({ success: true, data: await penaltyMatchOf(employeeId) });
  } catch (err) {
    if (handleZodError(err, res)) return;
    console.error('dormitoryPenalties.check error:', err);
    res.status(500).json({ success: false, error: 'Ошибка проверки взысканий' });
  }
};

/** POST /api/dormitory/penalties { employee_id, penalty_date?, note? } — добавить запись (и уволенному). */
const add = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = employeeIdSchema.parse((req.body as { employee_id?: unknown } | undefined)?.employee_id);
    const input = parsePenaltyFields(req.body);
    const employee = await getEmployeeState(employeeId);
    if (!employee) {
      res.status(404).json({ success: false, error: 'Сотрудник не найден' });
      return;
    }
    if (!(await canWriteStay(req, employeeId))) {
      res.status(403).json(NO_ACCESS);
      return;
    }
    const penalty = await addPenalty(employeeId, input);
    await auditService.logFromRequest(req, req.user.id, 'DORMITORY_PENALTY_ADDED', {
      entityType: ENTITY_TYPE,
      entityId: String(penalty.id),
      details: auditDetails(penalty),
    });
    res.json({ success: true, data: penalty });
  } catch (err) {
    if (handleZodError(err, res)) return;
    console.error('dormitoryPenalties.add error:', err);
    res.status(500).json({ success: false, error: 'Ошибка добавления' });
  }
};

/** PATCH /api/dormitory/penalties/:id { penalty_date?, note? } — дата и информация; сотрудник не меняется. */
const update = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = parseId(req);
    const current = id === null ? null : await getPenalty(id);
    if (id === null || !current) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    if (req.body && typeof req.body === 'object' && 'employee_id' in req.body) {
      res.status(400).json({ success: false, error: 'Сотрудника записи не меняют — удалите запись и добавьте заново' });
      return;
    }
    const input = parsePenaltyFields(req.body);
    if (!(await canWriteStay(req, current.employee_id))) {
      res.status(403).json(NO_ACCESS);
      return;
    }
    if (input.penalty_date === current.penalty_date && input.note === current.note) {
      res.json({ success: true, data: current });
      return;
    }
    const updated = await updatePenalty(id, input);
    if (!updated) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    await auditService.logFromRequest(req, req.user.id, 'DORMITORY_PENALTY_UPDATED', {
      entityType: ENTITY_TYPE,
      entityId: String(id),
      details: { from: auditDetails(updated.before), to: auditDetails(updated.after) },
    });
    res.json({ success: true, data: updated.after });
  } catch (err) {
    if (handleZodError(err, res)) return;
    console.error('dormitoryPenalties.update error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения' });
  }
};

/** DELETE /api/dormitory/penalties/:id — удалить запись списка. */
const remove = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = parseId(req);
    const current = id === null ? null : await getPenalty(id);
    if (id === null || !current) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    if (!(await canWriteStay(req, current.employee_id))) {
      res.status(403).json(NO_ACCESS);
      return;
    }
    const deleted = await removePenalty(id);
    if (!deleted) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    await auditService.logFromRequest(req, req.user.id, 'DORMITORY_PENALTY_DELETED', {
      entityType: ENTITY_TYPE,
      entityId: String(id),
      details: auditDetails(deleted),
    });
    res.json({ success: true, data: deleted });
  } catch (err) {
    console.error('dormitoryPenalties.remove error:', err);
    res.status(500).json({ success: false, error: 'Ошибка удаления' });
  }
};

export const dormitoryPenaltiesController = { list, check, add, update, remove };
