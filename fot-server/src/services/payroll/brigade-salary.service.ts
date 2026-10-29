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
 *
 * Выработка — по объектам (миграция 336): доля сотрудника = Σ долей на объектах. Зафиксированный результат
 * хранит и дни по объектам, и имена объектов: закрытый месяц показывается целиком из него, поздние проходы СКУД
 * дни и формулу не меняют. Результат format 1 (до 336) не показывается и пересчитывается.
 */
import type { PoolClient } from 'pg';

import type { DbExecutor } from '../../config/postgres.js';
import { query, withTransaction } from '../../config/postgres.js';
import { listBrigadeSupervisorEmployeeIdsForDepartments } from '../../controllers/timesheet-assigned-export.controller.js';
import type { AuthenticatedRequest } from '../../types/index.js';
import { moscowTodayIso } from '../../utils/date.utils.js';
import { auditService } from '../audit.service.js';
import { loadCalendarMonth, resolveSchedulesForPeriod } from '../schedule.service.js';
import type { IDepartmentEmployeeMembership } from '../timesheet-department-assignments.service.js';
import { CURRENT_ACTIVITY_ADDRESS } from '../timesheet-export-mode.service.js';
import { UNKNOWN_OBJECT_NAME } from '../timesheet-object.service.js';
import {
  BRIGADE_UNKNOWN_OBJECT_KEY,
  buildBrigadeObjectDistribution,
  centsToMoney,
  countMemberMinutes,
  moneyToCents,
  type BrigadeDistributionState,
  type BrigadeObjectState,
  type IBrigadeDayValue,
  type IBrigadeSalaryError,
  type IMemberMinutes,
} from './brigade-salary.calc.js';
import {
  brigadeSalaryInputsHash,
  DEFAULT_KTU_TENTHS,
  loadBrigadeSalaryInputs,
  totalBrigadeOutput,
  type IBrigadeSalaryInputs,
} from './brigade-salary-inputs.service.js';
import {
  attachLiveObjects,
  listBrigadeMemberIds,
  loadBrigadeMonthApprovals,
  loadLiveDays,
  loadLiveObjectEntries,
  loadVersionDays,
  monthBounds,
  resolveBrigadeMonthClosure,
  type DaysByEmployee,
  type IDateRange,
} from './brigade-salary-source.service.js';

export type BrigadeSalaryState = 'preliminary' | 'fixed' | 'stale';

/** Ключ псевдо-объекта «Текущая деятельность» — как CURRENT_ACTIVITY_KEY разбивки. */
const CURRENT_ACTIVITY_OBJECT_KEY = '__current_activity__';

/** Формат сохранённого результата: 2 — по объектам (336). */
export const BRIGADE_RESULT_FORMAT = 2;

/** Часть сотрудника на одном объекте. */
export interface IBrigadeSalaryObjectPart {
  object_key: string;
  /** Часы по дням на объекте (как в разбивке) — для показа. */
  days: Record<string, number>;
  /** Учтённые минуты на объекте — по ним доля. */
  counted_minutes: number;
  /** КТУ в десятых × учтённые минуты на объекте. */
  weight: number;
  /** Доля на объекте; null — нет (не внесена, делить не по чему, ошибка). */
  amount: string | null;
}

export interface IBrigadeSalaryResultRow {
  employee_id: number;
  /** КТУ, по которому посчитана доля, — '1.5'. */
  ktu: string;
  counted_minutes: number;
  /** Итог — Σ долей по объектам; null — суммы нет. */
  amount: string | null;
  source: 'version' | 'live';
  objects: IBrigadeSalaryObjectPart[];
}

/** Объект расчёта: имя и выработка заморожены вместе с ним. */
export interface IBrigadeSalaryObjectFacts {
  object_key: string;
  object_name: string;
  /** Выработка объекта, по которой посчитаны доли; null — не внесена. */
  output: string | null;
  state: BrigadeObjectState;
  /** Σ весов объекта — точный знаменатель долей. */
  total_weight: number;
}

interface IBrigadeComputation {
  distribution: BrigadeDistributionState;
  errors: IBrigadeSalaryError[];
  rows: IBrigadeSalaryResultRow[];
  objects: IBrigadeSalaryObjectFacts[];
}

interface IStoredBrigadeResult extends IBrigadeComputation {
  output_amount: string | null;
  inputs_hash: string;
  versions: Array<{ approval_id: number; version_id: number }>;
  computed_at: string;
  format: number;
}

