/**
 * Ответ вкладки «Табель → Зарплата»: столбцы КТУ и «Сумма» для сетки отдела или бригады.
 *
 * «Сумма» — к выплате у всех (решение 27.10.2026), то же число, что «К выплате (ФОТ)» в карточке «Зарплаты»:
 * начислено минус удержания, без НДФЛ. «Оклад» и «Переработка» — строки того же расчёта, только у отдела.
 * - Отдел — расчёт ФОТ по закрытому табелю (payroll-calc.service): оклад по дням, проезд, проживание, доплаты.
 *   Табель месяца сотрудника не закрыт — с опцией preliminary (новый фронт, решение 28.10.2026) предварительно по
 *   живому табелю, как «Расчёты»; без неё — суммы нет.
 * - Бригада — доля «Выработки» по КТУ (brigade-salary.service) + разовые доплаты и проживание − удержания;
 *   до закрытия — «Предварительно», как доля. Выработка — по объектам (336): objects — группы «Зарплаты по объектам»
 *   с часами по дням, весами и долями; share строки — Σ долей по объектам.
 */
import { query, queryOne } from '../../config/postgres.js';
import type { AuthenticatedRequest } from '../../types/index.js';
import {
  centsToMoney,
  fixedShareKtus,
  moneyToCents,
  type BrigadeDistributionState,
  type BrigadeObjectState,
  type BrigadeSalaryErrorCode,
} from './brigade-salary.calc.js';
import {
  BRIGADE_WHOLE_SHARE_KEY,
  brigadeOutputMode,
  DEFAULT_KTU_TENTHS,
  totalBrigadeOutput,
  type BrigadeOutputMode,
} from './brigade-salary-inputs.service.js';
import type { IDateRange } from './brigade-salary-source.service.js';
import {
  getBrigadeSalary,
  type BrigadeSalaryState,
  type IBrigadeStoredShareConflict,
} from './brigade-salary.service.js';
import { listEmployeeMembershipsForDepartmentPeriod } from '../timesheet-department-assignments.service.js';
import { monthBounds } from './brigade-salary-source.service.js';
import { brigadeShareFacts, type IBrigadeShareFact, type IPayrollCalcLine, type PayrollCalcMissing } from './payroll-calc.rules.js';
import {
  getPayoutForEmployees,
  getPreliminaryPayoutForEmployees,
  previewBrigadePayouts,
  type IPayrollCalcPreliminary,
  type PayrollCalcWithPreliminary,
} from './payroll-calc.service.js';
import { resolveBrigadeInputEditPredicate, resolvePayrollReadableDepartmentIds } from './payroll-scope.service.js';

export interface ITimesheetSalaryDepartment {
  id: string;
  name: string;
  kind: string;
}

export interface ITimesheetSalaryRow {
  employee_id: number;
  /** ФИО — только у бригады (группы по объектам рисуются без сетки табеля); у отдела null. */
  full_name: string | null;
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
  /** Отдел, табель закрыт или расчёт предварительный: «По трудовому договору» (оклад по дням); иначе null. */
  contract: IPayrollCalcLine | null;
  /** Отдел, табель закрыт или расчёт предварительный: «Переработка»; null — переработки нет или суммы нет. */
  overtime: IPayrollCalcLine | null;
  /** Чего в сумме нет: отпускные, выработка бригады и т. п. */
  missing: PayrollCalcMissing[];
  /**
   * Отдел: closed — табель месяца закрыт; preliminary — не закрыт, суммы по живому табелю на as_of ответа;
   * not_closed — суммы нет. У бригады — null (состояние у всей бригады).
   */
  payout_state: 'closed' | 'preliminary' | 'not_closed' | null;
  source: 'version' | 'live' | null;
  /** КТУ и «Доля» правятся: текущий состав бригады (без начальника участка), не себе, право записи. */
  can_edit: boolean;
  /** Сумма бригаде (341): «Доля», вписанная рублями (355); null — по формуле. У отдела и по объектам — null. */
  fixed_share: string | null;
  /** Сумма бригаде: расчётный КТУ вписанной доли ('1.59'); null — нет вписанной или сравнить не с кем. */
  effective_ktu: string | null;
  /** По объектам: у сотрудника есть вписанные доли на объектах (КТУ месяца на них не действует). */
  has_fixed_shares: boolean;
  /** Вписанную долю можно стереть (в т. ч. ушедшему из бригады): есть вписанная и право записи. */
  can_clear_share: boolean;
}

