/**
 * API для ЗУП3 «сотрудники месяца» — половины месяца (1–15 и 16–конец) из снимка месяца.
 *
 * Строка половины — из дней этой половины: факт и объекты, основной объект (по часам половины, затем объект
 * табелирования, затем объект месяца), отдел (подача половины с наибольшими часами — правило «Свода»), бригада и её
 * объект по долям дней половины, норма — Σ плановых часов дней половины. Категория и объект табелирования — месяца.
 * В половине есть сотрудник, у которого в её границах есть хоть один день табеля. Половина «предварительная», пока не
 * закончилась по Москве или есть живые дни, которые ещё могут измениться. Дни — те же объекты, что в строке месяца
 * (массив ссылок): половины почти не добавляют памяти снимку.
 */
import {
  pickMainKnownObject,
  pickMonthDepartment,
  type ISummaryBreakdownRow,
} from './payroll/payroll-summary.attribution.js';
import type { IMonthBounds } from './staff-month-1c.load.js';
import {
  aggregateBrigades,
  aggregateFact,
  fromCenti,
  halfNorm,
  objectHoursList,
  pickEmployeeBrigade,
  pickMainKnownKey,
  staffMonthHalfBounds,
  STAFF_MONTH_HALVES,
  UNKNOWN_OBJECT,
  type IApiObject,
  type IBrigadeAggregate,
  type IBrigadeDayShare,
  type IDayRecord,
  type IStaffMonthHalfBounds,
  type StaffMonthHalf,
  type StaffMonthHalfObjectSource,
} from './staff-month-1c.rules.js';
import type { IStaffMonthBrigade, IStaffMonthObject, IStaffMonthRow } from './staff-month-1c.snapshot.js';

export interface IStaffMonthHalfNorm {
  hours: number | null;
  days: number | null;
  complete: boolean;
}

export interface IStaffMonthHalfRow extends Omit<IStaffMonthRow, 'norm' | 'object_source'> {
  object_source: StaffMonthHalfObjectSource;
  norm: IStaffMonthHalfNorm;
}

/** Для отбора: основной объект и факт по объектам, по employee_id. */
export type StaffMonthObjectIndex = Map<number, { mainKey: string; factByObject: Map<string, number> }>;

export interface IStaffMonthHalfView {
  bounds: IStaffMonthHalfBounds;
  rows: IStaffMonthHalfRow[];
  index: StaffMonthObjectIndex;
  brigades: IStaffMonthBrigade[];
  objects: IStaffMonthObject[];
  /** Есть предварительная строка или половина не закончилась. */
  preliminary: boolean;
}

/** Объекты периода: справочник и итоги по индексу (основной объект, факт по объектам). */
export const summarizeObjects = (index: StaffMonthObjectIndex, dict: ReadonlyMap<string, IApiObject>): IStaffMonthObject[] => {
  const stats = new Map<string, { fact: Set<number>; main: Set<number>; centi: number }>();
  const stat = (key: string) => {
    let entry = stats.get(key);
    if (!entry) {
      entry = { fact: new Set(), main: new Set(), centi: 0 };
      stats.set(key, entry);
    }
    return entry;
  };
  for (const [id, item] of index) {
    stat(item.mainKey).main.add(id);
    for (const [key, centi] of item.factByObject) {
      if (centi <= 0) continue;
      stat(key).fact.add(id);
      stat(key).centi += centi;
    }
  }
  return [...stats]
    .map(([key, entry]) => ({
      object: dict.get(key) ?? UNKNOWN_OBJECT,
      employees_fact: entry.fact.size,
      employees_main: entry.main.size,
      hours: fromCenti(entry.centi),
    }))
    .sort((a, b) => a.object.name.localeCompare(b.object.name, 'ru') || a.object.key.localeCompare(b.object.key));
};

/** Бригады периода: объект — где больше часов её людей, «Не определён» не выбирается. */
export const brigadeList = (
  brigadeIds: readonly string[],
  aggregates: ReadonlyMap<string, IBrigadeAggregate>,
  nameOf: (departmentId: string) => string,
  objectOf: (departmentId: string) => IApiObject | null,
  dict: ReadonlyMap<string, IApiObject>,
): IStaffMonthBrigade[] => brigadeIds.filter(id => aggregates.has(id)).map(departmentId => {
  const aggregate = aggregates.get(departmentId)!;
  return {
    department_id: departmentId,
    name: nameOf(departmentId),
    object: objectOf(departmentId),
    objects: objectHoursList(aggregate.byObject, dict),
    members: [...aggregate.members].sort(([a], [b]) => a - b).map(([employeeId, member]) => ({ employee_id: employeeId, hours: fromCenti(member.centi) })),
  };
});

