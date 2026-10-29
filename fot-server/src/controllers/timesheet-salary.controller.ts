/**
 * «Табель → Зарплата» (миграции 330, 336): КТУ, «Выработка» бригады по объектам и столбец «Сумма».
 * Права страницы /salary/terms решает только список payroll_section_access (гарды в payroll.routes);
 * здесь — скоуп отдела, состав бригады, объекты бригады и право на строку.
 */
import type { Response } from 'express';
import { z } from 'zod';

import type { AuthenticatedRequest } from '../types/index.js';
import { auditService } from '../services/audit.service.js';
import { listBrigadeSupervisorEmployeeIdsForDepartments } from './timesheet-assigned-export.controller.js';
import {
  loadBrigadeSalaryInputs,
  setBrigadeKtu,
  setBrigadeObjectOutput,
} from '../services/payroll/brigade-salary-inputs.service.js';
import { listBrigadeMemberIds } from '../services/payroll/brigade-salary-source.service.js';
import { loadBrigadeObjectKeys } from '../services/payroll/brigade-salary.service.js';
import { canEditPayrollEmployee } from '../services/payroll/payroll-scope.service.js';
import {
  canReadSalaryDepartment,
  getTimesheetSalary,
  loadSalaryDepartment,
  type ITimesheetSalaryDepartment,
} from '../services/payroll/timesheet-salary.service.js';
import {
  MONEY_DECIMALS_MESSAGE,
  PAYROLL_MAX_MONEY,
  handlePayrollZodError,
  hasMaxDecimals,
  payrollEmployeeIdSchema,
  payrollMonthSchema,
} from './payroll-dictionary.helpers.js';

const KTU_MESSAGE = 'КТУ — от 0,5 до 2,0 с шагом 0,1';

const departmentIdSchema = z.string({ required_error: 'Выберите бригаду', invalid_type_error: 'Выберите бригаду' })
  .uuid('Выберите бригаду');
const monthSchema = payrollMonthSchema('Месяц — в формате ГГГГ-ММ');

const querySchema = z.object({ department_id: departmentIdSchema, month: monthSchema });

const OBJECT_KEY_MESSAGE = 'Выберите объект бригады';

/** Ключ объекта — skud_objects.id или служебный («Не определён», «Текущая деятельность»). */
const objectKeySchema = z.string({ required_error: OBJECT_KEY_MESSAGE, invalid_type_error: OBJECT_KEY_MESSAGE })
  .refine(
    value => value === '__unknown_object__' || value === '__current_activity__'
      || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value),
    OBJECT_KEY_MESSAGE,
  );

/** Выработка объекта: null — стереть; 0,00 — разрешено (всем на объекте по 0,00). */
const objectOutputSchema = z.object({
  department_id: departmentIdSchema,
  month: monthSchema,
  object_key: objectKeySchema,
  amount: z.number({ invalid_type_error: 'Сумма должна быть числом' })
    .finite('Сумма должна быть числом')
    .min(0, 'Сумма не может быть отрицательной')
    .max(PAYROLL_MAX_MONEY, 'Слишком большая сумма')
    .refine(value => hasMaxDecimals(value, 2), MONEY_DECIMALS_MESSAGE)
    .nullable(),
});

const ktuSchema = z.object({
  department_id: departmentIdSchema,
  month: monthSchema,
  employee_id: payrollEmployeeIdSchema,
  ktu: z.number({ required_error: KTU_MESSAGE, invalid_type_error: KTU_MESSAGE })
    .finite(KTU_MESSAGE)
    .min(0.5, KTU_MESSAGE)
    .max(2, KTU_MESSAGE)
    .refine(value => hasMaxDecimals(value, 1), KTU_MESSAGE),
});

const NOT_FOUND = { success: false, error: 'Отдел не найден' };
const FORBIDDEN = { success: false, error: 'Нет доступа к этому отделу' };
const NOT_BRIGADE = { success: false, error: 'Выработка и КТУ — только у бригад', code: 'NOT_BRIGADE' };

/** Отдел из запроса, видимый пользователю; иначе ответ уже отправлен и null. */
const resolveDepartment = async (
  req: AuthenticatedRequest,
  res: Response,
  departmentId: string,
): Promise<ITimesheetSalaryDepartment | null> => {
  const department = await loadSalaryDepartment(departmentId);
  if (!department) {
    res.status(404).json(NOT_FOUND);
    return null;
  }
  if (!(await canReadSalaryDepartment(req, department.id))) {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  return department;
};

/**
 * GET /api/payroll/timesheet-salary?department_id&month — КТУ и «Сумма» для сетки табеля.
 * preliminary=1 — незакрытый месяц отдела предварительно по живому табелю; без него — как раньше, чтобы старый фронт
 * не показал предварительные суммы без пометки.
 */
const get = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { department_id: departmentId, month } = querySchema.parse(req.query);
    const preliminary = (req.query as Record<string, unknown>).preliminary === '1';
    const department = await resolveDepartment(req, res, departmentId);
    if (!department) return;
    res.json({ success: true, data: await getTimesheetSalary(req, department, month, { preliminary }) });
  } catch (err) {
    if (handlePayrollZodError(err, res)) return;
    console.error('timesheetSalary.get error:', err);
    res.status(500).json({ success: false, error: 'Ошибка расчёта зарплаты' });
  }
};