export interface ITimesheetSalaryError {
  employee_id: number;
  full_name: string;
  code: BrigadeSalaryErrorCode;
  /** null — ошибка настройки сотрудника (object_config), не дня. */
  date: string | null;
}

/** Рабочий в группе объекта. */
export interface ITimesheetSalaryObjectMember {
  employee_id: number;
  /** Часы по дням на объекте — как в разбивке табеля по объектам. */
  days: Record<string, number>;
  /** Σ часов по дням на объекте. */
  hours: number;
  /** Учтённые минуты на объекте — по ним доля. */
  counted_minutes: number;
  /** КТУ в десятых × учтённые минуты на объекте. */
  weight: number;
  /** Доля на объекте; null — нет (не внесена, конфликт, ошибка). */
  share: string | null;
  /** «Доля», вписанная рублями (355) — текущий ввод; null — по формуле. Видна и при конфликте, чтобы стереть. */
  fixed_share: string | null;
  /** Расчётный КТУ вписанной доли ('1.59'); null — не вписана, конфликт или сравнить не с кем. */
  effective_ktu: string | null;
}

/** Группа «Зарплаты по объектам»: объект бригады, его выработка и рабочие. */
export interface ITimesheetSalaryObject {
  object_key: string;
  object_name: string;
  /** Выработка объекта; null — не внесена. */
  output_amount: string | null;
  state: BrigadeObjectState;
  /** Σ часов группы — для заголовка. */
  total_hours: number;
  /** Σ весов невписанных — точный знаменатель их долей (без вписанных — Σ весов объекта). */
  total_weight: number;
  members: ITimesheetSalaryObjectMember[];
}

/** Конфликт вписанных долей (355) с ФИО сотрудника, о котором он (если есть). */
export interface ITimesheetSalaryShareConflict extends IBrigadeStoredShareConflict {
  full_name: string | null;
}

export interface ITimesheetSalaryResponse {
  department_id: string;
  month: string;
  kind: 'brigade' | 'department';
  state: BrigadeSalaryState | null;
  distribution: BrigadeDistributionState | null;
  as_of: string | null;
  open_ranges: IDateRange[];
  /** Внесённая выработка: сумма бригаде или Σ по объектам; null — ничего не внесено. */
  output_amount: string | null;
  /** Как внесена выработка сейчас (по ней — поля ввода): по объектам или одной суммой на бригаду; у отдела null. */
  output_mode: BrigadeOutputMode | null;
  /** Сумма бригаде (341); null — не внесена (или выработка по объектам). */
  brigade_output: string | null;
  errors: ITimesheetSalaryError[];
  computed_at: string | null;
  rows: ITimesheetSalaryRow[];
  /** Группы по объектам — только у бригады; у отдела []. */
  objects: ITimesheetSalaryObject[];
  /** Конфликты вписанных долей: object_key ('__brigade__' — сумма бригаде); на этих объектах долей нет. */
  share_conflicts: ITimesheetSalaryShareConflict[];
}

export async function loadSalaryDepartment(departmentId: string): Promise<ITimesheetSalaryDepartment | null> {
  return queryOne<ITimesheetSalaryDepartment>(
    `SELECT id, name, COALESCE(kind, 'department') AS kind FROM org_departments WHERE id = $1`,
    [departmentId],
  );
}

/** Объект бригады под стрелкой во «Бригадах» — без людей и денег, кроме внесённой выработки. */
export interface IBrigadeObjectOutput {
  object_key: string;
  object_name: string;
  output_amount: string | null;
  /** Σ часов как на экране: сумма дневных часов, округлённых до целых. */
  hours: number;
  /** На объекте нет часов бригады: внесённую выработку можно только стереть. */
  clear_only: boolean;
}

