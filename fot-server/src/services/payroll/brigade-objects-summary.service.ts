/**
 * «Табель → Бригады → Объекты»: объекты месяца по всем бригадам — бригады и их люди на каждом, учтённые часы, выработка и
 * стоимость часа.
 *
 * Стоимость часа объекта — Σ выработки бригад, внёсших её на этот объект, ÷ их учтённые минуты (решение 24.11): пара
 * «бригада × объект» входит, когда «Зарплата по объектам» показала бы у неё «Среднюю» (объект ok, расчёт бригады без
 * ошибки, учтённые минуты есть). Сумма бригаде (341) не входит — суммы по объектам у неё нет. Остальные пары видны с
 * часами, внесённой суммой и причиной.
 *
 * Только чтение, как «Расчёты»: актуальный снимок закрытого месяца — из пакета (peekBrigadeSharesMany), закрытый без
 * снимка — тот же расчёт без записи (previewClosedBrigadeShares), открытый — живой табель на вчера
 * (computeBrigadePreliminaryShares; прежний расчёт переоткрытого месяца не берётся). Тяжёлые расчёты — в общем слоте
 * бригад. Отказ одной бригады не роняет сводку: она уходит в failed_brigades.
 *
 * Люди бригады (ФИО, часы) — только там, где пользователю открыт её полный расчёт (canReadPeople — то же правило, что у
 * GET /timesheet-salary). У скрытой — только итоги пары: число людей, часы, выработка.
 */
import { query } from '../../config/postgres.js';
import {
  BRIGADE_UNKNOWN_OBJECT_KEY,
  centsToMoney,
  moneyToCents,
  type BrigadeDistributionState,
  type BrigadeObjectState,
} from './brigade-salary.calc.js';
import { loadBrigadeSalaryInputs, type BrigadeOutputMode } from './brigade-salary-inputs.service.js';
import { monthBounds } from './brigade-salary-source.service.js';
import {
  compareBrigadeObjects,
  computeBrigadePreliminaryShares,
  peekBrigadeSharesMany,
  previewClosedBrigadeShares,
  resolvePreliminaryAsOf,
  type IBrigadeSalaryObjectFacts,
  type IBrigadeSalaryResultRow,
  type IBrigadeShares,
} from './brigade-salary.service.js';
import { withBrigadeSlot } from './payroll-calc-brigades.service.js';
import { loadBrigadeContexts, type IBrigadeContext } from './payroll-calc-preliminary.service.js';
import { namesOf } from './timesheet-salary.service.js';

/** Расчёт бригады, по которому собрана сводка: закрытый месяц (снимок или тот же расчёт без записи) или живой табель. */
export type BrigadeSummaryState = 'fixed' | 'preliminary';

/** Почему пара «бригада × объект» не вошла в стоимость часа. */
export type BrigadeObjectExclusion = 'no_output' | 'by_brigade' | 'nothing_to_distribute' | 'share_conflict' | 'error';

export interface IBrigadeObjectsSummaryMember {
  employee_id: number;
  full_name: string;
  /** Часы на объекте — Σ дневных, округлённых до целых (как под стрелкой «Бригад»). */
  hours: number;
  /** Учтённые минуты на объекте — по ним стоимость часа. */
  counted_minutes: number;
}

export interface IBrigadeObjectsSummaryBrigade {
  department_id: string;
  name: string;
  state: BrigadeSummaryState;
  /** Выработка бригады на объекте — NUMERIC(12,2) строкой; null — не внесена (или внесена суммой бригаде). */
  output_amount: string | null;
  /** Вошла в стоимость часа объекта. */
  in_rate: boolean;
  /** Почему не вошла; null — вошла. */
  exclusion: BrigadeObjectExclusion | null;
  people: number;
  hours: number;
  counted_minutes: number;
  /** Люди на объекте по ФИО; null — состав скрыт (полный расчёт бригады пользователю не открыт). */
  members: IBrigadeObjectsSummaryMember[] | null;
}

