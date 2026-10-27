/**
 * «Табель → Зарплата» для бригады: доли «Выработки» по КТУ × учтённые часы.
 *
 * Состояния:
 *  - preliminary — месяц не закрыт: считаем по живому табелю (текущий месяц — по вчерашний день МСК),
 *    ничего не сохраняем;
 *  - fixed — все дни месяца в утверждённых закрытых подачах: результат считается по их редакциям и
 *    сохраняется в brigade_salary_results. Пересчёт — только при новой редакции или новых
 *    выработке/КТУ; правка графика задним числом сумму не меняет;
 *  - stale — результат был, но подачу открыли: показываем прежние суммы с пометкой.
 *
 * Фиксация — при чтении, под advisory-lock на (бригада, месяц): закрытие табеля этот расчёт не
 * вызывает, поэтому ошибка зарплаты не мешает закрыть табель и отдать его в 1С.
 */
import type { PoolClient } from 'pg';

import type { DbExecutor } from '../../config/postgres.js';
import { query, withTransaction } from '../../config/postgres.js';
import { listBrigadeSupervisorEmployeeIdsForDepartments } from '../../controllers/timesheet-assigned-export.controller.js';
import type { AuthenticatedRequest } from '../../types/index.js';
import { moscowTodayIso } from '../../utils/date.utils.js';
import { auditService } from '../audit.service.js';
import { loadCalendarMonth, resolveSchedulesForPeriod } from '../schedule.service.js';
import {
  buildBrigadeDistribution,
  centsToMoney,
  countMemberMinutes,
  moneyToCents,
  type BrigadeDistributionState,
  type IBrigadeDayValue,
  type IBrigadeSalaryError,
} from './brigade-salary.calc.js';
import {
  brigadeSalaryInputsHash,
  DEFAULT_KTU_TENTHS,
  loadBrigadeSalaryInputs,
  type IBrigadeSalaryInputs,
} from './brigade-salary-inputs.service.js';
import {
  listBrigadeMemberIds,
  loadBrigadeMonthApprovals,
  loadLiveDays,
  loadVersionDays,
  monthBounds,
  resolveBrigadeMonthClosure,
  type IDateRange,
} from './brigade-salary-source.service.js';

export type BrigadeSalaryState = 'preliminary' | 'fixed' | 'stale';

export interface IBrigadeSalaryResultRow {
  employee_id: number;
  /** КТУ, по которому посчитана доля, — '1.5'. */
  ktu: string;
  counted_minutes: number;
  amount: string | null;
  source: 'version' | 'live';
}

interface IBrigadeComputation {
  distribution: BrigadeDistributionState;
  errors: IBrigadeSalaryError[];
  rows: IBrigadeSalaryResultRow[];
}

interface IStoredBrigadeResult extends IBrigadeComputation {
  output_amount: string | null;
  inputs_hash: string;
  versions: Array<{ approval_id: number; version_id: number }>;
  computed_at: string;
}

export interface IBrigadeSalaryComputed {
  state: BrigadeSalaryState;
  distribution: BrigadeDistributionState;
  as_of: string | null;
  open_ranges: IDateRange[];
  errors: IBrigadeSalaryError[];
  computed_at: string | null;
  rows: IBrigadeSalaryResultRow[];
  inputs: IBrigadeSalaryInputs;
  member_ids: number[];
}

const shiftIso = (iso: string, days: number): string => {
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
};

/** По какой день считается «Предварительно»: прошлый месяц — целиком, текущий — по вчера МСК. */
export const resolvePreliminaryAsOf = (month: string, today: string = moscowTodayIso()): string | null => {
  const { start, end } = monthBounds(month);
  if (end < today) return end;
  const yesterday = shiftIso(today, -1);
  return yesterday >= start ? yesterday : null;
};

/** По полям, а не JSON.stringify: jsonb хранит ключи в своём порядке. */
const sameVersions = (
  a: ReadonlyArray<{ approval_id: number; version_id: number }>,
  b: ReadonlyArray<{ approval_id: number; version_id: number }>,
): boolean => a.length === b.length && a.every((item, index) => (
  Number(item.approval_id) === Number(b[index].approval_id) && Number(item.version_id) === Number(b[index].version_id)
));

async function supervisorIds(departmentId: string, exec?: DbExecutor): Promise<Set<number>> {
  return listBrigadeSupervisorEmployeeIdsForDepartments([departmentId], exec);
}