/** Объект бригады по агрегату периода. */
export const brigadeObjectOf = (
  aggregates: ReadonlyMap<string, IBrigadeAggregate>,
  dict: ReadonlyMap<string, IApiObject>,
  apiObject: (key: string, name: string) => IApiObject,
) => (departmentId: string): IApiObject | null => {
  const key = pickMainKnownKey(aggregates.get(departmentId)?.byObject ?? new Map(), dict);
  return key ? apiObject(key, key) : null;
};

export interface IHalfBuildInput {
  bounds: IMonthBounds;
  monthRows: readonly IStaffMonthRow[];
  dayRecords: ReadonlyMap<number, ReadonlyMap<string, IDayRecord>>;
  dict: ReadonlyMap<string, IApiObject>;
  breakdownOf: (days: Iterable<IDayRecord>) => ISummaryBreakdownRow[];
  shares: readonly IBrigadeDayShare[];
  brigadeIds: readonly string[];
  departmentName: ReadonlyMap<string, string>;
  apiObject: (key: string, name: string) => IApiObject;
}

/** Основной объект половины: часы половины → объект табелирования → объект месяца; ошибка режима — «Не определён». */
const halfObject = (
  row: IStaffMonthRow,
  breakdown: readonly ISummaryBreakdownRow[],
  apiObject: (key: string, name: string) => IApiObject,
): { object: IApiObject; source: StaffMonthHalfObjectSource } => {
  if (row.object_config_error) return { object: UNKNOWN_OBJECT, source: 'unknown' };
  const byHours = pickMainKnownObject(breakdown);
  if (byHours) return { object: apiObject(byHours.key, byHours.name), source: 'hours' };
  const pinned = row.timesheet_object.object;
  if (pinned && pinned.key !== UNKNOWN_OBJECT.key) return { object: pinned, source: 'timesheet_object' };
  return { object: row.object, source: row.object.key === UNKNOWN_OBJECT.key ? 'unknown' : 'month' };
};

const buildHalf = (input: IHalfBuildInput, half: StaffMonthHalf): IStaffMonthHalfView => {
  const bounds = staffMonthHalfBounds(input.bounds, half);
  const view: IStaffMonthHalfView = { bounds, rows: [], index: new Map(), brigades: [], objects: [], preliminary: !bounds.ended };
  if (!bounds.started) return view;
  const inHalf = (date: string): boolean => date >= bounds.from && date <= bounds.to;
  const nameOf = (departmentId: string): string => input.departmentName.get(departmentId) ?? '';
  const aggregates = aggregateBrigades(input.shares.filter(share => inHalf(share.date)));
  const brigadeObject = brigadeObjectOf(aggregates, input.dict, input.apiObject);

  for (const row of input.monthRows) {
    const records = [...(input.dayRecords.get(row.employee_id)?.values() ?? [])].filter(record => inHalf(record.date));
    if (records.length === 0) continue;
    const fact = aggregateFact(records);
    const breakdown = input.breakdownOf(records);
    const { object, source } = halfObject(row, breakdown, input.apiObject);
    const departmentId = pickMonthDepartment(breakdown) ?? row.department?.id ?? null;
    const days = row.days.filter(day => inHalf(day.date));
    const brigadeId = pickEmployeeBrigade(row.employee_id, aggregates, nameOf);
    view.index.set(row.employee_id, { mainKey: object.key, factByObject: fact.factByObject });
    view.rows.push({
      employee_id: row.employee_id,
      full_name: row.full_name,
      department: departmentId ? { id: departmentId, name: nameOf(departmentId) } : null,
      category: row.category,
      is_worker: row.is_worker,
      object,
      object_source: source,
      timesheet_object: row.timesheet_object,
      objects: objectHoursList(fact.factByObject, input.dict),
      hours: fromCenti(fact.factCenti),
      norm: halfNorm(days),
      brigade: brigadeId ? { department_id: brigadeId, name: nameOf(brigadeId), object: brigadeObject(brigadeId) } : null,
      preliminary: !bounds.ended || fact.preliminary,
      object_config_error: row.object_config_error,
      object_frozen: fact.frozen,
      days,
    });
  }
  view.brigades = brigadeList(input.brigadeIds, aggregates, nameOf, brigadeObject, input.dict);
  view.objects = summarizeObjects(view.index, input.dict);
  view.preliminary = !bounds.ended || view.rows.some(row => row.preliminary);
  return view;
};

/** Обе половины месяца. Не начавшаяся половина (16–конец текущего месяца до 16-го) — без строк. */
export const buildStaffMonthHalves = (input: IHalfBuildInput): Record<StaffMonthHalf, IStaffMonthHalfView> => {
  const [first, second] = STAFF_MONTH_HALVES.map(half => buildHalf(input, half));
  return { 1: first, 2: second };
};
