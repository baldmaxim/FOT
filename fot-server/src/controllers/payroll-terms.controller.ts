/**
 * Условия оплаты сотрудников: чтение истории и назначение (в т.ч. массовое).
 *
 * Скоуп проверяется по каждому сотруднику отдельно (canEditEmployeeInScope):
 * ролевого права на страницу мало — бухгалтер подразделения не должен править
 * условия чужих людей. Массовое назначение возвращает отчёт «применено / отклонено»,
 * а не молча пропускает недоступных.
 */
import type { Response } from 'express';
import { z } from 'zod';

import type { AuthenticatedRequest } from '../types/index.js';
import { query } from '../config/postgres.js';
import { canAccessEmployeeInScope, canEditEmployeeInScope } from '../services/data-scope.service.js';
import { auditService } from '../services/audit.service.js';
import {
  assignTerms,
  assignTermsBulk,
  getTermsHistory,
  getTermsOnDate,
  type IAssignResult,
} from '../services/payroll/payroll-terms.service.js';

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ожидается YYYY-MM-DD');
const moneySchema = z.coerce.number().positive('Сумма должна быть больше нуля');

/**
 * Сумма привязана к виду оплаты: у оклада — monthly_salary, у почасовой — hourly_rate.
 * Тот же XOR стоит в БД (payroll_terms_amount_xor); дублируем здесь, чтобы вернуть
 * пользователю понятный текст, а не 500 от констрейнта.
 */
const termsBodySchema = z.object({
  staff_category: z.enum(['office', 'itr', 'worker']),
  calc_type: z.enum(['salary', 'hourly']),
  monthly_salary: moneySchema.optional(),
  hourly_rate: moneySchema.optional(),
  staff_units: z.coerce.number().positive().max(2).optional(),
  organization_id: z.string().uuid().nullable().optional(),
  effective_from: dateSchema,
  change_reason: z.string().trim().max(500).optional(),
  order_number: z.string().trim().max(100).optional(),
  order_date: dateSchema.optional(),
  note: z.string().trim().max(1000).optional(),
}).superRefine((value, ctx) => {
  if (value.calc_type === 'salary' && value.monthly_salary === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Для оплаты по графику нужен оклад' });
  }
  if (value.calc_type === 'hourly' && value.hourly_rate === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Для почасовой оплаты нужна часовая ставка' });
  }
});

const bulkBodySchema = z.object({
  employee_ids: z.array(z.coerce.number().int().positive()).min(1).max(500),
}).and(termsBodySchema);

function handleZodError(error: unknown, res: Response): boolean {
  if (error instanceof z.ZodError) {
    res.status(400).json({ success: false, error: error.errors[0]?.message ?? 'Некорректные данные' });
    return true;
  }
  return false;
}

/** GET /api/payroll/terms/employee/:empId — история условий сотрудника. */
const getByEmployee = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = Number(req.params.empId);
    if (!Number.isInteger(employeeId) || !(await canAccessEmployeeInScope(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }
    const data = await getTermsHistory(employeeId);
    res.json({ success: true, data });
  } catch (err) {
    console.error('payrollTerms.getByEmployee error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения условий оплаты' });
  }
};

/**
 * GET /api/payroll/terms?date=YYYY-MM-DD — список действующих условий.
 *
 * Отдаёт и тех, у кого условий нет: без них сотрудник просто не попадёт в расчёт,
 * и такой пропуск должен быть виден на экране, а не обнаружиться в день выплаты.
 */
const list = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const parsed = z.object({
      date: dateSchema.optional(),
      department_id: z.string().uuid().optional(),
      staff_category: z.enum(['office', 'itr', 'worker']).optional(),
      calc_type: z.enum(['salary', 'hourly']).optional(),
      without_terms: z.enum(['true', 'false']).optional(),
    }).parse(req.query);

    const onDate = parsed.date ?? new Date().toISOString().slice(0, 10);

    const rows = await query(
      `SELECT e.id AS employee_id,
              e.full_name,
              e.tab_number,
              d.id   AS department_id,
              d.name AS department_name,
              t.id   AS terms_id,
              t.staff_category,
              t.calc_type,
              t.monthly_salary,
              t.hourly_rate,
              t.staff_units,
              t.effective_from,
              t.effective_to
         FROM employees e
         LEFT JOIN org_departments d ON d.id = e.org_department_id
         LEFT JOIN payroll_compensation_terms t
                ON t.employee_id = e.id
               AND t.effective_from <= $1::date
               AND (t.effective_to IS NULL OR t.effective_to >= $1::date)
        WHERE e.employment_status = 'active'
          AND e.is_archived IS NOT TRUE
          AND ($2::uuid IS NULL OR e.org_department_id = $2::uuid)
          AND ($3::text IS NULL OR t.staff_category = $3::text)
          AND ($4::text IS NULL OR t.calc_type = $4::text)
          AND ($5::boolean IS NOT TRUE OR t.id IS NULL)
        ORDER BY e.full_name
        LIMIT 2000`,
      [
        onDate,
        parsed.department_id ?? null,
        parsed.staff_category ?? null,
        parsed.calc_type ?? null,
        parsed.without_terms === 'true',
      ],
    );

    res.json({ success: true, data: rows, meta: { date: onDate } });
  } catch (err) {
    if (handleZodError(err, res)) return;
    console.error('payrollTerms.list error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения списка условий оплаты' });
  }
};

