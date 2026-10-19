/**
 * Таблицы окна «Справочник» на «Расчётах» (миграция 315): «Удержания» (виды и сумма ₽/мес — те же, что
 * «Удержание» окна сотрудника) и «Экспорт» видимых строк любой из таблиц и «Свода».
 */
import type { Response } from 'express';
import { z } from 'zod';

import type { AuthenticatedRequest } from '../types/index.js';
import { withTransaction } from '../config/postgres.js';
import { auditService } from '../services/audit.service.js';
import {
  allDeductionKindsExist,
  listDeductionRegistry,
  setEmployeeDeductionKinds,
} from '../services/payroll/payroll-deduction-kinds.service.js';
import {
  canWritePayrollRegistryEmployee,
  resolvePayrollStaffScope,
} from '../services/payroll/payroll-registry-scope.service.js';
import { resolvePayrollEditPredicate } from '../services/payroll/payroll-scope.service.js';
import { setTermsAmountFrom, type TermsAmountSetResult } from '../services/payroll/payroll-terms-amount.service.js';
import { lockPayrollEmployee } from '../services/payroll/payroll-terms.service.js';
import type { ITableSnapshotSheet } from '../services/table-snapshot-excel.service.js';
import { moscowTodayIso } from '../utils/date.utils.js';
import {
  handlePayrollZodError,
  parsePayrollEmployeeIdParam,
  payrollDateSchema,
  payrollPositiveMoneySchema,
  payrollRegistryTermsPeriod,
  withCanEdit,
} from './payroll-dictionary.helpers.js';
import { sendTableSnapshotXlsx } from './table-snapshot-export.js';

/** Лист xlsx у каждой таблицы: имя листа ≤ 31 символа, имя умной таблицы — латиница. */
const REGISTRY_SHEETS = new Map<string, ITableSnapshotSheet>([
  ['housing', { sheetName: 'Доплата за проживание', tableName: 'HousingAllowance' }],
  ['supplements', { sheetName: 'Доплата', tableName: 'Supplements' }],
  ['compensation-stops', { sheetName: 'Без проезда', tableName: 'CompensationStops' }],
  ['deductions', { sheetName: 'Удержания', tableName: 'Deductions' }],
  ['summary', { sheetName: 'Свод', tableName: 'PayrollSummary' }],
]);

/** Виды целиком (пусто — снять все) и сумма ₽/мес с даты (null — снять). */
const saveDeductionsSchema = z.object({
  kind_ids: z.array(z.number().int().positive(), { invalid_type_error: 'Выберите вид удержания' }).max(100),
  amount: payrollPositiveMoneySchema('Укажите сумму удержания').nullable(),
  effective_from: payrollDateSchema('Укажите дату «Действует с»'),
});

const NO_ACCESS = { success: false, error: 'Нет доступа к сотруднику' };
const UNKNOWN_KIND = { success: false, error: 'Вид удержания не найден в справочнике' };
const NO_TERMS = {
  success: false,
  error: 'У сотрудника нет оклада на эту дату — сначала внесите оклад в окне сотрудника',
  code: 'NO_TERMS',
};

/** Сумма задана, а условий на дату нет: откатить всю запись, вместе с видами. */
class DeductionNoTermsError extends Error {}

/**
 * GET /api/payroll/deduction-registry[?months=…] — у кого есть вид или сумма удержания: без months — в
 * условиях на сегодня (старый клиент), months=all — за весь период, список — в этих месяцах.
 */
const listDeductions = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const period = payrollRegistryTermsPeriod(req.query.months, moscowTodayIso());
    const [scope, canEdit] = await Promise.all([resolvePayrollStaffScope(req), resolvePayrollEditPredicate(req)]);
    const rows = await listDeductionRegistry({ ...scope, period });
    res.json({ success: true, data: withCanEdit(rows, canEdit) });
  } catch (err) {
    if (handlePayrollZodError(err, res)) return;
    console.error('payrollRegistry.listDeductions error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения списка' });
  }
};

