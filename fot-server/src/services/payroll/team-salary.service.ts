/**
 * Столбец «Зарплата» в табеле руководителя (миграция 382): к выплате за прошлый месяц (начислено − удержано, без
 * НДФЛ) людей выбранного отдела — тот же расчёт ФОТ, что карточка «Зарплаты», только чтение.
 *
 * - Месяц — resolveReleasedSalaryMonth (решение пользователя 27.11.2026: всегда прошлый, с 10-го числа МСК).
 * - Расчёт — getPayoutForEmployees без предварительных сумм и с fixBrigades:false: бригада — только уже
 *   зафиксированные актуальные доли (peekFixedBrigadeShares), ни фиксации, ни аудита от учётки руководителя.
 * - Сумма — только у закрытого и полного расчёта (isFotCalcComplete, как в ЛК): частичная сумма выглядела бы
 *   окончательной. Иначе — код причины, без цифр.
 * - Расшифровка — явный DTO по белому списку полей: без условий оплаты (примечания, приказы, авторы), служебных id
 *   основ и редакций, «Часов по дням».
 */
import { query } from '../../config/postgres.js';
import type { AuthenticatedRequest } from '../../types/index.js';
import { listEmployeeMembershipsForDepartmentPeriod } from '../timesheet-department-assignments.service.js';
import type { PayrollAbsenceDays } from './payroll-basis.service.js';
import { monthBounds } from './brigade-salary-source.service.js';
import { isFotCalcComplete } from './employee-payslip.rules.js';
import { getPayoutForEmployees, type IPayrollCalcClosed, type PayrollCalc } from './payroll-calc.service.js';
import type {
  IPayrollCalcDeduction,
  IPayrollCalcLine,
  PayrollCalcLinePart,
  PayrollCalcMissing,
} from './payroll-calc.rules.js';
import type { IPayslipWorkedDays } from './payroll-payslip.rules.js';

/** Больше людей в одном отделе — 422 без расчёта (как предел calc-columns «Расчётов»). */
export const TEAM_SALARY_MAX_EMPLOYEES = 500;

export type TeamSalaryNotClosedReason = 'not_covered' | 'norm_conflict' | 'no_period' | 'brigade_open';

/** Расшифровка «Расчёт ФОТ» — ровно то, что читают PayslipCalcSection и его утилиты. */
export interface ITeamSalaryCalc {
  state: 'closed';
  period_from: string;
  period_to: string;
  norm_days: number | null;
  worked_days: IPayslipWorkedDays;
  absences: PayrollAbsenceDays;
  lines: IPayrollCalcLine[];
  deductions: IPayrollCalcDeduction[];
  accrued: string;
  deducted: string;
  net: string | null;
  missing: PayrollCalcMissing[];
}

export type TeamSalaryRow =
  | { employee_id: number; status: 'ready'; net: string; calc: ITeamSalaryCalc }
  | { employee_id: number; status: 'not_ready'; missing: PayrollCalcMissing[] }
  | { employee_id: number; status: 'not_closed'; reason: TeamSalaryNotClosedReason };

/** Копия только перечисленных ключей; Pick проверяет, что обязательные поля типа не забыты. */
const pick = <T extends object, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> => {
  const out = {} as Pick<T, K>;
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
};

/** Часть строки — поля формулы своего вида (payrollCalc.ts фронта), ничего сверх. */
export const toTeamSalaryPart = (part: PayrollCalcLinePart): PayrollCalcLinePart => {
  switch (part.kind) {
    case 'salary':
      return pick(part, ['kind', 'from', 'to', 'salary', 'bonus', 'days', 'norm', 'rounding', 'daily_rate', 'amount']);
    case 'salary_hours':
      return pick(part, ['kind', 'from', 'to', 'salary', 'bonus', 'minutes', 'norm_minutes', 'rounding', 'amount']);
    case 'hourly':
      return pick(part, ['kind', 'from', 'to', 'rate', 'minutes', 'amount']);
    case 'planned_supplement':
      return pick(part, ['kind', 'from', 'to', 'base', 'days', 'norm', 'amount']);
    case 'planned_supplement_hours':
      return pick(part, ['kind', 'from', 'to', 'base', 'minutes', 'norm_minutes', 'amount']);
    case 'overtime_days':
      return pick(part, ['kind', 'from', 'to', 'salary', 'days', 'norm', 'amount']);
    case 'overtime_hours':
      return pick(part, ['kind', 'from', 'to', 'salary', 'minutes', 'norm_minutes', 'amount']);
    case 'travel':
      return pick(part, ['kind', 'rate', 'days', 'norm', 'amount']);
    case 'housing':
      return pick(part, ['kind', 'housing', 'amount', 'rate', 'days', 'weekend_days']);
    case 'one_time':
      return pick(part, ['kind', 'amount', 'reason']);
    case 'paid_1c':
      return pick(part, ['kind', 'amount', 'replaced_one_time']);
    case 'payout_1c':
      return pick(part, ['kind', 'doc_number', 'doc_date', 'amount']);
    case 'brigade':
      return pick(part, [
        'kind', 'department_id', 'object_key', 'object_name', 'output', 'ktu_tenths', 'counted_minutes', 'weight',
        'total_weight', 'amount', 'fixed_amount', 'fixed_total', 'effective_ktu', 'conflict',
      ]);
  }
};

const toTeamSalaryLine = (line: IPayrollCalcLine): IPayrollCalcLine => {
  const out: IPayrollCalcLine = pick(line, ['code', 'amount', 'filled_dayoffs', 'hours']);
  if (line.days) out.days = pick(line.days, ['worked', 'norm']);
  if (line.brigade) out.brigade = pick(line.brigade, ['ktu', 'hours', 'fixed']);
  if (line.parts) out.parts = line.parts.map(toTeamSalaryPart);
  return out;
};