/** Доли по дням сотрудников: общий шаг для «Предварительно» и для фиксации. */
function distribute(
  memberIds: readonly number[],
  daysFor: (employeeId: number) => { days: ReadonlyMap<string, IBrigadeDayValue>; source: 'version' | 'live' },
  schedules: Map<number, Map<string, import('../../types/index.js').IResolvedSchedule>>,
  calendar: import('../../types/index.js').IProductionCalendarMonth | null,
  inputs: IBrigadeSalaryInputs,
  extraErrors: IBrigadeSalaryError[],
): IBrigadeComputation {
  const errors: IBrigadeSalaryError[] = [...extraErrors];
  const members = memberIds.map(employeeId => {
    const { days, source } = daysFor(employeeId);
    const counted = countMemberMinutes(employeeId, days, schedules.get(employeeId), calendar);
    errors.push(...counted.errors);
    return {
      employee_id: employeeId,
      ktu_tenths: inputs.ktu.get(employeeId) ?? DEFAULT_KTU_TENTHS,
      minutes: counted.minutes,
      source,
    };
  });
  const { state, amounts } = buildBrigadeDistribution(
    inputs.output === null ? null : moneyToCents(inputs.output),
    members,
    errors,
  );
  return {
    distribution: state,
    errors,
    rows: members.map(member => ({
      employee_id: member.employee_id,
      ktu: (member.ktu_tenths / 10).toFixed(1),
      counted_minutes: member.minutes,
      amount: amounts?.has(member.employee_id) ? centsToMoney(amounts.get(member.employee_id)!) : null,
      source: member.source,
    })),
  };
}

async function computePreliminary(
  departmentId: string,
  month: string,
  asOf: string | null,
  inputs: IBrigadeSalaryInputs,
): Promise<{ computation: IBrigadeComputation; memberIds: number[] }> {
  const supervisors = await supervisorIds(departmentId);
  const memberIds = (await listBrigadeMemberIds(departmentId, month)).filter(id => !supervisors.has(id));
  if (asOf === null || memberIds.length === 0) {
    const empty = new Map<string, IBrigadeDayValue>();
    return {
      computation: distribute(memberIds, () => ({ days: empty, source: 'live' }), new Map(), null, inputs, []),
      memberIds,
    };
  }
  const live = await loadLiveDays(departmentId, memberIds, month, asOf);
  const empty = new Map<string, IBrigadeDayValue>();
  return {
    computation: distribute(
      memberIds,
      employeeId => ({ days: live.days.get(employeeId) ?? empty, source: 'live' }),
      live.schedules,
      live.calendar,
      inputs,
      [],
    ),
    memberIds,
  };
}

/**
 * Расчёт по редакциям закрытого месяца. Кого нет в редакциях (уволенный в месяце увольнения),
 * считаем по живому табелю за дни в бригаде.
 */
async function computeClosed(
  client: PoolClient,
  departmentId: string,
  month: string,
  versionIds: readonly number[],
  inputs: IBrigadeSalaryInputs,
): Promise<IBrigadeComputation> {
  const { start, end } = monthBounds(month);
  const supervisors = await supervisorIds(departmentId, client);
  const members = await listBrigadeMemberIds(departmentId, month, client);
  const versionDays = await loadVersionDays(versionIds, month, client);
  const memberIds = [...new Set([...members, ...versionDays.days.keys()])]
    .filter(id => !supervisors.has(id))
    .sort((a, b) => a - b);
  const missing = memberIds.filter(id => !versionDays.days.has(id));
  const live = missing.length > 0 ? await loadLiveDays(departmentId, missing, month, end, client) : null;
  const schedules = await resolveSchedulesForPeriod(memberIds.map(id => ({ id })), start, end, client);
  const [year, mon] = month.split('-').map(Number);
  const calendar = await loadCalendarMonth(year, mon, client);
  const empty = new Map<string, IBrigadeDayValue>();
  return distribute(
    memberIds,
    employeeId => {
      const fromVersion = versionDays.days.get(employeeId);
      if (fromVersion) return { days: fromVersion, source: 'version' };
      return { days: live?.days.get(employeeId) ?? empty, source: 'live' };
    },
    schedules,
    calendar,
    inputs,
    versionDays.errors.filter(error => !supervisors.has(error.employee_id)),
  );
}

async function loadStoredResult(
  departmentId: string,
  monthStart: string,
  exec?: DbExecutor,
): Promise<IStoredBrigadeResult | null> {
  const sql = `SELECT status, output_amount::text AS output_amount, inputs_hash, versions, errors, rows,
                      computed_at::text AS computed_at
                 FROM brigade_salary_results
                WHERE department_id = $1 AND month = $2::date`;
  const found = exec
    ? (await exec.query<Record<string, unknown>>(sql, [departmentId, monthStart])).rows
    : await query<Record<string, unknown>>(sql, [departmentId, monthStart]);
  const row = found[0];
  if (!row) return null;
  const rows = row.rows as IBrigadeSalaryResultRow[];
  const errors = row.errors as IBrigadeSalaryError[];
  return {
    distribution: (row.status === 'error' ? 'error' : (rows.some(item => item.amount !== null) ? 'ok' : 'no_output')),
    errors,
    rows,
    output_amount: (row.output_amount as string | null) ?? null,
    inputs_hash: String(row.inputs_hash),
    versions: row.versions as Array<{ approval_id: number; version_id: number }>,
    computed_at: String(row.computed_at),
  };
}

const totalOf = (rows: readonly IBrigadeSalaryResultRow[]): string | null => {
  const amounts = rows.filter(row => row.amount !== null);
  if (amounts.length === 0) return null;
  return centsToMoney(amounts.reduce((sum, row) => sum + moneyToCents(row.amount!), 0n));
};