export interface IBrigadeObjectsSummaryObject {
  object_key: string;
  object_name: string;
  /** Вся выработка, внесённая бригадами на объект; null — не внесена ни одной. */
  output_total: string | null;
  /** Числитель стоимости часа — выработка вошедших пар; null — ни одна не вошла. */
  output_in_rate: string | null;
  /** Знаменатель стоимости часа — учтённые минуты вошедших пар. */
  rated_minutes: number;
  /** Учтённые минуты всех бригад на объекте. */
  counted_minutes: number;
  hours: number;
  /** Разные люди на объекте: переведённый в месяце из бригады в бригаду — один. */
  people: number;
  brigades_in_rate: number;
  brigades: IBrigadeObjectsSummaryBrigade[];
}

export interface IBrigadeObjectsSummaryFailure {
  department_id: string;
  name: string;
}

export interface IBrigadeObjectsSummary {
  month: string;
  objects: IBrigadeObjectsSummaryObject[];
  /** Бригады, которые не удалось посчитать: на объектах их нет. */
  failed_brigades: IBrigadeObjectsSummaryFailure[];
}

/** Бригада на входе сведения: её расчёт и видны ли её люди. */
export interface IBrigadeSummaryInput {
  department_id: string;
  name: string;
  state: BrigadeSummaryState;
  mode: BrigadeOutputMode;
  distribution: BrigadeDistributionState | null;
  rows: readonly IBrigadeSalaryResultRow[];
  objects: readonly IBrigadeSalaryObjectFacts[];
  visible: boolean;
}

interface IPairPart {
  minutes: number;
  hours: number;
  members: Map<number, { hours: number; minutes: number }>;
}

const roundedHours = (days: Readonly<Record<string, number>>): number => (
  Object.values(days).reduce((sum, value) => sum + Math.round(value), 0)
);

/** Части бригады по объектам: минуты, часы и люди. */
const partsByObject = (rows: readonly IBrigadeSalaryResultRow[]): Map<string, IPairPart> => {
  const result = new Map<string, IPairPart>();
  for (const row of rows) {
    for (const part of row.objects) {
      const hours = roundedHours(part.days);
      const entry = result.get(part.object_key) ?? { minutes: 0, hours: 0, members: new Map() };
      entry.minutes += part.counted_minutes;
      entry.hours += hours;
      const member = entry.members.get(row.employee_id) ?? { hours: 0, minutes: 0 };
      member.hours += hours;
      member.minutes += part.counted_minutes;
      entry.members.set(row.employee_id, member);
      result.set(part.object_key, entry);
    }
  }
  return result;
};

const exclusionOf = (
  distribution: BrigadeDistributionState | null,
  state: BrigadeObjectState,
  output: string | null,
  minutes: number,
): BrigadeObjectExclusion | null => {
  if (distribution === 'error') return 'error';
  if (state === 'ok') return output !== null && minutes > 0 ? null : 'nothing_to_distribute';
  return state;
};

const compareNames = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name, 'ru');

/**
 * Сведение бригад по объектам — вся математика сводки. objectNames — имена объектов из справочника (uuid → имя); нет —
 * имя из расчёта бригады. Деньги — в копейках, одна сумма на пару.
 */
