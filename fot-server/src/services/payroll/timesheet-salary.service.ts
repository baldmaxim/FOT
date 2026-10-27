/**
 * Ответ вкладки «Табель → Зарплата»: столбцы КТУ и «Сумма» для сетки отдела или бригады.
 *
 * «Сумма» — к выплате у всех (решение 27.10.2026), то же число, что «К выплате (ФОТ)» в карточке «Зарплаты»:
 * начислено минус удержания, без НДФЛ.
 * - Отдел — расчёт ФОТ по закрытому табелю (payroll-calc.service): оклад по дням, проезд, проживание, доплаты.
 *   Табель месяца сотрудника не закрыт — суммы нет.
 * - Бригада — доля «Выработки» по КТУ (brigade-salary.service) + разовые доплаты и проживание − удержания;
 *   до закрытия — «Предварительно», как доля. Доля — в share (подсказка), Σ долей = выработке.
 */
import { query, queryOne } from '../../config/postgres.js';
import type { AuthenticatedRequest } from '../../types/index.js';
import type { BrigadeDistributionState, BrigadeSalaryErrorCode } from './brigade-salary.calc.js';
import { DEFAULT_KTU_TENTHS } from './brigade-salary-inputs.service.js';
import type { IDateRange } from './brigade-salary-source.service.js';
import { getBrigadeSalary, type BrigadeSalaryState } from './brigade-salary.service.js';
import { listEmployeeMembershipsForDepartmentPeriod } from '../timesheet-department-assignments.service.js';
import { monthBounds } from './brigade-salary-source.service.js';
import type { IBrigadeShareFact, PayrollCalcMissing } from './payroll-calc.rules.js';
import { getPayoutForEmployees, previewBrigadePayouts } from './payroll-calc.service.js';
import { resolvePayrollEditPredicate, resolvePayrollReadableDepartmentIds } from './payroll-scope.service.js';

export interface ITimesheetSalaryDepartment {
  id: string;
  name: string;
  kind: string;
}

export interface ITimesheetSalaryRow {
  employee_id: number;
  /** КТУ для выбора — текущий ввод ('1.0' по умолчанию); у отделов null. */
  ktu: string | null;
  /** Учтённые часы, по которым посчитана доля; null — суммы нет. */
  counted_hours: number | null;
  /** К выплате: начислено − удержания, без НДФЛ; null — суммы нет. */
  amount: string | null;
  /** Доля «Выработки» по КТУ (только бригада); null — нет. */
  share: string | null;
  /** Учтённые удержания месяца; null — суммы нет. */
  deducted: string | null;
  /** Чего в сумме нет: отпускные, выработка бригады и т. п. */
  missing: PayrollCalcMissing[];
  /** Отдел: закрыт ли табель месяца сотрудника; у бригады — null (состояние у всей бригады). */
  payout_state: 'closed' | 'not_closed' | null;
  source: 'version' | 'live' | null;
  can_edit: boolean;
}

export interface ITimesheetSalaryError {
  employee_id: number;
  full_name: string;
  code: BrigadeSalaryErrorCode;
  date: string;
}

export interface ITimesheetSalaryResponse {
  department_id: string;
  month: string;
  kind: 'brigade' | 'department';
  state: BrigadeSalaryState | null;
  distribution: BrigadeDistributionState | null;
  as_of: string | null;
  open_ranges: IDateRange[];
  output_amount: string | null;
  errors: ITimesheetSalaryError[];
  computed_at: string | null;
  rows: ITimesheetSalaryRow[];
}

export async function loadSalaryDepartment(departmentId: string): Promise<ITimesheetSalaryDepartment | null> {
  return queryOne<ITimesheetSalaryDepartment>(
    `SELECT id, name, COALESCE(kind, 'department') AS kind FROM org_departments WHERE id = $1`,
    [departmentId],
  );
}

