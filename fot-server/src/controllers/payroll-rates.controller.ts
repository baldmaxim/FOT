/**
 * Справочник ставок «Зарплаты»: название и значения по месяцам (миграция 324). Ведётся в окне «Справочник»
 * на «Расчётах». Значение меняют с текущего месяца МСК и до RATE_MONTHS_AHEAD вперёд: прошлые месяцы
 * сохраняют прежнее значение.
 */
import type { Response } from 'express';
import { z } from 'zod';

import type { AuthenticatedRequest } from '../types/index.js';
import { auditService } from '../services/audit.service.js';
import {
  addRate,
  currentRateMonth,
  deleteRate,
  listRates,
  RATE_MONTHS_AHEAD,
  shiftRateMonth,
  updateRate,
} from '../services/payroll/payroll-rates.service.js';
import {
  MONEY_DECIMALS_MESSAGE,
  handlePayrollZodError,
  hasMaxDecimals,
  parsePayrollDictionaryId,
  payrollDictionaryNameSchema,
} from './payroll-dictionary.helpers.js';

/** Верхняя граница — NUMERIC(12,2). */
const MAX_RATE_AMOUNT = 9_999_999_999.99;

/**
 * Значение не задано — null (или поле не прислали). Без coerce: '' и false стали бы нулём,
 * а «не задано» и «0» — разные значения.
 */
const rateSchema = z.object({
  name: payrollDictionaryNameSchema('Введите название ставки'),
  amount: z.number({ invalid_type_error: 'Значение должно быть числом' })
    .finite('Значение должно быть числом')
    .min(0, 'Значение не может быть отрицательным')
    .max(MAX_RATE_AMOUNT, 'Слишком большое значение')
    .refine(value => hasMaxDecimals(value, 2), MONEY_DECIMALS_MESSAGE)
    .nullable()
    .optional()
    .transform(value => value ?? null),
});

/** Правка: ещё и «с какого месяца» действует значение; не прислали — с текущего месяца МСК. */
const rateUpdateSchema = rateSchema.extend({
  effective_month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Ожидается месяц YYYY-MM').optional(),
});

const NOT_FOUND = { success: false, error: 'Ставка не найдена' };
const DUPLICATE = { success: false, error: 'Такая ставка уже есть', code: 'DUPLICATE_RATE' };
// Ставка с кодом (миграция 313) привязана к функционалу: меняется только значение.
const SYSTEM_NAME = { success: false, error: 'Название этой ставки не меняется', code: 'SYSTEM_RATE' };
const SYSTEM_DELETE = { success: false, error: 'Эту ставку удалить нельзя', code: 'SYSTEM_RATE' };
// Прошлые месяцы показывают значение своего периода — задним числом ставку не меняют.
const PAST_MONTH = { success: false, error: 'Значение меняется с текущего месяца или позже', code: 'PAST_MONTH' };
const MONTH_TOO_FAR = {
  success: false,
  error: `Значение можно задать не дальше чем на ${RATE_MONTHS_AHEAD} месяцев вперёд`,
  code: 'MONTH_TOO_FAR',
};

/** GET /api/payroll/rates — ставки с историей значений: сначала ставки с кодом, затем в порядке добавления. */
const list = async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    res.json({ success: true, data: await listRates() });
  } catch (err) {
    console.error('payrollRates.list error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения ставок' });
  }
};

/** POST /api/payroll/rates { name, amount? } — добавить ставку (значение — «с начала»); такая уже есть — 409. */
const add = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { name, amount } = rateSchema.parse(req.body);
    const rate = await addRate(name, amount);
    if (!rate) {
      res.status(409).json(DUPLICATE);
      return;
    }
    await auditService.logFromRequest(req, req.user.id, 'PAYROLL_RATE_ADDED', {
      entityType: 'payroll_rates',
      entityId: String(rate.id),
      details: { name: rate.name, amount: rate.amount },
    });
    res.json({ success: true, data: rate });
  } catch (err) {
    if (handlePayrollZodError(err, res)) return;
    console.error('payrollRates.add error:', err);
    res.status(500).json({ success: false, error: 'Ошибка добавления ставки' });
  }
};

/**
 * PATCH /api/payroll/rates/:id { name, amount?, effective_month? } — название и значение с месяца (первое
 * значение ставки — «с начала»); месяц раньше текущего или дальше RATE_MONTHS_AHEAD — 400; название
 * занято — 409; у ставки с кодом сменили название — 409.
 */
const update = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = parsePayrollDictionaryId(req);
    if (id === null) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    const { name, amount, effective_month: effectiveMonth } = rateUpdateSchema.parse(req.body);
    const current = currentRateMonth();
    const month = effectiveMonth ?? current;
    if (month < current) {
      res.status(400).json(PAST_MONTH);
      return;
    }
    if (month > shiftRateMonth(current, RATE_MONTHS_AHEAD)) {
      res.status(400).json(MONTH_TOO_FAR);
      return;
    }
    const updated = await updateRate(id, name, amount, month);
    if (updated === null) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    if (updated === 'duplicate') {
      res.status(409).json(DUPLICATE);
      return;
    }
    if (updated === 'system_name') {
      res.status(409).json(SYSTEM_NAME);
      return;
    }
    const { before, after, nameChanged, value } = updated;
    // Значение — «было → стало» в изменённом месяце: будущая смена не трогает значение на сегодня.
    if (nameChanged || value) {
      await auditService.logFromRequest(req, req.user.id, 'PAYROLL_RATE_UPDATED', {
        entityType: 'payroll_rates',
        entityId: String(id),
        details: {
          ...(nameChanged ? { name: { from: before.name, to: after.name } } : {}),
          ...(value ? { value } : {}),
        },
      });
    }
    res.json({ success: true, data: after });
  } catch (err) {
    if (handlePayrollZodError(err, res)) return;
    console.error('payrollRates.update error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения ставки' });
  }
};

/** DELETE /api/payroll/rates/:id — удалить ставку; ставку с кодом — нельзя (409). */
const remove = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = parsePayrollDictionaryId(req);
    const deleted = id === null ? null : await deleteRate(id);
    if (id === null || deleted === null) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    if (deleted === 'system') {
      res.status(409).json(SYSTEM_DELETE);
      return;
    }
    await auditService.logFromRequest(req, req.user.id, 'PAYROLL_RATE_DELETED', {
      entityType: 'payroll_rates',
      entityId: String(id),
      details: { name: deleted.name, amount: deleted.amount },
    });
    res.json({ success: true, data: deleted });
  } catch (err) {
    console.error('payrollRates.remove error:', err);
    res.status(500).json({ success: false, error: 'Ошибка удаления ставки' });
  }
};

export const payrollRatesController = { list, add, update, remove };