/** POST /api/payroll/terms/employee/:empId — назначить или сменить условия. */
const assign = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = Number(req.params.empId);
    if (!Number.isInteger(employeeId) || !(await canEditEmployeeInScope(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }

    const body = termsBodySchema.parse(req.body);
    const previous = await getTermsOnDate(employeeId, body.effective_from);

    const termsId = await assignTerms({
      employeeId,
      staffCategory: body.staff_category,
      calcType: body.calc_type,
      monthlySalary: body.monthly_salary ?? null,
      hourlyRate: body.hourly_rate ?? null,
      staffUnits: body.staff_units,
      organizationId: body.organization_id ?? null,
      effectiveFrom: body.effective_from,
      changeReason: body.change_reason ?? null,
      orderNumber: body.order_number ?? null,
      orderDate: body.order_date ?? null,
      note: body.note ?? null,
      createdBy: req.user.id,
    });

    await auditService.logFromRequest(req, req.user.id, 'PAYROLL_TERMS_ASSIGNED', {
      entityType: 'payroll_compensation_terms',
      entityId: String(termsId),
      details: {
        employee_id: employeeId,
        effective_from: body.effective_from,
        staff_category: body.staff_category,
        calc_type: body.calc_type,
        // Суммы в аудит пишем: это кадровое основание, а не секрет.
        monthly_salary: body.monthly_salary ?? null,
        hourly_rate: body.hourly_rate ?? null,
        previous_terms_id: previous?.id ?? null,
        previous_calc_type: previous?.calc_type ?? null,
      },
    });

    res.json({ success: true, data: { terms_id: termsId } });
  } catch (err) {
    if (handleZodError(err, res)) return;
    console.error('payrollTerms.assign error:', err);
    res.status(500).json({ success: false, error: 'Ошибка назначения условий оплаты' });
  }
};

/**
 * POST /api/payroll/terms/bulk — массовое назначение с общей датой.
 *
 * Недоступные по скоупу не выбрасываются молча, а попадают в skipped: иначе
 * пользователь решит, что применил условия ко всем выделенным.
 */
const assignBulk = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const body = bulkBodySchema.parse(req.body);

    const allowed: number[] = [];
    const skipped: IAssignResult['skipped'] = [];
    for (const employeeId of body.employee_ids) {
      if (await canEditEmployeeInScope(req, employeeId)) allowed.push(employeeId);
      else skipped.push({ employee_id: employeeId, reason: 'NO_ACCESS', message: 'Нет доступа к сотруднику' });
    }

    const result = await assignTermsBulk(allowed, {
      staffCategory: body.staff_category,
      calcType: body.calc_type,
      monthlySalary: body.monthly_salary ?? null,
      hourlyRate: body.hourly_rate ?? null,
      staffUnits: body.staff_units,
      organizationId: body.organization_id ?? null,
      effectiveFrom: body.effective_from,
      changeReason: body.change_reason ?? null,
      orderNumber: body.order_number ?? null,
      orderDate: body.order_date ?? null,
      note: body.note ?? null,
      createdBy: req.user.id,
    });

    const payload: IAssignResult = {
      applied: result.applied,
      skipped: [...skipped, ...result.skipped],
    };

    await auditService.logFromRequest(req, req.user.id, 'PAYROLL_TERMS_BULK_ASSIGNED', {
      entityType: 'payroll_compensation_terms',
      entityId: body.effective_from,
      details: {
        requested: body.employee_ids.length,
        applied: payload.applied.length,
        skipped: payload.skipped.length,
        staff_category: body.staff_category,
        calc_type: body.calc_type,
        effective_from: body.effective_from,
      },
    });

    res.json({ success: true, data: payload });
  } catch (err) {
    if (handleZodError(err, res)) return;
    console.error('payrollTerms.assignBulk error:', err);
    res.status(500).json({ success: false, error: 'Ошибка массового назначения условий' });
  }
};

export const payrollTermsController = { list, getByEmployee, assign, assignBulk };
