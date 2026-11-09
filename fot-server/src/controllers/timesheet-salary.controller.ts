/**
 * «Табель → Зарплата» (миграции 330, 336, 341, 355): КТУ, «Выработка» бригады — по объектам или одной суммой на бригаду
 * (не обе сразу), «Доля», вписанная рублями, список «Бригады» и столбец «Сумма». Права страницы /salary/terms решает
 * только список payroll_section_access (гарды в payroll.routes); здесь — скоуп отдела, состав бригады, объекты бригады и
 * право на строку.
 *
 * Галочка «Выработка» (342) открывает два уровня: список, объекты и ввод выработки — все бригады
 * (resolveBrigadeOutputDepartmentIds), полный расчёт — только бригады, читаемые в табеле, в окне месяцев
 * (canReadBrigadeSalaryByGrant). Учётка из списка остаётся на прежнем пути canReadSalaryDepartment.
 *
 * КТУ и «Доля» (355) — тем же, кто видит «Зарплату по объектам»: список — в охвате «Зарплаты», галочка — там же, где ей
 * открыт полный расчёт (canReadBrigadeSalaryByGrant). Никому — свою строку.
 */
import type { Response } from 'express';
import { z } from 'zod';

import type { AuthenticatedRequest } from '../types/index.js';
import { auditService } from '../services/audit.service.js';
import { listBrigadeSupervisorEmployeeIdsForDepartments } from './timesheet-assigned-export.controller.js';
import {
  BRIGADE_WHOLE_SHARE_KEY,
  BrigadeOutputModeConflictError,
  BrigadeShareRejectedError,
  isOutputModeConflictDbError,
  loadBrigadeSalaryInputs,
  setBrigadeKtu,
  setBrigadeObjectOutput,
  setBrigadeOutput,
  setBrigadeShare,
  type IBrigadeOutputChange,
} from '../services/payroll/brigade-salary-inputs.service.js';
import { KTU_MAX_TENTHS, KTU_MIN_TENTHS, moneyToCents } from '../services/payroll/brigade-salary.calc.js';
import { checkFixedShare, type IShareMinutes } from '../services/payroll/brigade-salary-shares.service.js';
import { listBrigadeOutputs } from '../services/payroll/brigade-output-list.service.js';
import { listBrigadeMemberIds } from '../services/payroll/brigade-salary-source.service.js';
import { getBrigadeSalary, loadBrigadeObjectKeys } from '../services/payroll/brigade-salary.service.js';
import { query } from '../config/postgres.js';
import { resolveEffectivePageAccess } from '../services/access-control.service.js';
import { getRequestPayrollSectionAccess } from '../services/payroll/payroll-access.service.js';
import {
  canEditBrigadeInputEmployee,
  resolveBrigadeOutputDepartmentIds,
} from '../services/payroll/payroll-scope.service.js';
import {
  canReadSalaryDepartment,
  getBrigadeObjectOutputs,
  getTimesheetSalary,
  loadSalaryDepartment,
  type ITimesheetSalaryDepartment,
} from '../services/payroll/timesheet-salary.service.js';
import { resolveTimesheetReadableDepartmentId, resolveTimesheetScope } from '../services/timesheet-scope.service.js';
import {
  DEPARTMENT_MONTH_FORBIDDEN_MESSAGE,
  isDepartmentMonthAllowed,
  isTimesheetWindowExempt,
  monthAccessFromUser,
} from '../utils/timesheet-month-access.js';
import {
  MONEY_DECIMALS_MESSAGE,
  PAYROLL_MAX_MONEY,
  handlePayrollZodError,
  hasMaxDecimals,
  payrollEmployeeIdSchema,
  payrollMonthSchema,
} from './payroll-dictionary.helpers.js';

const KTU_MESSAGE = 'КТУ — от 0,0 до 2,2 с шагом 0,1';