export interface IBrigadeSalaryComputed {
  state: BrigadeSalaryState;
  distribution: BrigadeDistributionState;
  as_of: string | null;
  open_ranges: IDateRange[];
  errors: IBrigadeSalaryError[];
  computed_at: string | null;
  rows: IBrigadeSalaryResultRow[];
  objects: IBrigadeSalaryObjectFacts[];
  inputs: IBrigadeSalaryInputs;
  member_ids: number[];
}

/** Имя объекта без снимка и разбивки: служебные ключи — по-русски, остальное — сохранённое при вводе. */
const fallbackObjectName = (key: string, inputs: IBrigadeSalaryInputs): string => {
  if (key === BRIGADE_UNKNOWN_OBJECT_KEY) return UNKNOWN_OBJECT_NAME;
  if (key === CURRENT_ACTIVITY_OBJECT_KEY) return CURRENT_ACTIVITY_ADDRESS;
  return inputs.outputs.get(key)?.object_name ?? key;
};

/** Объекты по имени; «Текущая деятельность» и «Не определён» — в конце. */
export const compareBrigadeObjects = (
  a: { object_key: string; object_name: string },
  b: { object_key: string; object_name: string },
): number => {
  const rank = (key: string): number => (key === BRIGADE_UNKNOWN_OBJECT_KEY ? 2 : key === CURRENT_ACTIVITY_OBJECT_KEY ? 1 : 0);
  return rank(a.object_key) - rank(b.object_key)
    || a.object_name.localeCompare(b.object_name, 'ru')
    || a.object_key.localeCompare(b.object_key);
};


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
  objectNames: ReadonlyMap<string, string>,
): IBrigadeComputation {
  const errors: IBrigadeSalaryError[] = [...extraErrors];
  const members = memberIds.map(employeeId => {
    const { days, source } = daysFor(employeeId);
    const counted: IMemberMinutes = countMemberMinutes(employeeId, days, schedules.get(employeeId), calendar);
    errors.push(...counted.errors);
    return {
      employee_id: employeeId,
      ktu_tenths: inputs.ktu.get(employeeId) ?? DEFAULT_KTU_TENTHS,
      counted,
      source,
    };
  });
  const outputs = new Map([...inputs.outputs].map(([key, output]) => [key, moneyToCents(output.amount)]));
  const result = buildBrigadeObjectDistribution(
    outputs,
    members.map(member => ({
      employee_id: member.employee_id,
      ktu_tenths: member.ktu_tenths,
      byObject: member.counted.byObject,
    })),
    errors,
  );

  // Объекты: с учтёнными минутами, с выработкой и с часами только для показа (минут нет — ошибка дня и т. п.).
  const keys = new Set<string>(result.objects.keys());
  for (const member of members) for (const key of member.counted.days.keys()) keys.add(key);
  const objects: IBrigadeSalaryObjectFacts[] = [...keys].map(key => {
    const computed = result.objects.get(key);
    const output = inputs.outputs.get(key)?.amount ?? null;
    return {
      object_key: key,
      object_name: objectNames.get(key) ?? fallbackObjectName(key, inputs),
      output,
      state: computed?.state ?? (output === null ? 'no_output' : 'nothing_to_distribute'),
      total_weight: computed?.total_weight ?? 0,
    };
  }).sort(compareBrigadeObjects);

  return {
    distribution: result.state,
    errors,
    objects,
    rows: members.map(member => {
      const total = result.totals.get(member.employee_id);
      const memberKeys = new Set([...member.counted.days.keys(), ...member.counted.byObject.keys()]);
      return {
        employee_id: member.employee_id,
        ktu: (member.ktu_tenths / 10).toFixed(1),
        counted_minutes: member.counted.minutes,
        amount: total === null || total === undefined ? null : centsToMoney(total),
        source: member.source,
        objects: objects.filter(object => memberKeys.has(object.object_key)).map(object => {
          const minutes = member.counted.byObject.get(object.object_key) ?? 0;
          const share = result.objects.get(object.object_key)?.amounts?.get(member.employee_id);
          return {
            object_key: object.object_key,
            days: Object.fromEntries(member.counted.days.get(object.object_key) ?? []),
            counted_minutes: minutes,
            weight: member.ktu_tenths * minutes,
            amount: share === undefined ? null : centsToMoney(share),
          };
        }),
      };
    }),
  };
}

/** Состав бригады для предварительного расчёта, загруженный заранее (контекст бригады «Расчётов»). */
export interface IBrigadeMembers {
  /** Участники делёжа — без начальников участка. */
  memberIds: number[];
  /** Членство бригады за [1-е, asOf]: окна дней в бригаде. */
  memberships: readonly IDepartmentEmployeeMembership[];
}

