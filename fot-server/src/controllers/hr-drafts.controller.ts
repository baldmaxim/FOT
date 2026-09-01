/**
 * Черновики мастера «Добавить сотрудника»: создать → загрузить сканы (hr-documents) →
 * получить слитые распознанные поля → отметить создание → прикрепить (attach).
 */
import type { Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../types/index.js';
import { auditService } from '../services/audit.service.js';
import { resolveRequestDataScope, canAccessEmployeeInScope } from '../services/data-scope.service.js';
import { isHrCryptoConfigured } from '../services/hr-crypto.service.js';
import {
  HrDraftError,
  attachDraftToEmployee,
  buildDraftView,
  markEmployeeCreated,
  createDraft,
  listMyOpenDrafts,
  loadDraft,
  updateDraftPayload,
  type IDraftPayload,
} from '../services/hr-draft.service.js';

import { hrProfileInputSchema } from './hr-profiles.schema.js';
import { isTimekeeper, loadTimekeeperScopeSnapshot } from '../services/timekeeper-scope.service.js';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const draftPayloadSchema = z.object({
  full_name: z.string().trim().max(200).nullable().optional(),
  hire_date: z.string().regex(ISO_DATE).nullable().optional(),
  org_department_id: z.string().uuid().nullable().optional(),
  position_id: z.string().uuid().nullable().optional(),
  tab_number: z.string().trim().max(50).nullable().optional(),
  profile: hrProfileInputSchema.partial().optional(),
});
const handleError = (res: Response, err: unknown, fallback: string): void => {
  if (err instanceof HrDraftError) {
    res.status(err.status).json({ success: false, error: err.message, code: err.code, details: err.details ?? null });
    return;
  }
  if (err instanceof z.ZodError) {
    res.status(400).json({ success: false, error: err.errors[0]?.message ?? 'Некорректные данные' });
    return;
  }
  console.error(`[hr-drafts] ${fallback}:`, err instanceof Error ? err.message : err);
  res.status(500).json({ success: false, error: fallback });
};
const ensureConfigured = (res: Response): boolean => {
  if (!isHrCryptoConfigured()) {
    res.status(503).json({ success: false, error: 'Кадровый модуль не настроен (ключи шифрования)', code: 'HR_NOT_CONFIGURED' });
    return false;
  }
  return true;
};
/** Табельщица без объектов И папок → создавать некого/негде. */
const ensureCanCreate = async (req: AuthenticatedRequest, res: Response): Promise<boolean> => {
  const scope = await resolveRequestDataScope(req);
  if (!scope || scope === 'self') {
    if (isTimekeeper(req)) {
      const snapshot = await loadTimekeeperScopeSnapshot(req.user.id);
      if (snapshot.departmentSeeds.length === 0) {
        res.status(403).json({ success: false, error: 'Табельщице не назначены объекты и папки — создание сотрудников недоступно' });
        return false;
      }
      return true;
    }
    res.status(403).json({ success: false, error: 'Недостаточно прав для создания сотрудника' });
    return false;
  }
  return true;
};
const create = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!ensureConfigured(res)) return;
    if (!(await ensureCanCreate(req, res))) return;
    const payload = draftPayloadSchema.parse(req.body ?? {}) as IDraftPayload;
    const row = await createDraft(req.user.id, payload);
    res.status(201).json({ success: true, data: await buildDraftView(row) });
  } catch (err) {
    handleError(res, err, 'Ошибка создания черновика');
  }
};
const listMine = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const rows = await listMyOpenDrafts(req.user.id);
    res.json({ success: true, data: rows.map(r => ({ id: r.id, state: r.state, employee_id: r.employee_id, attach_error: r.attach_error, expires_at: r.expires_at, updated_at: r.updated_at })) });
  } catch (err) {
    handleError(res, err, 'Ошибка получения черновиков');
  }
};
const get = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const row = await loadDraft(String(req.params.draftId));
    if (!row || row.created_by !== req.user.id) {
      res.status(404).json({ success: false, error: 'Черновик не найден' });
      return;
    }
    res.json({ success: true, data: await buildDraftView(row) });
  } catch (err) {
    handleError(res, err, 'Ошибка получения черновика');
  }
};
const patch = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const row = await loadDraft(String(req.params.draftId));
    if (!row || row.created_by !== req.user.id) {
      res.status(404).json({ success: false, error: 'Черновик не найден' });
      return;
    }
    const payload = draftPayloadSchema.parse(req.body ?? {}) as IDraftPayload;
    const updated = await updateDraftPayload(row.id, payload);
    res.json({ success: true, data: await buildDraftView(updated) });
  } catch (err) {
    handleError(res, err, 'Ошибка сохранения черновика');
  }
};
/**
 * Сотрудник создан существующим POST /api/employees — фиксируем это в черновике
 * ДО прикрепления, чтобы повторное создание стало невозможным.
 */
const markCreated = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!ensureConfigured(res)) return;
    const employeeId = Number(req.body?.employee_id);
    if (!employeeId) {
      res.status(400).json({ success: false, error: 'employee_id обязателен' });
      return;
    }
    if (!(await canAccessEmployeeInScope(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }
    await markEmployeeCreated(String(req.params.draftId), employeeId, { userId: req.user.id });
    res.json({ success: true });
  } catch (err) {
    handleError(res, err, 'Ошибка привязки черновика к сотруднику');
  }
};
const attach = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!ensureConfigured(res)) return;
    const employeeId = Number(req.body?.employee_id);
    if (!employeeId) {
      res.status(400).json({ success: false, error: 'employee_id обязателен' });
      return;
    }
    if (!(await canAccessEmployeeInScope(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }
    const outcome = await attachDraftToEmployee(String(req.params.draftId), employeeId, { userId: req.user.id });
    await auditService.logFromRequest(req, req.user.id, 'HR_ATTACH_EXISTING', {
      entityType: 'employee', entityId: String(employeeId), details: { draft_id: req.params.draftId, ...outcome },
    });
    res.json({ success: true, data: { employee_id: employeeId, ...outcome } });
  } catch (err) {
    handleError(res, err, 'Ошибка прикрепления к сотруднику');
  }
};
export const hrDraftsController = { create, listMine, get, patch, markCreated, attach };