/**
 * Фиксация закрытого месяца: при первом чтении, новой редакции или новом вводе. null — пока ждали
 * замок, месяц открыли.
 */
async function ensureFixed(
  req: AuthenticatedRequest,
  departmentId: string,
  month: string,
): Promise<{ stored: IStoredBrigadeResult; inputs: IBrigadeSalaryInputs } | null> {
  const { start } = monthBounds(month);
  return withTransaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`brigade_salary:${departmentId}:${month}`]);
    const closure = resolveBrigadeMonthClosure(await loadBrigadeMonthApprovals(departmentId, month, client), month);
    if (!closure.closed) return null;
    const inputs = await loadBrigadeSalaryInputs(departmentId, start, client);
    const inputsHash = brigadeSalaryInputsHash(inputs);
    const previous = await loadStoredResult(departmentId, start, client);
    if (previous && previous.inputs_hash === inputsHash && sameVersions(previous.versions, closure.versions)) {
      return { stored: previous, inputs };
    }

    const computation = await computeClosed(
      client, departmentId, month, closure.versions.map(item => item.version_id), inputs,
    );
    const saved = await client.query<{ computed_at: string }>(
      `INSERT INTO brigade_salary_results
         (department_id, month, status, output_amount, inputs_hash, versions, errors, rows, computed_by, computed_at)
       VALUES ($1, $2::date, $3, $4::numeric, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, now())
       ON CONFLICT (department_id, month) DO UPDATE SET
         status = EXCLUDED.status, output_amount = EXCLUDED.output_amount, inputs_hash = EXCLUDED.inputs_hash,
         versions = EXCLUDED.versions, errors = EXCLUDED.errors, rows = EXCLUDED.rows,
         computed_by = EXCLUDED.computed_by, computed_at = now()
       RETURNING computed_at::text AS computed_at`,
      [
        departmentId,
        start,
        computation.distribution === 'error' ? 'error' : 'fixed',
        inputs.output,
        inputsHash,
        JSON.stringify(closure.versions),
        JSON.stringify(computation.errors),
        JSON.stringify(computation.rows),
        req.user.id,
      ],
    );

    // Пересчёт уже зафиксированного — «было → стало»; первая фиксация в аудит не идёт.
    if (previous) {
      const before = new Map(previous.rows.map(row => [row.employee_id, row.amount]));
      const changed = computation.rows
        .filter(row => before.get(row.employee_id) !== row.amount)
        .map(row => ({ employee_id: row.employee_id, from: before.get(row.employee_id) ?? null, to: row.amount }));
      await auditService.logFromRequestWithClient(client, req, req.user.id, 'BRIGADE_SALARY_RECALCULATED', {
        entityType: 'brigade_salary_results',
        entityId: `${departmentId}:${month}`,
        details: {
          month,
          total: { from: totalOf(previous.rows), to: totalOf(computation.rows) },
          versions: { from: previous.versions, to: closure.versions },
          changed: changed.slice(0, 200),
        },
      });
    }

    return {
      stored: {
        ...computation,
        output_amount: inputs.output,
        inputs_hash: inputsHash,
        versions: closure.versions,
        computed_at: saved.rows[0]!.computed_at,
      },
      inputs,
    };
  });
}

/** Расчёт бригады для вкладки: закрытый месяц — зафиксированный, открытый — предварительный или прежний. */
export async function getBrigadeSalary(
  req: AuthenticatedRequest,
  departmentId: string,
  month: string,
): Promise<IBrigadeSalaryComputed> {
  const { start } = monthBounds(month);
  const closure = resolveBrigadeMonthClosure(await loadBrigadeMonthApprovals(departmentId, month), month);
  const supervisors = await supervisorIds(departmentId);
  const currentMembers = (await listBrigadeMemberIds(departmentId, month)).filter(id => !supervisors.has(id));

  if (closure.closed) {
    const fixed = await ensureFixed(req, departmentId, month);
    if (fixed) {
      return {
        state: 'fixed',
        distribution: fixed.stored.distribution,
        as_of: null,
        open_ranges: [],
        errors: fixed.stored.errors,
        computed_at: fixed.stored.computed_at,
        rows: fixed.stored.rows,
        inputs: fixed.inputs,
        member_ids: currentMembers,
      };
    }
  }

  const inputs = await loadBrigadeSalaryInputs(departmentId, start);
  const stored = await loadStoredResult(departmentId, start);
  if (stored) {
    return {
      state: 'stale',
      distribution: stored.distribution,
      as_of: null,
      open_ranges: closure.open_ranges,
      errors: stored.errors,
      computed_at: stored.computed_at,
      rows: stored.rows,
      inputs,
      member_ids: currentMembers,
    };
  }

  const asOf = resolvePreliminaryAsOf(month);
  const { computation, memberIds } = await computePreliminary(departmentId, month, asOf, inputs);
  return {
    state: 'preliminary',
    distribution: computation.distribution,
    as_of: asOf,
    open_ranges: closure.open_ranges,
    errors: computation.errors,
    computed_at: null,
    rows: computation.rows,
    inputs,
    member_ids: memberIds,
  };
}
