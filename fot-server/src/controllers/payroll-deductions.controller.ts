/**
 * Удержания «Зарплаты»: справочник видов и удержания сотрудника по месяцам (месяц · вид · сумма).
 *
 * Удержания вносятся в карточке сотрудника («Подробно» и окно на «Расчётах») и сохраняются вместе
 * с ней. Фильтр «Удержания» + месяц на «Расчётах» — в списке условий оплаты (payroll-terms.controller).
 */
import type { Response } from 'express';
import { z } from 'zod';

import type { AuthenticatedRequest } from '../types/index.js';
import { withTransaction } from '../config/postgres.js';
import { auditService } from '../services/audit.service.js';
import {
  addDeductionKind,
  allDeductionKindsExist,
  getEmployeeDeductionEntries,
  listDeductionKinds,
  setEmployeeDeductionEntries,
} from '../services/payroll/payroll-deduction-kinds.service.js';
import { canEditPayrollEmployee, canReadPayrollEmployee } from '../services/payroll/payroll-scope.service.js';

/** Пробелы внутри схлопываются: «Штраф  за мусор» и «Штраф за мусор» — один вид. */
const addKindSchema = z.object({
  name: z.string()
    .transform(value => value.replace(/\s+/g, ' ').trim())
    .pipe(z.string().min(1, 'Введите название вида').max(100, 'Не больше 100 символов')),
});

/** Верх NUMERIC(12,2). */
const MAX_AMOUNT = 9_999_999_999.99;

/** Удержания сотрудника целиком: один вид за месяц — одна строка. */
const saveEntriesSchema = z.object({
  entries: z.array(z.object({
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Ожидается месяц YYYY-MM'),
    kind_id: z.coerce.number().int().positive(),
    amount: z.coerce.number()
      .positive('Сумма удержания должна быть больше нуля')
      .max(MAX_AMOUNT, 'Слишком большая сумма удержания')
      .refine(value => Math.abs(Math.round(value * 100) - value * 100) < 1e-6, 'Не больше двух знаков после запятой'),
  })).max(200, 'Не больше 200 удержаний'),
}).refine(
  ({ entries }) => new Set(entries.map(entry => `${entry.month}|${entry.kind_id}`)).size === entries.length,
  'Вид удержания за месяц указан дважды',
);

const handleZodError = (error: unknown, res: Response): boolean => {
  if (error instanceof z.ZodError) {
    res.status(400).json({ success: false, error: error.errors[0]?.message ?? 'Некорректные данные' });
    return true;
  }
  return false;
};

const parseEmployeeId = (req: AuthenticatedRequest): number | null => {
  const employeeId = Number(req.params.empId);
  return Number.isInteger(employeeId) && employeeId > 0 ? employeeId : null;
};

/** GET /api/payroll/deduction-entries/employee/:empId — удержания сотрудника по месяцам (для карточки). */
const getEntries = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = parseEmployeeId(req);
    if (employeeId === null || !(await canReadPayrollEmployee(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }
    res.json({ success: true, data: { entries: await getEmployeeDeductionEntries(employeeId) } });
  } catch (err) {
    console.error('payrollDeductions.getEntries error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения удержаний сотрудника' });
  }
};

/** PUT /api/payroll/deduction-entries/employee/:empId { entries } — заменить удержания сотрудника. */
const saveEntries = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = parseEmployeeId(req);
    if (employeeId === null || !(await canEditPayrollEmployee(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }
    const { entries } = saveEntriesSchema.parse(req.body);
    if (!(await allDeductionKindsExist(entries.map(entry => entry.kind_id)))) {
      res.status(400).json({ success: false, error: 'Вид удержания не найден в справочнике' });
      return;
    }
    const diff = await withTransaction(client => setEmployeeDeductionEntries(client, employeeId, entries));
    if (diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0) {
      await auditService.logFromRequest(req, req.user.id, 'PAYROLL_DEDUCTION_ENTRIES_SAVED', {
        entityType: 'payroll_deduction_entries',
        entityId: String(employeeId),
        details: { employee_id: employeeId, ...diff },
      });
    }
    res.json({ success: true, data: { entries: await getEmployeeDeductionEntries(employeeId) } });
  } catch (err) {
    if (handleZodError(err, res)) return;
    console.error('payrollDeductions.saveEntries error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения удержаний сотрудника' });
  }
};

/** GET /api/payroll/deduction-kinds — справочник видов удержаний в порядке списка. */
const listKinds = async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    res.json({ success: true, data: await listDeductionKinds() });
  } catch (err) {
    console.error('payrollDeductions.listKinds error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения видов удержаний' });
  }
};

/** POST /api/payroll/deduction-kinds { name } — добавить вид; такой уже есть — 409. */
const addKind = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { name } = addKindSchema.parse(req.body);
    const kind = await addDeductionKind(name);
    if (!kind) {
      res.status(409).json({ success: false, error: 'Такой вид удержания уже есть', code: 'DUPLICATE_KIND' });
      return;
    }
    await auditService.logFromRequest(req, req.user.id, 'PAYROLL_DEDUCTION_KIND_ADDED', {
      entityType: 'payroll_deduction_kinds',
      entityId: String(kind.id),
      details: { name: kind.name },
    });
    res.json({ success: true, data: kind });
  } catch (err) {
    if (handleZodError(err, res)) return;
    console.error('payrollDeductions.addKind error:', err);
    res.status(500).json({ success: false, error: 'Ошибка добавления вида удержания' });
  }
};

export const payrollDeductionsController = { getEntries, saveEntries, listKinds, addKind };