/** PUT /api/payroll/timesheet-salary/output — до 336 выработка была одна на бригаду; теперь — по объектам. */
const setOutput = async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  res.status(400).json({
    success: false,
    error: 'Выработка вводится по объектам — обновите страницу',
    code: 'OUTPUT_BY_OBJECT',
  });
};

/**
 * PUT /api/payroll/timesheet-salary/object-output { department_id, month, object_key, amount|null } — выработка
 * бригады на объекте. Сумма — только для объекта, где у бригады в этом месяце есть часы (та же разбивка, что
 * у расчёта; для закрытого месяца — из зафиксированного результата). null — только для внесённой ранее.
 */
const setObjectOutput = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { department_id: departmentId, month, object_key: objectKey, amount } = objectOutputSchema.parse(req.body);
    const department = await resolveDepartment(req, res, departmentId);
    if (!department) return;
    if (department.kind !== 'brigade') {
      res.status(400).json(NOT_BRIGADE);
      return;
    }
    const stored = (await loadBrigadeSalaryInputs(department.id, `${month}-01`)).outputs.get(objectKey) ?? null;
    let objectName = stored?.object_name ?? null;
    if (amount !== null) {
      const available = await loadBrigadeObjectKeys(req, department.id, month);
      if (!available.has(objectKey)) {
        res.status(400).json({
          success: false,
          error: stored
            ? 'На объекте нет часов бригады за этот месяц — выработку можно только стереть'
            : 'У бригады нет часов на этом объекте за этот месяц',
          code: 'OBJECT_NOT_IN_BRIGADE',
        });
        return;
      }
      objectName = available.get(objectKey)!;
    } else if (!stored) {
      res.status(400).json({
        success: false, error: 'Выработка на этом объекте не внесена', code: 'OBJECT_NOT_IN_BRIGADE',
      });
      return;
    }
    const { before, after } = await setBrigadeObjectOutput(
      department.id, `${month}-01`, objectKey, objectName ?? objectKey,
      amount === null ? null : amount.toFixed(2), req.user.id,
    );
    if (before !== after) {
      await auditService.logFromRequest(req, req.user.id, 'BRIGADE_SALARY_OBJECT_OUTPUT_SET', {
        entityType: 'brigade_salary_object_outputs',
        entityId: `${department.id}:${month}:${objectKey}`,
        details: {
          department: department.name,
          month,
          object_key: objectKey,
          object: objectName,
          amount: { from: before, to: after },
        },
      });
    }
    res.json({ success: true, data: { object_key: objectKey, output_amount: after } });
  } catch (err) {
    if (handlePayrollZodError(err, res)) return;
    console.error('timesheetSalary.setObjectOutput error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения выработки' });
  }
};

/** PUT /api/payroll/timesheet-salary/ktu { department_id, month, employee_id, ktu } — КТУ рабочего. */
const setKtu = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { department_id: departmentId, month, employee_id: employeeId, ktu } = ktuSchema.parse(req.body);
    const department = await resolveDepartment(req, res, departmentId);
    if (!department) return;
    if (department.kind !== 'brigade') {
      res.status(400).json(NOT_BRIGADE);
      return;
    }
    const supervisors = await listBrigadeSupervisorEmployeeIdsForDepartments([department.id]);
    const members = await listBrigadeMemberIds(department.id, month);
    if (supervisors.has(employeeId) || !members.includes(employeeId)) {
      res.status(400).json({ success: false, error: 'Сотрудника нет в бригаде за этот месяц', code: 'NOT_MEMBER' });
      return;
    }
    if (!(await canEditPayrollEmployee(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет права менять КТУ этого сотрудника' });
      return;
    }
    const { before, after } = await setBrigadeKtu(
      department.id, `${month}-01`, employeeId, Math.round(ktu * 10), req.user.id,
    );
    if (before !== after) {
      await auditService.logFromRequest(req, req.user.id, 'BRIGADE_SALARY_KTU_SET', {
        entityType: 'brigade_salary_ktu',
        entityId: `${department.id}:${month}:${employeeId}`,
        details: {
          department: department.name,
          month,
          employee_id: employeeId,
          ktu: { from: (before / 10).toFixed(1), to: (after / 10).toFixed(1) },
        },
      });
    }
    res.json({ success: true, data: { employee_id: employeeId, ktu: (after / 10).toFixed(1) } });
  } catch (err) {
    if (handlePayrollZodError(err, res)) return;
    console.error('timesheetSalary.setKtu error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения КТУ' });
  }
};

export const timesheetSalaryController = { get, setOutput, setObjectOutput, setKtu };