/** DTO расшифровки из закрытого расчёта: явные поля, без terms, rate_allowances, basis_ids, version_ids, quality. */
export const toTeamSalaryCalc = (calc: IPayrollCalcClosed): ITeamSalaryCalc => ({
  state: 'closed',
  period_from: calc.period_from,
  period_to: calc.period_to,
  norm_days: calc.norm_days,
  worked_days: pick(calc.worked_days, ['workday', 'dayoff']),
  absences: pick(calc.absences, ['vacation', 'sick', 'educational_leave', 'unpaid']),
  lines: calc.lines.map(toTeamSalaryLine),
  deductions: calc.deductions.map(item => pick(item, ['kind_id', 'kind', 'amount'])),
  accrued: calc.accrued,
  deducted: calc.deducted,
  net: calc.net,
  missing: [...calc.missing],
});

/** Строка столбца: сумма — только у закрытого полного расчёта; иначе код причины без цифр. */
export const toTeamSalaryRow = (employeeId: number, calc: PayrollCalc | undefined): TeamSalaryRow => {
  if (!calc) return { employee_id: employeeId, status: 'not_closed', reason: 'no_period' };
  if (calc.state === 'not_closed') return { employee_id: employeeId, status: 'not_closed', reason: calc.reason };
  if (calc.net === null || !isFotCalcComplete(calc)) {
    return { employee_id: employeeId, status: 'not_ready', missing: [...calc.missing] };
  }
  return { employee_id: employeeId, status: 'ready', net: calc.net, calc: toTeamSalaryCalc(calc) };
};

/** Отдел с подотделами (get_descendant_department_ids включает сам отдел). */
const loadSubtreeIds = async (departmentId: string): Promise<string[]> => {
  const rows = await query<{ id: string }>(
    'SELECT id FROM public.get_descendant_department_ids(ARRAY[$1::uuid])',
    [departmentId],
  );
  return rows.map(row => row.id);
};

/**
 * Состав табеля подставляет текущий отдел (employees.org_department_id), когда в истории назначений разрыв, а перевод
 * после месяца отсекает только при смежных датах (timesheet-department-assignments.service). Для денег история за
 * расчётный месяц главнее: человек остаётся, если за месяц
 *   (а) есть назначение в поддерево отдела, или
 *   (б) есть неотменённое увольнение из поддерева с датой в месяце, или
 *   (в) нет ни одного назначения (живёт только на текущем отделе).
 * Вся история за месяц в других отделах — строки нет: октябрьская сумма не уйдёт новому руководителю.
 */
export const filterSalaryMonthMembers = async (
  employeeIds: readonly number[],
  subtreeIds: readonly string[],
  month: string,
): Promise<number[]> => {
  if (employeeIds.length === 0) return [];
  const { start, end } = monthBounds(month);
  const [assignments, dismissals] = await Promise.all([
    query<{ employee_id: number | string; org_department_id: string | null }>(
      `SELECT employee_id, org_department_id
         FROM employee_assignments
        WHERE employee_id = ANY($1::int[])
          AND effective_from <= $3::date
          AND (effective_to IS NULL OR effective_to >= $2::date)`,
      [[...employeeIds], start, end],
    ),
    query<{ employee_id: number | string }>(
      `SELECT DISTINCT employee_id
         FROM employee_dismissal_events
        WHERE employee_id = ANY($1::int[])
          AND from_department_id = ANY($2::uuid[])
          AND cancelled = false
          AND dismissal_date BETWEEN $3::date AND $4::date`,
      [[...employeeIds], [...subtreeIds], start, end],
    ),
  ]);
  const subtree = new Set(subtreeIds);
  const withHistory = new Set<number>();
  const inSubtree = new Set<number>();
  for (const row of assignments) {
    const id = Number(row.employee_id);
    withHistory.add(id);
    if (row.org_department_id && subtree.has(row.org_department_id)) inSubtree.add(id);
  }
  const dismissedHere = new Set(dismissals.map(row => Number(row.employee_id)));
  return employeeIds.filter(id => inSubtree.has(id) || dismissedHere.has(id) || !withHistory.has(id));
};

/**
 * Люди отдела за месяц, по которым считается столбец: состав как у сетки (уволенный в месяце увольнения виден —
 * firedInDismissalMonth, сетка шлёт show_fired) и фильтр по истории назначений за месяц.
 */
export const loadTeamSalaryMembers = async (departmentId: string, month: string): Promise<number[]> => {
  const { start, end } = monthBounds(month);
  const [memberships, subtreeIds] = await Promise.all([
    listEmployeeMembershipsForDepartmentPeriod(departmentId, start, end, undefined, { firedInDismissalMonth: true }),
    loadSubtreeIds(departmentId),
  ]);
  const ids = [...new Set(memberships.map(row => Number(row.employee_id)))].sort((a, b) => a - b);
  return filterSalaryMonthMembers(ids, subtreeIds, month);
};

/** Строки столбца за месяц: только чтение (fixBrigades:false), без «Часов по дням». */
export const calcTeamSalaryRows = async (
  employeeIds: readonly number[],
  month: string,
  req: AuthenticatedRequest,
): Promise<TeamSalaryRow[]> => {
  if (employeeIds.length === 0) return [];
  const calcs = await getPayoutForEmployees(employeeIds, month, req, undefined, { fixBrigades: false });
  return employeeIds.map(id => toTeamSalaryRow(id, calcs.get(id)));
};
