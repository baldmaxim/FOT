/**
 * «Зарплата → Расчёты»: удержания сотрудников по видам и справочник видов удержаний.
 *
 * Удержание задаётся в карточке «Подробно» (вид + сумма ₽/мес в условиях оплаты), здесь —
 * только чтение. Выборка — та же, что у списка условий оплаты (скоуп «Зарплаты», без
 * подрядчиков, условия на дату), но лишь сотрудники с видом удержания. Строка — в формате
 * списка условий (с плановой доплатой и can_edit): клик по ней открывает ту же карточку.
 */
import type { Response } from 'express';
import { z } from 'zod';

import type { AuthenticatedRequest } from '../types/index.js';
import { query } from '../config/postgres.js';
import { auditService } from '../services/audit.service.js';
import { addDeductionKind, listDeductionKinds } from '../services/payroll/payroll-deduction-kinds.service.js';
import { resolvePayrollEditPredicate } from '../services/payroll/payroll-scope.service.js';
import { baseQuerySchema, buildBaseCtes, buildBaseParams } from './payroll-terms.controller.js';

const listQuerySchema = baseQuerySchema.pick({ date: true, department_id: true, q: true });

/** Пробелы внутри схлопываются: «Штраф  за мусор» и «Штраф за мусор» — один вид. */
const addKindSchema = z.object({
  name: z.string()
    .transform(value => value.replace(/\s+/g, ' ').trim())
    .pipe(z.string().min(1, 'Введите название вида').max(100, 'Не больше 100 символов')),
});

/** Строка «Расчётов»: колонки CTE scoped (условия на дату) + последняя плановая доплата. */
interface IPayrollDeductionRow {
  employee_id: number;
  deduction_kind_id: number;
  [column: string]: unknown;
}

const handleZodError = (error: unknown, res: Response): boolean => {
  if (error instanceof z.ZodError) {
    res.status(400).json({ success: false, error: error.errors[0]?.message ?? 'Некорректные данные' });
    return true;
  }
  return false;
};

/** GET /api/payroll/deductions?date&department_id&q — сотрудники с удержанием, по ФИО. */
const list = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const parsed = listQuerySchema.parse(req.query);
    const { onDate, contractorRootId, params } = await buildBaseParams(req, parsed);
    const rows = await query<IPayrollDeductionRow>(
      `${buildBaseCtes('')}
       SELECT s.*,
              ps.amount    AS planned_supplement_amount,
              ps.date_from AS planned_supplement_from,
              ps.date_to   AS planned_supplement_to
         FROM scoped s
         LEFT JOIN LATERAL (
           SELECT p.amount, p.date_from, p.date_to
             FROM payroll_planned_supplements p
            WHERE p.employee_id = s.employee_id
            ORDER BY p.id DESC
            LIMIT 1
         ) ps ON TRUE
        WHERE s.deduction_kind_id IS NOT NULL
        ORDER BY s.full_name ASC NULLS LAST, s.employee_id ASC`,
      params,
    );
    // can_edit — как в списке условий: карточка из «Расчётов» правится в том же скоупе.
    const canEditRow = await resolvePayrollEditPredicate(req);
    res.json({
      success: true,
      data: rows.map(row => ({ ...row, can_edit: canEditRow(row.employee_id) })),
      meta: { date: onDate, contractors_excluded: contractorRootId !== null },
    });
  } catch (err) {
    if (handleZodError(err, res)) return;
    console.error('payrollDeductions.list error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения удержаний' });
  }
};

/** GET /api/payroll/deduction-kinds — справочник видов удержаний в порядке столбцов. */
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

export const payrollDeductionsController = { list, listKinds, addKind };