const departmentIdSchema = z.string({ required_error: 'Выберите бригаду', invalid_type_error: 'Выберите бригаду' })
  .uuid('Выберите бригаду');
const monthSchema = payrollMonthSchema('Месяц — в формате ГГГГ-ММ');

const querySchema = z.object({ department_id: departmentIdSchema, month: monthSchema });

const listQuerySchema = z.object({ month: monthSchema });

const OBJECT_KEY_MESSAGE = 'Выберите объект бригады';

/** Ключ объекта — skud_objects.id или служебный («Не определён», «Текущая деятельность»). */
const objectKeySchema = z.string({ required_error: OBJECT_KEY_MESSAGE, invalid_type_error: OBJECT_KEY_MESSAGE })
  .refine(
    value => value === '__unknown_object__' || value === '__current_activity__'
      || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value),
    OBJECT_KEY_MESSAGE,
  );

/** Ключ вписанной доли: объект бригады или '__brigade__' (выработка одной суммой). */
const shareKeySchema = z.union([z.literal(BRIGADE_WHOLE_SHARE_KEY), objectKeySchema]);

/** Сумма выработки: null — стереть; 0,00 — разрешено (всем по 0,00). */
const outputAmountSchema = z.number({ invalid_type_error: 'Сумма должна быть числом' })
  .finite('Сумма должна быть числом')
  .min(0, 'Сумма не может быть отрицательной')
  .max(PAYROLL_MAX_MONEY, 'Слишком большая сумма')
  .refine(value => hasMaxDecimals(value, 2), MONEY_DECIMALS_MESSAGE)
  .nullable();

/** Выработка объекта. */
const objectOutputSchema = z.object({
  department_id: departmentIdSchema,
  month: monthSchema,
  object_key: objectKeySchema,
  amount: outputAmountSchema,
});

/** Выработка одной суммой на бригаду (341). */
const brigadeOutputSchema = z.object({
  department_id: departmentIdSchema,
  month: monthSchema,
  amount: outputAmountSchema,
});

const ktuSchema = z.object({
  department_id: departmentIdSchema,
  month: monthSchema,
  employee_id: payrollEmployeeIdSchema,
  ktu: z.number({ required_error: KTU_MESSAGE, invalid_type_error: KTU_MESSAGE })
    .finite(KTU_MESSAGE)
    .min(KTU_MIN_TENTHS / 10, KTU_MESSAGE)
    .max(KTU_MAX_TENTHS / 10, KTU_MESSAGE)
    .refine(value => hasMaxDecimals(value, 1), KTU_MESSAGE),
});

/** «Доля», вписанная рублями (355): null — стереть (доля снова по формуле). */
const shareSchema = z.object({
  department_id: departmentIdSchema,
  month: monthSchema,
  object_key: shareKeySchema,
  employee_id: payrollEmployeeIdSchema,
  amount: outputAmountSchema,
});

const NOT_FOUND = { success: false, error: 'Отдел не найден' };
const FORBIDDEN = { success: false, error: 'Нет доступа к этому отделу' };
const NOT_BRIGADE = { success: false, error: 'Выработка и КТУ — только у бригад', code: 'NOT_BRIGADE' };

/** «Или — или» (341): выработка уже внесена другим способом — 409 с текстом, что стереть. */
const sendOutputModeConflict = (err: unknown, res: Response): boolean => {
  if (err instanceof BrigadeOutputModeConflictError || isOutputModeConflictDbError(err)) {
    res.status(409).json({ success: false, error: (err as Error).message, code: 'OUTPUT_MODE_CONFLICT' });
    return true;
  }
  return false;
};

