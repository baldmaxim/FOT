/**
 * «Зарплата → Расчёты»: сотрудники с выбранными видами удержаний и справочник видов.
 *
 * Список — штат в скоупе «Зарплаты» (как список условий оплаты: без подрядчиков, условия на дату),
 * у кого отмечен хотя бы один из выбранных видов. Виды сотруднику отмечаются в карточке «Подробно».
 * Строка — в формате списка условий (с плановой доплатой и can_edit): клик по ней открывает карточку.
 */
import type { Response } from 'express';
import { z } from 'zod';

import type { AuthenticatedRequest } from '../types/index.js';
import { query, withTransaction } from '../config/postgres.js';
import { auditService } from '../services/audit.service.js';
import {
  addDeductionKind,
  allDeductionKindsExist,
  getEmployeeDeductionKindIds,
  listDeductionKinds,
  setEmployeeDeductionKinds,
} from '../services/payroll/payroll-deduction-kinds.service.js';
import {
  canEditPayrollEmployee,
  canReadPayrollEmployee,
  resolvePayrollEditPredicate,
} from '../services/payroll/payroll-scope.service.js';
import { baseQuerySchema, buildBaseCtes, buildBaseParams } from './payroll-terms.controller.js';

/** Фильтр «Удержания»: id видов через запятую — сотрудники хотя бы с одним из них. */
const listQuerySchema = baseQuerySchema.pick({ date: true, department_id: true, q: true }).extend({
  kind_ids: z.string()
    .regex(/^\d+(,\d+)*$/, 'Ожидаются id видов через запятую')
    .transform(value => [...new Set(value.split(',').map(Number))])
    .pipe(z.array(z.number().int().positive()).min(1).max(100)),
});

/** Пробелы внутри схлопываются: «Штраф  за мусор» и «Штраф за мусор» — один вид. */
const addKindSchema = z.object({
  name: z.string()
    .transform(value => value.replace(/\s+/g, ' ').trim())
    .pipe(z.string().min(1, 'Введите название вида').max(100, 'Не больше 100 символов')),
});

const saveKindsSchema = z.object({
  kind_ids: z.array(z.coerce.number().int().positive()).max(100),
});

/** Строка «Расчётов»: колонки CTE scoped (условия на дату) и последняя плановая доплата. */
interface IPayrollDeductionRow {
  employee_id: number;
  [column: string]: unknown;
}

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

/** GET /api/payroll/deductions?kind_ids=1,2&date — сотрудники хотя бы с одним из видов, по ФИО. */
const list = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const parsed = listQuerySchema.parse(req.query);
    const { onDate, contractorRootId, params } = await buildBaseParams(req, parsed);
    params.push(parsed.kind_ids);
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
        WHERE EXISTS (
          SELECT 1 FROM payroll_employee_deductions d
           WHERE d.employee_id = s.employee_id AND d.kind_id = ANY($9::int[])
        )
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

/** GET /api/payroll/deductions/employee/:empId — виды удержаний сотрудника (для карточки). */
const getByEmployee = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = parseEmployeeId(req);
    if (employeeId === null || !(await canReadPayrollEmployee(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }
    res.json({ success: true, data: { kind_ids: await getEmployeeDeductionKindIds(employeeId) } });
  } catch (err) {
    console.error('payrollDeductions.getByEmployee error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения удержаний сотрудника' });
  }
};

/** PUT /api/payroll/deductions/employee/:empId { kind_ids } — заменить виды удержаний сотрудника. */
const saveByEmployee = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = parseEmployeeId(req);
    if (employeeId === null || !(await canEditPayrollEmployee(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }
    const { kind_ids: kindIds } = saveKindsSchema.parse(req.body);
    if (!(await allDeductionKindsExist(kindIds))) {
      res.status(400).json({ success: false, error: 'Вид удержания не найден в справочнике' });
      return;
    }
    const { added, removed } = await withTransaction(client => setEmployeeDeductionKinds(client, employeeId, kindIds));
    if (added.length > 0 || removed.length > 0) {
      await auditService.logFromRequest(req, req.user.id, 'PAYROLL_EMPLOYEE_DEDUCTIONS_SAVED', {
        entityType: 'payroll_employee_deductions',
        entityId: String(employeeId),
        details: { employee_id: employeeId, added, removed },
      });
    }
    res.json({ success: true, data: { kind_ids: await getEmployeeDeductionKindIds(employeeId) } });
  } catch (err) {
    if (handleZodError(err, res)) return;
    console.error('payrollDeductions.saveByEmployee error:', err);
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

export const payrollDeductionsController = { list, getByEmployee, saveByEmployee, listKinds, addKind };