/**
 * PUT /api/payroll/deduction-registry/employee/:empId { kind_ids, amount, effective_from } — удержание
 * из таблицы: виды заменяются набором, сумма меняется «с даты и дальше» (версия условий делится, как у
 * проживания). Сумма без условий на дату — 409 NO_TERMS, виды при этом тоже не сохраняются; сумма null
 * без условий — сохраняются только виды.
 */
const saveDeductions = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = parsePayrollEmployeeIdParam(req);
    if (employeeId === null || !(await canWritePayrollRegistryEmployee(req, employeeId))) {
      res.status(403).json(NO_ACCESS);
      return;
    }
    const body = saveDeductionsSchema.parse(req.body);
    const outcome = await withTransaction(async client => {
      // Блокировка — первой: виды и сумма двух параллельных сохранений не перемешиваются.
      await lockPayrollEmployee(client, employeeId);
      if (!(await allDeductionKindsExist(body.kind_ids, client))) return null;
      const kinds = await setEmployeeDeductionKinds(client, employeeId, body.kind_ids);
      const amount: TermsAmountSetResult = await setTermsAmountFrom(client, {
        column: 'deduction_amount',
        employeeId,
        amount: body.amount,
        from: body.effective_from,
        createdBy: req.user.id,
      });
      if (amount.status === 'no_terms' && body.amount !== null) throw new DeductionNoTermsError();
      return { kinds, amount };
    });
    if (!outcome) {
      res.status(400).json(UNKNOWN_KIND);
      return;
    }

    const { kinds, amount } = outcome;
    if (kinds.added.length > 0 || kinds.removed.length > 0) {
      await auditService.logFromRequest(req, req.user.id, 'PAYROLL_EMPLOYEE_DEDUCTIONS_SAVED', {
        entityType: 'payroll_employee_deductions',
        entityId: String(employeeId),
        details: { source: 'deduction_registry', employee_id: employeeId, added: kinds.added, removed: kinds.removed },
      });
    }
    if (amount.status === 'saved') {
      // Правка условий — тем же событием, что из окна сотрудника; source отличает таблицу.
      await auditService.logFromRequest(req, req.user.id, 'PAYROLL_TERMS_ASSIGNED', {
        entityType: 'payroll_compensation_terms',
        entityId: String(amount.termsId),
        details: {
          source: 'deduction_registry',
          employee_id: employeeId,
          effective_from: body.effective_from,
          deduction_amount: body.amount,
          previous_deduction_amount: amount.previousAmount,
          previous_terms_id: amount.previousTermsId,
          later_versions_updated: amount.laterUpdated,
        },
      });
    }
    const changed = kinds.added.length > 0 || kinds.removed.length > 0 || amount.status === 'saved';
    res.json({ success: true, data: { changed } });
  } catch (err) {
    if (err instanceof DeductionNoTermsError) {
      res.status(409).json(NO_TERMS);
      return;
    }
    if (handlePayrollZodError(err, res)) return;
    console.error('payrollRegistry.saveDeductions error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения удержания' });
  }
};

/**
 * POST /api/payroll/registry/:table/export — xlsx ровно как на экране: сортировка и фильтры применены
 * на клиенте, сервер только оформляет лист (до 1000 строк).
 */
const exportTable = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const sheet = REGISTRY_SHEETS.get(String(req.params.table));
    if (!sheet) {
      res.status(404).json({ success: false, error: 'Таблица не найдена' });
      return;
    }
    await sendTableSnapshotXlsx(res, req.body, sheet);
  } catch (err) {
    if (handlePayrollZodError(err, res)) return;
    console.error('payrollRegistry.export error:', err);
    res.status(500).json({ success: false, error: 'Не удалось выгрузить таблицу' });
  }
};

export const payrollRegistryController = { listDeductions, saveDeductions, exportTable };