/** Отдел из запроса, прошедший проверку охвата; иначе ответ уже отправлен и null. */
const resolveDepartment = async (
  req: AuthenticatedRequest,
  res: Response,
  departmentId: string,
  canRead: (req: AuthenticatedRequest, departmentId: string) => Promise<boolean>,
): Promise<ITimesheetSalaryDepartment | null> => {
  const department = await loadSalaryDepartment(departmentId);
  if (!department) {
    res.status(404).json(NOT_FOUND);
    return null;
  }
  if (!(await canRead(req, department.id))) {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  return department;
};

/** Вписанные доли, снятые вместе с выработкой, — в аудит той же записи. */
const clearedSharesDetails = (change: IBrigadeOutputChange): Record<string, unknown> => (
  change.cleared_shares && change.cleared_shares.length > 0 ? { cleared_shares: change.cleared_shares } : {}
);

/** Отдел входит в охват списка «Бригады» и ввода выработки (342). */
const canAccessBrigadeOutput = async (req: AuthenticatedRequest, departmentId: string): Promise<boolean> => {
  const readable = await resolveBrigadeOutputDepartmentIds(req);
  return readable === 'all' || readable.includes(departmentId);
};

/** Бригада из запроса для списка объектов и ввода выработки: 404, 403, 400 — до вызова расчёта. */
const resolveOutputBrigade = async (
  req: AuthenticatedRequest,
  res: Response,
  departmentId: string,
): Promise<ITimesheetSalaryDepartment | null> => {
  const department = await resolveDepartment(req, res, departmentId, canAccessBrigadeOutput);
  if (!department) return null;
  if (department.kind !== 'brigade') {
    res.status(400).json(NOT_BRIGADE);
    return null;
  }
  return department;
};

/**
 * Полный расчёт по галочке «Выработка» (342), без списка «Зарплаты»: нужна страница табеля, только бригада, читаемая в
 * табеле, в окне месяцев роли. Проверка страницы отдельно: resolveTimesheetReadableDepartmentId для глобального просмотра
 * её не делает. Обычный отдел закрыт: в его ответе оклады и «К выплате» сотрудников. Иначе ответ уже отправлен и false.
 */
const canReadBrigadeSalaryByGrant = async (
  req: AuthenticatedRequest,
  res: Response,
  department: ITimesheetSalaryDepartment,
  month: string,
): Promise<boolean> => {
  const hasTimesheetPage = await resolveEffectivePageAccess(req, '/timesheet', 'view')
    || await resolveEffectivePageAccess(req, '/timesheet-hr', 'view');
  if (
    !hasTimesheetPage
    || department.kind !== 'brigade'
    || (await resolveTimesheetReadableDepartmentId(req, department.id)) !== department.id
  ) {
    res.status(403).json(FORBIDDEN);
    return false;
  }
  const scope = await resolveTimesheetScope(req);
  const [year, monthNumber] = month.split('-').map(Number);
  if (
    !isTimesheetWindowExempt(req.user, scope)
    && !isDepartmentMonthAllowed(year, monthNumber, monthAccessFromUser(req.user))
  ) {
    res.status(403).json({ success: false, error: DEPARTMENT_MONTH_FORBIDDEN_MESSAGE });
    return false;
  }
  return true;
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
    let department: ITimesheetSalaryDepartment | null;
    if (await getRequestPayrollSectionAccess(req)) {
      department = await resolveDepartment(req, res, departmentId, canReadSalaryDepartment);
      if (!department) return;
    } else {
      department = await loadSalaryDepartment(departmentId);
      if (!department) {
        res.status(404).json(NOT_FOUND);
        return;
      }
      if (!(await canReadBrigadeSalaryByGrant(req, res, department, month))) return;
    }
    res.json({ success: true, data: await getTimesheetSalary(req, department, month, { preliminary }) });
  } catch (err) {
    if (handlePayrollZodError(err, res)) return;
    console.error('timesheetSalary.get error:', err);
    res.status(500).json({ success: false, error: 'Ошибка расчёта зарплаты' });
  }
};

/**
 * GET /api/payroll/timesheet-salary/brigades?month — вкладка «Бригады»: бригады месяца (с людьми или с внесённой
 * выработкой) и внесённое — сумма бригаде, Σ и число объектов с выработкой. Долей не считает.
 */