/** Отдел виден в «Зарплате» этому пользователю (тот же скоуп, что у списка условий оплаты). */
export async function canReadSalaryDepartment(req: AuthenticatedRequest, departmentId: string): Promise<boolean> {
  const readable = await resolvePayrollReadableDepartmentIds(req);
  return readable === 'all' || readable.includes(departmentId);
}

async function namesOf(employeeIds: number[]): Promise<Map<number, string>> {
  if (employeeIds.length === 0) return new Map();
  const found = await query<{ id: number; full_name: string | null }>(
    'SELECT id, full_name FROM employees WHERE id = ANY($1::int[])',
    [employeeIds],
  );
  return new Map(found.map(row => [Number(row.id), String(row.full_name ?? '').trim()]));
}

export async function getTimesheetSalary(
  req: AuthenticatedRequest,
  department: ITimesheetSalaryDepartment,
  month: string,
): Promise<ITimesheetSalaryResponse> {
  if (department.kind !== 'brigade') {
    const { start, end } = monthBounds(month);
    const memberIds = [...new Set(
      (await listEmployeeMembershipsForDepartmentPeriod(department.id, start, end)).map(row => Number(row.employee_id)),
    )].sort((a, b) => a - b);
    const calcs = await getPayoutForEmployees(memberIds, month, req);
    return {
      department_id: department.id,
      month,
      kind: 'department',
      state: null,
      distribution: null,
      as_of: null,
      open_ranges: [],
      output_amount: null,
      errors: [],
      computed_at: null,
      rows: memberIds.map(employeeId => {
        const calc = calcs.get(employeeId);
        const closed = calc?.state === 'closed' ? calc : null;
        return {
          employee_id: employeeId,
          ktu: null,
          counted_hours: null,
          amount: closed?.net ?? null,
          share: null,
          deducted: closed?.deducted ?? null,
          missing: closed?.missing ?? [],
          payout_state: closed ? 'closed' : 'not_closed',
          source: null,
          can_edit: false,
        };
      }),
    };
  }

  const result = await getBrigadeSalary(req, department.id, month);
  const canEdit = await resolvePayrollEditPredicate(req);
  const members = new Set(result.member_ids);
  const byEmployee = new Map(result.rows.map(row => [row.employee_id, row]));
  const employeeIds = [...new Set([...result.member_ids, ...byEmployee.keys()])].sort((a, b) => a - b);
  const names = await namesOf([...new Set(result.errors.map(error => error.employee_id))]);
  // «Сумма» — к выплате из доли: доли нет (выработка не введена, ошибка) — суммы нет.
  const shares = new Map<number, IBrigadeShareFact>(result.rows
    .filter(row => row.amount !== null)
    .map(row => [row.employee_id, {
      amount: row.amount,
      ktu: row.ktu,
      countedMinutes: row.counted_minutes,
      distribution: result.distribution,
    }]));
  const payouts = await previewBrigadePayouts(shares, month);

  return {
    department_id: department.id,
    month,
    kind: 'brigade',
    state: result.state,
    distribution: result.distribution,
    as_of: result.as_of,
    open_ranges: result.open_ranges,
    output_amount: result.inputs.output,
    errors: result.errors.map(error => ({ ...error, full_name: names.get(error.employee_id) ?? '' })),
    computed_at: result.computed_at,
    rows: employeeIds.map(employeeId => {
      const row = byEmployee.get(employeeId);
      return {
        employee_id: employeeId,
        ktu: ((result.inputs.ktu.get(employeeId) ?? DEFAULT_KTU_TENTHS) / 10).toFixed(1),
        counted_hours: row ? Math.round((row.counted_minutes / 60) * 100) / 100 : null,
        amount: payouts.get(employeeId)?.net ?? null,
        share: row?.amount ?? null,
        deducted: payouts.get(employeeId)?.deducted ?? null,
        missing: payouts.get(employeeId)?.missing ?? [],
        payout_state: null,
        source: row?.source ?? null,
        // КТУ правят только текущему составу (без начальника участка) и не себе.
        can_edit: members.has(employeeId) && canEdit(employeeId),
      };
    }),
  };
}