export interface IBrigadeObjectOutputs {
  department_id: string;
  month: string;
  output_mode: BrigadeOutputMode;
  objects: IBrigadeObjectOutput[];
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

export interface ITimesheetSalaryOptions {
  /** Незакрытый месяц отдела — предварительно по живому табелю (getPreliminaryPayoutForEmployees). */
  preliminary?: boolean;
}

export async function getTimesheetSalary(
  req: AuthenticatedRequest,
  department: ITimesheetSalaryDepartment,
  month: string,
  options: ITimesheetSalaryOptions = {},
): Promise<ITimesheetSalaryResponse> {
  if (department.kind !== 'brigade') {
    const { start, end } = monthBounds(month);
    const memberIds = [...new Set(
      (await listEmployeeMembershipsForDepartmentPeriod(department.id, start, end)).map(row => Number(row.employee_id)),
    )].sort((a, b) => a - b);
    const calcs: Map<number, PayrollCalcWithPreliminary> = options.preliminary
      ? await getPreliminaryPayoutForEmployees(memberIds, month, req)
      : await getPayoutForEmployees(memberIds, month, req);
    // as_of у всех предварительных один (зависит только от месяца).
    const asOf = [...calcs.values()]
      .find((calc): calc is IPayrollCalcPreliminary => calc.state === 'preliminary')?.as_of ?? null;
    return {
      department_id: department.id,
      month,
      kind: 'department',
      state: null,
      distribution: null,
      as_of: asOf,
      open_ranges: [],
      output_amount: null,
      output_mode: null,
      brigade_output: null,
      errors: [],
      computed_at: null,
      objects: [],
      share_conflicts: [],
      rows: memberIds.map(employeeId => {
        const calc = calcs.get(employeeId);
        const counted = calc && calc.state !== 'not_closed' ? calc : null;
        return {
          employee_id: employeeId,
          full_name: null,
          ktu: null,
          counted_hours: null,
          amount: counted?.net ?? null,
          share: null,
          deducted: counted?.deducted ?? null,
          contract: counted?.lines.find(line => line.code === 'contract') ?? null,
          overtime: counted?.lines.find(line => line.code === 'overtime') ?? null,
          missing: counted?.missing ?? [],
          payout_state: counted?.state ?? 'not_closed',
          source: null,
          can_edit: false,
          fixed_share: null,
          effective_ktu: null,
          has_fixed_shares: false,
          can_clear_share: false,
        };
      }),
    };
  }

  const result = await getBrigadeSalary(req, department.id, month);
  const canEdit = await resolveBrigadeInputEditPredicate(req);
  const members = new Set(result.member_ids);
  const byEmployee = new Map(result.rows.map(row => [row.employee_id, row]));
  // Вписанные доли — текущий ввод (у stale расчёт старый, а поле должно показать то, что вписали). Только своего режима.
  const mode = brigadeOutputMode(result.inputs);
  const fixedInput = new Map([...(result.inputs.fixedShares ?? [])]
    .filter(([key]) => (mode === 'brigade') === (key === BRIGADE_WHOLE_SHARE_KEY)));
  const fixedOf = (key: string, employeeId: number): string | null => {
    const amount = fixedInput.get(key)?.get(employeeId);
    return amount === undefined ? null : centsToMoney(moneyToCents(amount));
  };
  const withFixed = new Set([...fixedInput.values()].flatMap(byEmployee => [...byEmployee.keys()]));
  const ktus = fixedShareKtus(
    result.mode === 'brigade' ? result.output_amount : undefined, result.rows, result.objects,
  );
  const employeeIds = [...new Set([...result.member_ids, ...byEmployee.keys(), ...withFixed])].sort((a, b) => a - b);
  const names = await namesOf([...new Set([
    ...employeeIds,
    ...result.errors.map(error => error.employee_id),
    ...result.share_conflicts.flatMap(conflict => (conflict.employee_id === undefined ? [] : [conflict.employee_id])),
  ])]);
  // «Сумма» — к выплате из доли: доли нет (выработка не внесена, ошибка) — суммы нет.
  const shares = new Map<number, IBrigadeShareFact>([...brigadeShareFacts(
    department.id, result.distribution, result.rows, result.objects,
    result.mode === 'brigade' ? result.output_amount : undefined,
    result.share_conflicts,
  )].filter(([, fact]) => fact.amount !== null));
  const payouts = await previewBrigadePayouts(shares, month);

  const objects: ITimesheetSalaryObject[] = result.objects.map(object => {
    const objectMembers: ITimesheetSalaryObjectMember[] = result.rows.flatMap(row => {
      const part = row.objects.find(item => item.object_key === object.object_key);
      if (!part) return [];
      const hours = Object.values(part.days).reduce((sum, value) => sum + value, 0);
      return [{
        employee_id: row.employee_id,
        days: part.days,
        hours: Math.round(hours * 100) / 100,
        counted_minutes: part.counted_minutes,
        weight: part.weight,
        share: part.amount,
        fixed_share: fixedOf(object.object_key, row.employee_id),
        effective_ktu: ktus.get(object.object_key)?.get(row.employee_id) ?? null,
      }];
    });
    // Вписанная доля того, у кого на объекте нет часов (или кто ушёл из бригады), — строкой без часов: видна и стирается.
    const listed = new Set(objectMembers.map(member => member.employee_id));
    for (const [employeeId] of fixedInput.get(object.object_key) ?? []) {
      if (listed.has(employeeId)) continue;
      objectMembers.push({
        employee_id: employeeId,
        days: {},
        hours: 0,
        counted_minutes: 0,
        weight: 0,
        share: null,
        fixed_share: fixedOf(object.object_key, employeeId),
        effective_ktu: null,
      });
    }
    return {
      object_key: object.object_key,
      object_name: object.object_name,
      output_amount: object.output,
      state: object.state,
      total_hours: Math.round(objectMembers.reduce((sum, member) => sum + member.hours, 0) * 100) / 100,
      total_weight: object.total_weight,
      members: objectMembers,
    };
  });

  return {
    department_id: department.id,
    month,
    kind: 'brigade',
    state: result.state,
    distribution: result.distribution,
    as_of: result.as_of,
    open_ranges: result.open_ranges,
    output_amount: totalBrigadeOutput(result.inputs),
    output_mode: brigadeOutputMode(result.inputs),
    brigade_output: result.inputs.brigadeOutput,
    errors: result.errors.map(error => ({ ...error, full_name: names.get(error.employee_id) ?? '' })),
    computed_at: result.computed_at,
    objects,
    share_conflicts: result.share_conflicts.map(conflict => ({
      ...conflict,
      full_name: conflict.employee_id === undefined ? null : names.get(conflict.employee_id) ?? null,
    })),
    rows: employeeIds.map(employeeId => {
      const row = byEmployee.get(employeeId);
      return {
        employee_id: employeeId,
        full_name: names.get(employeeId) ?? null,
        ktu: ((result.inputs.ktu.get(employeeId) ?? DEFAULT_KTU_TENTHS) / 10).toFixed(1),
        counted_hours: row ? Math.round((row.counted_minutes / 60) * 100) / 100 : null,
        amount: payouts.get(employeeId)?.net ?? null,
        share: row?.amount ?? null,
        deducted: payouts.get(employeeId)?.deducted ?? null,
        contract: null,
        overtime: null,
        missing: payouts.get(employeeId)?.missing ?? [],
        payout_state: null,
        source: row?.source ?? null,
        // КТУ и «Долю» правят только текущему составу (без начальника участка) и не себе.
        can_edit: members.has(employeeId) && canEdit(employeeId),
        fixed_share: mode === 'brigade' ? fixedOf(BRIGADE_WHOLE_SHARE_KEY, employeeId) : null,
        effective_ktu: result.mode === 'brigade'
          ? ktus.get(BRIGADE_WHOLE_SHARE_KEY)?.get(employeeId) ?? null
          : null,
        has_fixed_shares: mode === 'objects' && [...fixedInput.values()].some(byEmployee => byEmployee.has(employeeId)),
        can_clear_share: withFixed.has(employeeId) && canEdit(employeeId),
      };
    }),
  };
}

/**
 * Стрелка во «Бригадах»: объекты бригады за месяц, часы и внесённая выработка. Ни ФИО, ни КТУ, ни долей, ни сумм:
 * маршрут открыт на все бригады, а полный расчёт — только на читаемые в табеле.
 */
export async function getBrigadeObjectOutputs(
  req: AuthenticatedRequest,
  department: ITimesheetSalaryDepartment,
  month: string,
): Promise<IBrigadeObjectOutputs> {
  const result = await getBrigadeSalary(req, department.id, month);
  return {
    department_id: department.id,
    month,
    output_mode: brigadeOutputMode(result.inputs),
    objects: result.objects.map(object => {
      const parts = result.rows.flatMap(row => row.objects.filter(part => part.object_key === object.object_key));
      return {
        object_key: object.object_key,
        object_name: object.object_name,
        output_amount: object.output,
        hours: parts.reduce(
          (sum, part) => sum + Object.values(part.days).reduce((daySum, value) => daySum + Math.round(value), 0),
          0,
        ),
        clear_only: parts.length === 0 && object.output !== null,
      };
    }),
  };
}