const listBrigades = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { month } = listQuerySchema.parse(req.query);
    const readable = await resolveBrigadeOutputDepartmentIds(req);
    res.json({ success: true, data: await listBrigadeOutputs(month, readable) });
  } catch (err) {
    if (handlePayrollZodError(err, res)) return;
    console.error('timesheetSalary.listBrigades error:', err);
    res.status(500).json({ success: false, error: 'Ошибка загрузки бригад' });
  }
};

/**
 * GET /api/payroll/timesheet-salary/brigade-objects?department_id&month — стрелка во «Бригадах»: объекты бригады за
 * месяц, часы и внесённая выработка, без людей и их сумм.
 */
const brigadeObjects = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { department_id: departmentId, month } = querySchema.parse(req.query);
    const department = await resolveOutputBrigade(req, res, departmentId);
    if (!department) return;
    res.json({ success: true, data: await getBrigadeObjectOutputs(req, department, month) });
  } catch (err) {
    if (handlePayrollZodError(err, res)) return;
    console.error('timesheetSalary.brigadeObjects error:', err);
    res.status(500).json({ success: false, error: 'Ошибка загрузки объектов бригады' });
  }
};

/**
 * PUT /api/payroll/timesheet-salary/output { department_id, month, amount|null } — выработка одной суммой на бригаду
 * (341): делится на всех по КТУ × учтённые часы за месяц. При выработке по объектам — 409 (сначала стереть её).
 * null — стереть; уже пустую — 200 без изменений. Та же сумма — ни записи, ни аудита.
 */
const setOutput = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { department_id: departmentId, month, amount } = brigadeOutputSchema.parse(req.body);
    const department = await resolveOutputBrigade(req, res, departmentId);
    if (!department) return;
    const { after } = await setBrigadeOutput(
      department.id, `${month}-01`, amount === null ? null : amount.toFixed(2), req.user.id,
      (client, change) => auditService.logFromRequestWithClient(client, req, req.user.id, 'BRIGADE_SALARY_OUTPUT_SET', {
        entityType: 'brigade_salary_brigade_outputs',
        entityId: `${department.id}:${month}`,
        details: {
          department: department.name,
          month,
          amount: { from: change.before, to: change.after },
          ...clearedSharesDetails(change),
        },
      }),
    );
    res.json({ success: true, data: { output_amount: after } });
  } catch (err) {
    if (handlePayrollZodError(err, res)) return;
    if (sendOutputModeConflict(err, res)) return;
    console.error('timesheetSalary.setOutput error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения выработки' });
  }
};

/**
 * PUT /api/payroll/timesheet-salary/object-output { department_id, month, object_key, amount|null } — выработка
 * бригады на объекте. Сумма — только для объекта, где у бригады в этом месяце есть часы (та же разбивка, что
 * у расчёта; для закрытого месяца — из зафиксированного результата). null — только для внесённой ранее.
 */
const setObjectOutput = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { department_id: departmentId, month, object_key: objectKey, amount } = objectOutputSchema.parse(req.body);
    const department = await resolveOutputBrigade(req, res, departmentId);
    if (!department) return;
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
    // Проверка объекта (loadBrigadeObjectKeys фиксирует закрытый месяц под замком) — выше, до своей транзакции с тем
    // же замком: иначе второе соединение ждало бы замок, который держит первое.
    const { after } = await setBrigadeObjectOutput(
      department.id, `${month}-01`, objectKey, objectName ?? objectKey,
      amount === null ? null : amount.toFixed(2), req.user.id,
      (client, change) => auditService.logFromRequestWithClient(
        client, req, req.user.id, 'BRIGADE_SALARY_OBJECT_OUTPUT_SET', {
          entityType: 'brigade_salary_object_outputs',
          entityId: `${department.id}:${month}:${objectKey}`,
          details: {
            department: department.name,
            month,
            object_key: objectKey,
            object: objectName,
            amount: { from: change.before, to: change.after },
            ...clearedSharesDetails(change),
          },
        },
      ),
    );
    res.json({ success: true, data: { object_key: objectKey, output_amount: after } });
  } catch (err) {
    if (handlePayrollZodError(err, res)) return;
    if (sendOutputModeConflict(err, res)) return;
    console.error('timesheetSalary.setObjectOutput error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения выработки' });
  }
};