export const aggregateBrigadeObjects = (
  inputs: readonly IBrigadeSummaryInput[],
  names: ReadonlyMap<number, string>,
  objectNames: ReadonlyMap<string, string>,
): IBrigadeObjectsSummaryObject[] => {
  const objects = new Map<string, {
    name: string;
    brigades: IBrigadeObjectsSummaryBrigade[];
    people: Set<number>;
  }>();
  for (const input of [...inputs].sort(compareNames)) {
    const parts = partsByObject(input.rows);
    const facts = new Map(input.objects.map(fact => [fact.object_key, fact]));
    for (const key of new Set([...facts.keys(), ...parts.keys()])) {
      const fact = facts.get(key);
      const part = parts.get(key) ?? { minutes: 0, hours: 0, members: new Map() };
      const output = input.mode === 'objects' ? fact?.output ?? null : null;
      if (part.members.size === 0 && output === null) continue;
      const state: BrigadeObjectState = fact?.state ?? (input.mode === 'brigade' ? 'by_brigade' : 'no_output');
      const exclusion = exclusionOf(input.distribution, state, output, part.minutes);
      const members = input.visible
        ? [...part.members].map(([employeeId, member]) => ({
          employee_id: employeeId,
          full_name: names.get(employeeId) ?? '',
          hours: member.hours,
          counted_minutes: member.minutes,
        })).sort((a, b) => a.full_name.localeCompare(b.full_name, 'ru') || a.employee_id - b.employee_id)
        : null;
      const entry = objects.get(key) ?? {
        name: objectNames.get(key) ?? fact?.object_name ?? key,
        brigades: [],
        people: new Set<number>(),
      };
      for (const employeeId of part.members.keys()) entry.people.add(employeeId);
      entry.brigades.push({
        department_id: input.department_id,
        name: input.name,
        state: input.state,
        output_amount: output === null ? null : centsToMoney(moneyToCents(output)),
        in_rate: exclusion === null,
        exclusion,
        people: part.members.size,
        hours: part.hours,
        counted_minutes: part.minutes,
        members,
      });
      objects.set(key, entry);
    }
  }

  return [...objects].map(([key, entry]) => {
    const entered = entry.brigades.filter(brigade => brigade.output_amount !== null);
    const rated = entry.brigades.filter(brigade => brigade.in_rate);
    const cents = (list: readonly IBrigadeObjectsSummaryBrigade[]): string | null => (
      list.length === 0
        ? null
        : centsToMoney(list.reduce((sum, brigade) => sum + moneyToCents(brigade.output_amount!), 0n))
    );
    return {
      object_key: key,
      object_name: entry.name,
      output_total: cents(entered),
      output_in_rate: cents(rated),
      rated_minutes: rated.reduce((sum, brigade) => sum + brigade.counted_minutes, 0),
      counted_minutes: entry.brigades.reduce((sum, brigade) => sum + brigade.counted_minutes, 0),
      hours: entry.brigades.reduce((sum, brigade) => sum + brigade.hours, 0),
      people: entry.people.size,
      brigades_in_rate: rated.length,
      brigades: entry.brigades,
    };
  }).sort((a, b) => compareBrigadeObjects(a, b));
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Имена объектов из справочника СКУД — и неактивных: в снимке и вводе ключ тот же, имя — нынешнее. */
const loadObjectNames = async (keys: readonly string[]): Promise<Map<string, string>> => {
  const ids = keys.filter(key => key !== BRIGADE_UNKNOWN_OBJECT_KEY && UUID_RE.test(key));
  if (ids.length === 0) return new Map();
  const rows = await query<{ id: string; name: string | null }>(
    'SELECT id::text AS id, name FROM skud_objects WHERE id = ANY($1::uuid[])',
    [ids],
  );
  return new Map(rows.flatMap(row => {
    const name = String(row.name ?? '').trim();
    return name ? [[row.id, name] as [string, string]] : [];
  }));
};

type SummaryShares = Pick<IBrigadeShares, 'mode' | 'distribution' | 'rows' | 'objects'>;

type BrigadeCalc = { ok: true; state: BrigadeSummaryState; shares: SummaryShares } | { ok: false };

/** Открытый месяц, по которому ещё нечего считать (будущий) или бригада без состава: часов нет. */
const EMPTY_SHARES: SummaryShares = { mode: 'objects', distribution: null, rows: [], objects: [] };

/**
 * Сводка месяца. brigades — список вкладки «Бригады» (listBrigadeOutputs), canReadPeople — открыт ли пользователю полный
 * расчёт бригады (охват уже прочитан вызывающим один раз).
 */
export async function getBrigadeObjectsSummary(
  month: string,
  brigades: ReadonlyArray<{ department_id: string; name: string }>,
  canReadPeople: (departmentId: string) => Promise<boolean>,
): Promise<IBrigadeObjectsSummary> {
  const ids = brigades.map(brigade => brigade.department_id);
  const { start } = monthBounds(month);
  const peeked = await peekBrigadeSharesMany(ids, month);

  const failed = (departmentId: string, err: unknown): BrigadeCalc => {
    console.error(`brigadeObjectsSummary: бригада ${departmentId}, ${month}:`, err);
    return { ok: false };
  };

  // Закрытые: снимок из пакета; без актуального снимка — тот же расчёт без записи. null — месяц уже открыли.
  const closed = await Promise.all(ids.map(async (departmentId): Promise<BrigadeCalc | null> => {
    const peek = peeked.get(departmentId)!;
    if (peek.state === 'fixed') return { ok: true, state: 'fixed', shares: peek.shares };
    if (peek.state === 'open') return null;
    try {
      const shares = await withBrigadeSlot(() => previewClosedBrigadeShares(departmentId, month));
      return shares ? { ok: true, state: 'fixed', shares } : null;
    } catch (err) {
      return failed(departmentId, err);
    }
  }));

  // Открытые: живой табель на вчера (прошлый месяц — целиком), состав — одним пакетом на все.
  const asOf = resolvePreliminaryAsOf(month);
  const openIds = ids.filter((_, index) => closed[index] === null);
  const contexts = asOf && openIds.length > 0
    ? await loadBrigadeContexts(openIds, start, asOf)
    : new Map<string, IBrigadeContext>();
  const calcs = await Promise.all(ids.map(async (departmentId, index): Promise<BrigadeCalc> => {
    const done = closed[index];
    if (done) return done;
    const context = contexts.get(departmentId);
    if (!asOf || !context) return { ok: true, state: 'preliminary', shares: EMPTY_SHARES };
    try {
      const peek = peeked.get(departmentId)!;
      const inputs = peek.state === 'open' ? peek.inputs : await loadBrigadeSalaryInputs(departmentId, start);
      const shares = await withBrigadeSlot(() => (
        computeBrigadePreliminaryShares(departmentId, month, asOf, inputs, context)
      ));
      return { ok: true, state: 'preliminary', shares };
    } catch (err) {
      return failed(departmentId, err);
    }
  }));

  const visible = new Set<string>();
  for (const departmentId of ids) if (await canReadPeople(departmentId)) visible.add(departmentId);

  const inputs: IBrigadeSummaryInput[] = [];
  const failures: IBrigadeObjectsSummaryFailure[] = [];
  brigades.forEach((brigade, index) => {
    const calc = calcs[index];
    if (!calc.ok) {
      failures.push({ department_id: brigade.department_id, name: brigade.name });
      return;
    }
    inputs.push({
      department_id: brigade.department_id,
      name: brigade.name,
      state: calc.state,
      mode: calc.shares.mode,
      distribution: calc.shares.distribution,
      rows: calc.shares.rows,
      objects: calc.shares.objects,
      visible: visible.has(brigade.department_id),
    });
  });

  const memberIds = [...new Set(inputs
    .filter(input => input.visible)
    .flatMap(input => input.rows.filter(row => row.objects.length > 0).map(row => row.employee_id)))];
  const names = await namesOf(memberIds);
  const objectNames = await loadObjectNames([...new Set(inputs.flatMap(input => [
    ...input.objects.map(object => object.object_key),
    ...input.rows.flatMap(row => row.objects.map(part => part.object_key)),
  ]))]);

  return {
    month,
    objects: aggregateBrigadeObjects(inputs, names, objectNames),
    failed_brigades: failures.sort(compareNames),
  };
}
