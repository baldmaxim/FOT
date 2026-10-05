/**
 * «Оплачено» в карточке «Зарплата → Подробно»: суммы статей «Сводной ведомости» ЗУП по месяцам.
 * Скоуп — как у условий оплаты: читает тот, кто видит условия сотрудника, правит — кто может их менять.
 */
import type { Response } from 'express';
import { z } from 'zod';

import type { AuthenticatedRequest } from '../types/index.js';
import { withTransaction } from '../config/postgres.js';
import { auditService } from '../services/audit.service.js';
import {
  getPaidAmounts,
  PAYROLL_PAID_ITEM_CODES,
  PAYROLL_PAID_NEGATIVE_ITEMS,
  savePaidAmounts,
} from '../services/payroll/payroll-paid.service.js';
import { canEditPayrollEmployee, canReadPayrollEmployee } from '../services/payroll/payroll-scope.service.js';
import { moscowTodayIso } from '../utils/date.utils.js';

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Ожидается месяц YYYY-MM');

/** Верх NUMERIC(12,2): больше — переполнение в БД и 500 вместо понятной ошибки. */
const MAX_MONEY = 9_999_999_999.99;

/** Не больше двух знаков после запятой: NUMERIC(12,2) молча округлил бы третий. */
const hasCents = (value: number): boolean => Math.abs(Math.round(value * 100) - value * 100) < 1e-6;

const amountSchema = z.number()
  .finite('Некорректная сумма')
  .refine(value => Math.abs(value) <= MAX_MONEY, 'Слишком большая сумма')
  .refine(hasCents, 'Не больше двух знаков после запятой');

const cellSchema = z.object({
  month: monthSchema,
  item: z.enum(PAYROLL_PAID_ITEM_CODES),
  amount: amountSchema.nullable(),
});

/** Таблица карточки — 21 статья × 6 месяцев; запас на случай окна шире. */
const MAX_CELLS = 200;

const saveBodySchema = z.object({
  cells: z.array(cellSchema).min(1).max(MAX_CELLS),
}).superRefine((body, ctx) => {
  const currentMonth = moscowTodayIso().slice(0, 7);
  const seen = new Set<string>();
  body.cells.forEach((cell, index) => {
    const key = `${cell.month}:${cell.item}`;
    if (seen.has(key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cells', index], message: 'Ячейка передана дважды' });
    }
    seen.add(key);
    if (cell.month > currentMonth) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cells', index], message: 'Месяц ещё не наступил' });
    }
    if (cell.amount !== null && cell.amount < 0 && !PAYROLL_PAID_NEGATIVE_ITEMS.has(cell.item)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cells', index], message: 'Сумма не может быть отрицательной' });
    }
  });
});

const rangeQuerySchema = z.object({
  from: monthSchema,
  to: monthSchema,
}).refine(range => range.from <= range.to, 'Начало периода позже конца');

function handleZodError(error: unknown, res: Response): boolean {
  if (error instanceof z.ZodError) {
    res.status(400).json({ success: false, error: error.errors[0]?.message ?? 'Некорректные данные' });
    return true;
  }
  return false;
}

/** GET /api/payroll/terms/employee/:empId/paid?from=YYYY-MM&to=YYYY-MM — суммы за месяцы периода. */
const getByEmployee = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = Number(req.params.empId);
    if (!Number.isInteger(employeeId) || !(await canReadPayrollEmployee(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }
    const range = rangeQuerySchema.parse(req.query);
    const data = await getPaidAmounts(employeeId, range.from, range.to);
    res.json({ success: true, data });
  } catch (err) {
    if (handleZodError(err, res)) return;
    console.error('payrollPaid.getByEmployee error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения сумм «Оплачено»' });
  }
};

/** PUT /api/payroll/terms/employee/:empId/paid — записать правки ячеек (null — очистить). */
const save = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = Number(req.params.empId);
    if (!Number.isInteger(employeeId) || !(await canEditPayrollEmployee(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }
    const body = saveBodySchema.parse(req.body);
    const changed = await withTransaction(client => savePaidAmounts(client, {
      employeeId,
      cells: body.cells,
      updatedBy: req.user.id,
    }));

    // Повторное сохранение без правок аудит не засоряет.
    if (changed > 0) {
      await auditService.logFromRequest(req, req.user.id, 'PAYROLL_PAID_AMOUNTS_SAVED', {
        entityType: 'payroll_paid_amounts',
        entityId: String(employeeId),
        // Суммы в аудит пишем, как у условий оплаты: это основание, а не секрет.
        details: { employee_id: employeeId, cells: body.cells, changed },
      });
    }

    res.json({ success: true, data: { changed } });
  } catch (err) {
    if (handleZodError(err, res)) return;
    console.error('payrollPaid.save error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения сумм «Оплачено»' });
  }
};

export const payrollPaidController = { getByEmployee, save };