/**
 * Бригада для правки КТУ и «Доли» (355) — там же, где открыта «Зарплата по объектам»: учётка списка — в охвате
 * «Зарплаты»; галочка «Выработка» — бригада читается в табеле, месяц в окне роли (как полный расчёт). Иначе ответ уже
 * отправлен и null.
 */
const resolveEditableBrigade = async (
  req: AuthenticatedRequest,
  res: Response,
  departmentId: string,
  month: string,
): Promise<ITimesheetSalaryDepartment | null> => {
  if (await getRequestPayrollSectionAccess(req)) {
    const department = await resolveDepartment(req, res, departmentId, canReadSalaryDepartment);
    if (!department) return null;
    if (department.kind !== 'brigade') {
      res.status(400).json(NOT_BRIGADE);
      return null;
    }
    return department;
  }
  const department = await loadSalaryDepartment(departmentId);
  if (!department) {
    res.status(404).json(NOT_FOUND);
    return null;
  }
  return (await canReadBrigadeSalaryByGrant(req, res, department, month)) ? department : null;
};

const NOT_MEMBER = { success: false, error: 'Сотрудника нет в бригаде за этот месяц', code: 'NOT_MEMBER' };

/** Участник делёжа бригады за месяц: в составе и не начальник участка. */
const isBrigadeShareMember = async (departmentId: string, month: string, employeeId: number): Promise<boolean> => {
  const supervisors = await listBrigadeSupervisorEmployeeIdsForDepartments([departmentId]);
  const members = await listBrigadeMemberIds(departmentId, month);
  return !supervisors.has(employeeId) && members.includes(employeeId);
};

/**
 * PUT /api/payroll/timesheet-salary/ktu { department_id, month, employee_id, ktu } — КТУ рабочего, 0,0…2,2. Снимает его
 * вписанные доли за месяц (доля снова по формуле); КТУ, снятие и аудит — одной транзакцией под замком бригады.
 */
const setKtu = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { department_id: departmentId, month, employee_id: employeeId, ktu } = ktuSchema.parse(req.body);
    const department = await resolveEditableBrigade(req, res, departmentId, month);
    if (!department) return;
    if (!(await isBrigadeShareMember(department.id, month, employeeId))) {
      res.status(400).json(NOT_MEMBER);
      return;
    }
    if (!(await canEditBrigadeInputEmployee(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет права менять КТУ этого сотрудника' });
      return;
    }
    const { after } = await setBrigadeKtu(
      department.id, `${month}-01`, employeeId, Math.round(ktu * 10), req.user.id,
      (client, change) => auditService.logFromRequestWithClient(client, req, req.user.id, 'BRIGADE_SALARY_KTU_SET', {
        entityType: 'brigade_salary_ktu',
        entityId: `${department.id}:${month}:${employeeId}`,
        details: {
          department: department.name,
          month,
          employee_id: employeeId,
          ktu: { from: (change.before / 10).toFixed(1), to: (change.after / 10).toFixed(1) },
          ...(change.cleared_shares.length > 0 ? { cleared_shares: change.cleared_shares } : {}),
        },
      }),
    );
    res.json({ success: true, data: { employee_id: employeeId, ktu: (after / 10).toFixed(1) } });
  } catch (err) {
    if (handlePayrollZodError(err, res)) return;
    console.error('timesheetSalary.setKtu error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения КТУ' });
  }
};