async function computePreliminary(
  departmentId: string,
  month: string,
  asOf: string | null,
  inputs: IBrigadeSalaryInputs,
  members?: IBrigadeMembers,
): Promise<{ computation: IBrigadeComputation; memberIds: number[] }> {
  let memberIds = members?.memberIds;
  if (!memberIds) {
    const supervisors = await supervisorIds(departmentId);
    memberIds = (await listBrigadeMemberIds(departmentId, month)).filter(id => !supervisors.has(id));
  }
  if (asOf === null || memberIds.length === 0) {
    const empty = new Map<string, IBrigadeDayValue>();
    return {
      computation: distribute(memberIds, () => ({ days: empty, source: 'live' }), new Map(), null, inputs, [], new Map()),
      memberIds,
    };
  }
  const live = await loadLiveDays(departmentId, memberIds, month, asOf, undefined, members?.memberships);
  const empty = new Map<string, IBrigadeDayValue>();
  const memberSet = new Set(memberIds);
  return {
    computation: distribute(
      memberIds,
      employeeId => ({ days: live.days.get(employeeId) ?? empty, source: 'live' }),
      live.schedules,
      live.calendar,
      inputs,
      live.errors.filter(error => memberSet.has(error.employee_id)),
      live.objectNames,
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

  // Дни редакций без снимка объектов — веса из живой разбивки (часы дня — из редакции).
  const days: DaysByEmployee = new Map(versionDays.days);
  const errors: IBrigadeSalaryError[] = [...versionDays.errors, ...(live?.errors ?? [])];
  const objectNames = new Map([...(live?.objectNames ?? []), ...versionDays.objectNames]);
  if (versionDays.withoutObjects.size > 0) {
    const unsnapshotted: DaysByEmployee = new Map();
    for (const employeeId of memberIds) {
      const byDate = versionDays.days.get(employeeId);
      if (!byDate) continue;
      const kept = new Map([...byDate].filter(([date]) => (
        versionDays.withoutObjects.has(versionDays.versionOf.get(employeeId)?.get(date) ?? -1)
      )));
      if (kept.size > 0) unsnapshotted.set(employeeId, kept);
    }
    if (unsnapshotted.size > 0) {
      const entries = await loadLiveObjectEntries([...unsnapshotted.keys()], month, end, client);
      const attached = await attachLiveObjects(unsnapshotted, entries, month, client);
      for (const [employeeId, byDate] of attached.days) {
        days.set(employeeId, new Map([...days.get(employeeId)!, ...byDate]));
      }
      errors.push(...attached.errors);
      for (const [key, name] of attached.objectNames) if (!objectNames.has(key)) objectNames.set(key, name);
    }
  }

  const schedules = await resolveSchedulesForPeriod(memberIds.map(id => ({ id })), start, end, client);
  const [year, mon] = month.split('-').map(Number);
  const calendar = await loadCalendarMonth(year, mon, client);
  const empty = new Map<string, IBrigadeDayValue>();
  const memberSet = new Set(memberIds);
  return distribute(
    memberIds,
    employeeId => {
      const fromVersion = days.get(employeeId);
      if (fromVersion) return { days: fromVersion, source: 'version' };
      return { days: live?.days.get(employeeId) ?? empty, source: 'live' };
    },
    schedules,
    calendar,
    inputs,
    // Ошибки object_config дублируются по редакциям — по одной на сотрудника.
    dedupeErrors(errors.filter(error => memberSet.has(error.employee_id))),
    objectNames,
  );
}

const dedupeErrors = (errors: readonly IBrigadeSalaryError[]): IBrigadeSalaryError[] => {
  const seen = new Set<string>();
  return errors.filter(error => {
    const key = `${error.employee_id}|${error.code}|${error.date ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

async function loadStoredResult(
  departmentId: string,
  monthStart: string,
  exec?: DbExecutor,
): Promise<IStoredBrigadeResult | null> {
  const sql = `SELECT status, output_amount::text AS output_amount, inputs_hash, versions, errors, rows, objects,
                      format, distribution, computed_at::text AS computed_at
                 FROM brigade_salary_results
                WHERE department_id = $1 AND month = $2::date`;
  const found = exec
    ? (await exec.query<Record<string, unknown>>(sql, [departmentId, monthStart])).rows
    : await query<Record<string, unknown>>(sql, [departmentId, monthStart]);
  const row = found[0];
  if (!row) return null;
  const format = Number(row.format ?? 1);
  const rows = (row.rows as IBrigadeSalaryResultRow[]).map(item => ({ ...item, objects: item.objects ?? [] }));
  const errors = row.errors as IBrigadeSalaryError[];
  const objects = (Array.isArray(row.objects) ? row.objects : []) as IBrigadeSalaryObjectFacts[];
  return {
    distribution: storedDistribution(row.status, row.distribution, rows),
    errors,
    rows,
    objects,
    output_amount: (row.output_amount as string | null) ?? null,
    inputs_hash: String(row.inputs_hash),
    versions: row.versions as Array<{ approval_id: number; version_id: number }>,
    computed_at: String(row.computed_at),
    format,
  };
}

/** Общий итог сохранённого расчёта: у format 2 — сохранённый; у format 1 — как было до 336. */
const storedDistribution = (
  status: unknown,
  distribution: unknown,
  rows: readonly IBrigadeSalaryResultRow[],
): BrigadeDistributionState => {
  if (distribution === 'ok' || distribution === 'no_output' || distribution === 'nothing_to_distribute'
    || distribution === 'error') return distribution;
  if (status === 'error') return 'error';
  return rows.some(row => row.amount !== null) ? 'ok' : 'no_output';
};

const totalOf = (rows: readonly IBrigadeSalaryResultRow[]): string | null => {
  const amounts = rows.filter(row => row.amount !== null);
  if (amounts.length === 0) return null;
  return centsToMoney(amounts.reduce((sum, row) => sum + moneyToCents(row.amount!), 0n));
};

/** Изменились ли суммы расчёта: пустой пересчёт (новый формат, тот же итог) в аудит не идёт. */
const amountsChanged = (
  previous: readonly IBrigadeSalaryResultRow[],
  next: readonly IBrigadeSalaryResultRow[],
): Array<{ employee_id: number; from: string | null; to: string | null }> => {
  const before = new Map(previous.map(row => [row.employee_id, row.amount]));
  const after = new Map(next.map(row => [row.employee_id, row.amount]));
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => a - b);
  return ids
    .filter(id => (before.get(id) ?? null) !== (after.get(id) ?? null))
    .map(id => ({ employee_id: id, from: before.get(id) ?? null, to: after.get(id) ?? null }));
};

/**
 * Фиксация закрытого месяца: при первом чтении, новой редакции, новом вводе или старом формате (до 336). null — пока
 * ждали замок, месяц открыли.
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
    if (
      previous
      && previous.format === BRIGADE_RESULT_FORMAT
      && previous.inputs_hash === inputsHash
      && sameVersions(previous.versions, closure.versions)
    ) {
      return { stored: previous, inputs };
    }

    const computation = await computeClosed(
      client, departmentId, month, closure.versions.map(item => item.version_id), inputs,
    );
    const output = totalBrigadeOutput(inputs.outputs);
    const saved = await client.query<{ computed_at: string }>(
      `INSERT INTO brigade_salary_results
         (department_id, month, status, output_amount, inputs_hash, versions, errors, rows, objects, format,
          distribution, computed_by, computed_at)
       VALUES ($1, $2::date, $3, $4::numeric, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12, now())
       ON CONFLICT (department_id, month) DO UPDATE SET
         status = EXCLUDED.status, output_amount = EXCLUDED.output_amount, inputs_hash = EXCLUDED.inputs_hash,
         versions = EXCLUDED.versions, errors = EXCLUDED.errors, rows = EXCLUDED.rows, objects = EXCLUDED.objects,
         format = EXCLUDED.format, distribution = EXCLUDED.distribution,
         computed_by = EXCLUDED.computed_by, computed_at = now()
       RETURNING computed_at::text AS computed_at`,
      [
        departmentId,
        start,
        computation.distribution === 'error' ? 'error' : 'fixed',
        output,
        inputsHash,
        JSON.stringify(closure.versions),
        JSON.stringify(computation.errors),
        JSON.stringify(computation.rows),
        JSON.stringify(computation.objects),
        BRIGADE_RESULT_FORMAT,
        computation.distribution,
        req.user.id,
      ],
    );

    // Пересчёт уже зафиксированного — «было → стало», только если поменялись суммы или редакции; первая фиксация
    // и перевод старого формата без изменений сумм в аудит не идут.
    if (previous) {
      const changed = amountsChanged(previous.rows, computation.rows);
      const versionsChanged = !sameVersions(previous.versions, closure.versions);
      if (changed.length > 0 || versionsChanged) {
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
    }

    return {
      stored: {
        ...computation,
        output_amount: output,
        inputs_hash: inputsHash,
        versions: closure.versions,
        computed_at: saved.rows[0]!.computed_at,
        format: BRIGADE_RESULT_FORMAT,
      },
      inputs,
    };
  });
}

/** Доли бригады для «К выплате (ФОТ)»: только зафиксированный расчёт закрытого месяца, иначе — open. */
export interface IBrigadeShares {
  state: 'fixed' | 'open';
  distribution: BrigadeDistributionState | null;
  /** Σ выработок, по которым посчитаны доли; null — ничего не внесено (или расчёта нет). */
  output_amount: string | null;
  rows: IBrigadeSalaryResultRow[];
  /** Объекты расчёта: имя, выработка и Σ весов — для расшифровки доли по объектам. */
  objects: IBrigadeSalaryObjectFacts[];
}

/**
 * Зафиксированные доли бригады за месяц — тот же расчёт, что во вкладке (закрытый месяц фиксируется при первом
 * чтении). Месяц открыт или открыли, пока ждали замок, — open: доли не окончательные.
 */
export async function getBrigadeShares(
  req: AuthenticatedRequest,
  departmentId: string,
  month: string,
): Promise<IBrigadeShares> {
  const closure = resolveBrigadeMonthClosure(await loadBrigadeMonthApprovals(departmentId, month), month);
  const fixed = closure.closed ? await ensureFixed(req, departmentId, month) : null;
  if (!fixed) return { state: 'open', distribution: null, output_amount: null, rows: [], objects: [] };
  return {
    state: 'fixed',
    distribution: fixed.stored.distribution,
    output_amount: fixed.stored.output_amount,
    rows: fixed.stored.rows,
    objects: fixed.stored.objects,
  };
}

/**
 * Предварительные доли открытой бригады для «Расчётов» — живой расчёт по табелю на asOf. Сохранённый результат не
 * читается и не пишется: у переоткрытого месяца прежний (stale) расчёт не берётся — незакрытый месяц считается по
 * живому табелю. Состав — из контекста бригады, членство второй раз не читается.
 */
export async function computeBrigadePreliminaryShares(
  departmentId: string,
  month: string,
  asOf: string,
  inputs: IBrigadeSalaryInputs,
  members: IBrigadeMembers,
): Promise<IBrigadeShares> {
  const { computation } = await computePreliminary(departmentId, month, asOf, inputs, members);
  return {
    state: 'open',
    distribution: computation.distribution,
    output_amount: totalBrigadeOutput(inputs.outputs),
    rows: computation.rows,
    objects: computation.objects,
  };
}

/**
 * Расчёт бригады для вкладки: закрытый месяц — зафиксированный (целиком из сохранённого), открытый — прежний
 * расчёт format 2 с пометкой или предварительный. Старый результат (format 1, без объектов) не показывается:
 * открытый месяц с ним считается предварительно.
 */
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
        objects: fixed.stored.objects,
        inputs: fixed.inputs,
        member_ids: currentMembers,
      };
    }
  }

  const inputs = await loadBrigadeSalaryInputs(departmentId, start);
  const stored = await loadStoredResult(departmentId, start);
  if (stored && stored.format === BRIGADE_RESULT_FORMAT) {
    return {
      state: 'stale',
      distribution: stored.distribution,
      as_of: null,
      open_ranges: closure.open_ranges,
      errors: stored.errors,
      computed_at: stored.computed_at,
      rows: stored.rows,
      objects: stored.objects,
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
    objects: computation.objects,
    inputs,
    member_ids: memberIds,
  };
}

/**
 * Объекты бригады за месяц, у которых можно вносить выработку: та же разбивка, что у расчёта. Закрытый месяц — из
 * зафиксированного результата (исторический ключ снимка проходит, даже если объект убрали из справочника),
 * открытый — из живого расчёта. Объект без учтённых часов и без дней сюда не попадает.
 */
export async function loadBrigadeObjectKeys(
  req: AuthenticatedRequest,
  departmentId: string,
  month: string,
): Promise<Map<string, string>> {
  const salary = await getBrigadeSalary(req, departmentId, month);
  const withHours = new Set(salary.rows.flatMap(row => row.objects
    .filter(part => part.counted_minutes > 0 || Object.keys(part.days).length > 0)
    .map(part => part.object_key)));
  return new Map(salary.objects
    .filter(object => withHours.has(object.object_key))
    .map(object => [object.object_key, object.object_name]));
}
