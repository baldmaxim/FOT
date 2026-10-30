/**
 * Основания разовой доплаты (миграция 340): выпадающий список «Основание» в окне «Разовая доплата» и окно
 * «Основания доплаты» — добавить, переименовать, удалить.
 *
 * Справочник общий (как виды удержаний): переименование меняет основание у разовых доплат всех сотрудников, без
 * проверки доступа к каждому — поэтому в аудите число изменённых доплат. Само сохранение доплаты по-прежнему
 * проверяет доступ к сотруднику (payroll-supplements.controller.ts).
 */
import type { Response } from 'express';
import { z } from 'zod';

import type { AuthenticatedRequest } from '../types/index.js';
import { auditService } from '../services/audit.service.js';
import {
  addSupplementReason,
  listSupplementReasons,
  removeSupplementReason,
  renameSupplementReason,
} from '../services/payroll/payroll-supplement-reasons.service.js';
import { handlePayrollZodError, parsePayrollDictionaryId, payrollDictionaryNameSchema } from './payroll-dictionary.helpers.js';

const reasonNameSchema = z.object({ name: payrollDictionaryNameSchema('Введите основание') });

const NOT_FOUND = { success: false, error: 'Основание не найдено' };
const DUPLICATE = { success: false, error: 'Такое основание уже есть', code: 'DUPLICATE_REASON' };

/** GET /api/payroll/supplement-reasons — все основания по алфавиту. */
const list = async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    res.json({ success: true, data: await listSupplementReasons() });
  } catch (err) {
    console.error('payrollSupplementReasons.list error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения оснований доплаты' });
  }
};

/** POST /api/payroll/supplement-reasons { name } — добавить; такое уже есть — 409. */
const add = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { name } = reasonNameSchema.parse(req.body);
    const reason = await addSupplementReason(name);
    if (!reason) {
      res.status(409).json(DUPLICATE);
      return;
    }
    await auditService.logFromRequest(req, req.user.id, 'PAYROLL_SUPPLEMENT_REASON_ADDED', {
      entityType: 'payroll_supplement_reasons',
      entityId: String(reason.id),
      details: { name: reason.name },
    });
    res.json({ success: true, data: reason });
  } catch (err) {
    if (handlePayrollZodError(err, res)) return;
    console.error('payrollSupplementReasons.add error:', err);
    res.status(500).json({ success: false, error: 'Ошибка добавления основания' });
  }
};

/** PATCH /api/payroll/supplement-reasons/:id { name } — переименовать (и у разовых доплат); занято — 409. */
const rename = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = parsePayrollDictionaryId(req);
    if (id === null) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    const { name } = reasonNameSchema.parse(req.body);
    const renamed = await renameSupplementReason(id, name);
    if (renamed === null) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    if (renamed === 'duplicate') {
      res.status(409).json(DUPLICATE);
      return;
    }
    if (renamed.previousName !== renamed.reason.name) {
      await auditService.logFromRequest(req, req.user.id, 'PAYROLL_SUPPLEMENT_REASON_RENAMED', {
        entityType: 'payroll_supplement_reasons',
        entityId: String(id),
        details: { from: renamed.previousName, to: renamed.reason.name, supplements: renamed.supplements },
      });
    }
    res.json({ success: true, data: renamed.reason });
  } catch (err) {
    if (handlePayrollZodError(err, res)) return;
    console.error('payrollSupplementReasons.rename error:', err);
    res.status(500).json({ success: false, error: 'Ошибка переименования основания' });
  }
};

/** DELETE /api/payroll/supplement-reasons/:id — убрать из списка; у внесённых доплат основание остаётся. */
const remove = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = parsePayrollDictionaryId(req);
    const removed = id === null ? null : await removeSupplementReason(id);
    if (id === null || removed === null) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    await auditService.logFromRequest(req, req.user.id, 'PAYROLL_SUPPLEMENT_REASON_DELETED', {
      entityType: 'payroll_supplement_reasons',
      entityId: String(id),
      details: { name: removed.name },
    });
    res.json({ success: true, data: removed });
  } catch (err) {
    console.error('payrollSupplementReasons.remove error:', err);
    res.status(500).json({ success: false, error: 'Ошибка удаления основания' });
  }
};

export const payrollSupplementReasonsController = { list, add, rename, remove };