/** Учтённые минуты участников ключа из текущего расчёта — те же, что на экране. */
const shareMinutesOf = (
  rows: ReadonlyArray<{ employee_id: number; counted_minutes: number; objects: ReadonlyArray<{ object_key: string; counted_minutes: number }> }>,
  key: string,
): IShareMinutes[] => rows.map(row => ({
  employee_id: row.employee_id,
  minutes: key === BRIGADE_WHOLE_SHARE_KEY
    ? row.counted_minutes
    : row.objects.find(part => part.object_key === key)?.counted_minutes ?? 0,
}));

/**
 * PUT /api/payroll/timesheet-salary/share { department_id, month, object_key, employee_id, amount|null } — «Доля»,
 * вписанная рублями (355): у сотрудника ровно она, остальным — остаток по КТУ × часы. object_key — объект (выработка по
 * объектам) или '__brigade__' (сумма бригаде). null — стереть: по существующей записи, без проверок (конфликтную, без
 * часов, ушедшему из бригады — тоже). Сумма: участник бригады с учтёнными часами на ключе, выработка внесена; объект с
 * новой долей должен сойтись (расчётный КТУ у всех вписанных ≤ 2,2, Σ ≤ выработке) — иначе 400 с максимумом. Проверка
 * — по вводу, прочитанному под замком записи. Та же сумма — ни записи, ни аудита.
 */
const setShare = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const {
      department_id: departmentId, month, object_key: objectKey, employee_id: employeeId, amount,
    } = shareSchema.parse(req.body);
    const department = await resolveEditableBrigade(req, res, departmentId, month);
    if (!department) return;
    if (!(await canEditBrigadeInputEmployee(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет права менять долю этого сотрудника' });
      return;
    }
    let minutes: IShareMinutes[] = [];
    let names = new Map<number, string>();
    if (amount !== null) {
      if (!(await isBrigadeShareMember(department.id, month, employeeId))) {
        res.status(400).json(NOT_MEMBER);
        return;
      }
      // Минуты — до транзакции записи: у закрытого месяца расчёт сам берёт тот же замок (как у setObjectOutput).
      const salary = await getBrigadeSalary(req, department.id, month);
      minutes = shareMinutesOf(salary.rows, objectKey);
      const found = await query<{ id: number; full_name: string | null }>(
        'SELECT id, full_name FROM employees WHERE id = ANY($1::int[])',
        [[...new Set([...minutes.map(item => item.employee_id), employeeId])]],
      );
      names = new Map(found.map(row => [Number(row.id), String(row.full_name ?? '').trim()]));
    }
    const amountText = amount === null ? null : amount.toFixed(2);
    const change = await setBrigadeShare(
      department.id, `${month}-01`, objectKey, employeeId, amountText, req.user.id,
      inputs => checkFixedShare(inputs, objectKey, minutes, employeeId, moneyToCents(amountText!), names),
      (client, shareChange) => auditService.logFromRequestWithClient(
        client, req, req.user.id, 'BRIGADE_SALARY_SHARE_SET', {
          entityType: 'brigade_salary_fixed_shares',
          entityId: `${department.id}:${month}:${objectKey}:${employeeId}`,
          details: {
            department: department.name,
            month,
            object_key: objectKey,
            employee_id: employeeId,
            amount: { from: shareChange.before, to: shareChange.after },
          },
        },
      ),
    );
    res.json({ success: true, data: { object_key: objectKey, employee_id: employeeId, fixed_share: change.after } });
  } catch (err) {
    if (handlePayrollZodError(err, res)) return;
    if (err instanceof BrigadeShareRejectedError) {
      res.status(400).json({ success: false, error: err.message, code: err.code });
      return;
    }
    console.error('timesheetSalary.setShare error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения доли' });
  }
};

export const timesheetSalaryController = {
  get, listBrigades, brigadeObjects, setOutput, setObjectOutput, setKtu, setShare,
};
