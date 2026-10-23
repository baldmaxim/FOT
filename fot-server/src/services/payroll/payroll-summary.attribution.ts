/**
 * «Свод» на «Расчётах»: к какому объекту отнести выплаты сотрудника за месяц и какой отдел месяца брать
 * для категории. Чистые функции — порядок строк БД на результат не влияет.
 *
 * Объект — объект табелирования из объектной разбивки закрытого табеля (timesheet_version_objects):
 * при режимах «объект» и «Текущая деятельность» в разбивке одна группа, при «СКУД» — несколько, тогда
 * берётся основная (больше всего часов). «Текущая деятельность» — это «Офис».
 */
import { CURRENT_ACTIVITY_KEY } from '../timesheet-object-breakdown.service.js';
import { CURRENT_ACTIVITY_ADDRESS, type IResolvedExportMode } from '../timesheet-export-mode.service.js';
import { UNKNOWN_OBJECT_KEY } from '../timesheet-object.service.js';

export const SUMMARY_OFFICE = { key: 'office', name: 'Офис' } as const;
export const SUMMARY_UNKNOWN = { key: 'unknown', name: 'Не определён' } as const;

export interface ISummaryObject {
  /** id объекта СКУД, 'office' или 'unknown'. */
  key: string;
  name: string;
}

/** Строка разбивки: часы сотрудника на объекте в одной подаче месяца. */
export interface ISummaryBreakdownRow {
  version_id: number;
  /** Отдел подачи; у персональной подачи — null. */
  department_id: string | null;
  object_key: string | null;
  object_id: string | null;
  object_name: string | null;
  object_address: string | null;
  hours: number;
}

/** Часы ниже порога — ноль, как в выгрузках для 1С. */
const HOURS_EPSILON = 0.001;

const isCurrentActivityAddress = (address: string | null | undefined): boolean => (
  (address ?? '').trim().toLocaleLowerCase('ru') === CURRENT_ACTIVITY_ADDRESS.toLocaleLowerCase('ru')
);

/** Группа «Свода» для строки разбивки: «Офис», «Не определён» или сам объект. */
export const summaryObjectOf = (row: ISummaryBreakdownRow): ISummaryObject => {
  if (row.object_key === CURRENT_ACTIVITY_KEY || isCurrentActivityAddress(row.object_address)) return SUMMARY_OFFICE;
  if (!row.object_id || row.object_key === UNKNOWN_OBJECT_KEY) return SUMMARY_UNKNOWN;
  return { key: row.object_id, name: row.object_name?.trim() || SUMMARY_UNKNOWN.name };
};

const compareNames = (left: ISummaryObject, right: ISummaryObject): number => (
  left.name.localeCompare(right.name, 'ru') || left.key.localeCompare(right.key)
);

/**
 * Основной объект месяца: группа с наибольшими часами (подачи месяца суммируются); ничья — по имени,
 * затем по ключу. Часов нет — null (нужен запасной путь).
 */
export const pickMainObject = (rows: readonly ISummaryBreakdownRow[]): ISummaryObject | null => {
  const totals = new Map<string, { object: ISummaryObject; hours: number }>();
  for (const row of rows) {
    if (!(row.hours > 0)) continue;
    const object = summaryObjectOf(row);
    const current = totals.get(object.key);
    if (current) current.hours += row.hours;
    else totals.set(object.key, { object, hours: row.hours });
  }
  let best: { object: ISummaryObject; hours: number } | null = null;
  for (const candidate of totals.values()) {
    if (candidate.hours < HOURS_EPSILON) continue;
    if (!best
      || candidate.hours > best.hours + HOURS_EPSILON
      || (Math.abs(candidate.hours - best.hours) <= HOURS_EPSILON && compareNames(candidate.object, best.object) < 0)) {
      best = candidate;
    }
  }
  return best?.object ?? null;
};

/**
 * Отдел месяца для категории: отдел подачи, где у сотрудника больше всего часов (ничья — более поздняя
 * подача). Персональная подача (без отдела) или подачи нет — null: категорию решит текущий отдел.
 */
export const pickMonthDepartment = (rows: readonly ISummaryBreakdownRow[]): string | null => {
  const byVersion = new Map<number, { department: string | null; hours: number }>();
  for (const row of rows) {
    const current = byVersion.get(row.version_id);
    const hours = row.hours > 0 ? row.hours : 0;
    if (current) current.hours += hours;
    else byVersion.set(row.version_id, { department: row.department_id, hours });
  }
  let best: { versionId: number; department: string | null; hours: number } | null = null;
  for (const [versionId, value] of byVersion) {
    if (!best
      || value.hours > best.hours + HOURS_EPSILON
      || (Math.abs(value.hours - best.hours) <= HOURS_EPSILON && versionId > best.versionId)) {
      best = { versionId, ...value };
    }
  }
  return best?.department ?? null;
};

export interface ISummaryObjectMeta {
  name: string;
  address: string | null;
}

/**
 * Запасной путь — сотрудника нет в разбивке месяца или часов 0: режим табелирования месяца.
 * «Объект» — закреплённый объект (с адресом «Текущая деятельность» — «Офис»; объекта нет — «Не
 * определён»), «Текущая деятельность» — «Офис», «СКУД» — «Не определён»: без часов основного нет.
 */
export const fallbackSummaryObject = (
  mode: IResolvedExportMode | undefined,
  objectMeta: ReadonlyMap<string, ISummaryObjectMeta>,
): ISummaryObject => {
  if (mode?.mode === 'current_activity') return SUMMARY_OFFICE;
  if (mode?.mode === 'object' && mode.pinnedObjectId) {
    const meta = objectMeta.get(mode.pinnedObjectId);
    if (!meta) return SUMMARY_UNKNOWN;
    if (isCurrentActivityAddress(meta.address)) return SUMMARY_OFFICE;
    return { key: mode.pinnedObjectId, name: meta.name.trim() || SUMMARY_UNKNOWN.name };
  }
  return SUMMARY_UNKNOWN;
};

/** Последний день месяца по первому числу (YYYY-MM-DD). */
const lastDayOfMonth = (monthStart: string): string => {
  const date = new Date(`${monthStart}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + 1, 0);
  return date.toISOString().slice(0, 10);
};

/** День раньше (YYYY-MM-DD). */
const previousDay = (isoDate: string): string => {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
};

/**
 * Период часов месяца для объекта «Свода» по проходам: завершённый месяц — целиком, текущий — с 1-го
 * по вчера по МСК (как ночной расчёт объекта табелирования); 1-го числа и будущий месяц — null.
 */
export const summaryHoursPeriod = (
  monthStart: string,
  todayMsk: string,
): { start: string; end: string } | null => {
  const end = lastDayOfMonth(monthStart);
  if (end < todayMsk) return { start: monthStart, end };
  const yesterday = previousDay(todayMsk);
  return yesterday >= monthStart ? { start: monthStart, end: yesterday } : null;
};

/**
 * Объект «Свода» по часам месяца: первый в списке объектов табелирования (больше всего часов,
 * офисы — суммой). Офисная группа (без id) — «Офис»; часов нет — null.
 */
export const summaryObjectFromHours = (
  top: { objectId: string | null; label: string } | undefined,
): ISummaryObject | null => {
  if (!top) return null;
  if (!top.objectId) return SUMMARY_OFFICE;
  return { key: top.objectId, name: top.label.trim() || SUMMARY_UNKNOWN.name };
};

/** «175000.50» → 17500050 копеек; мусор — 0. */
export const toCents = (amount: string): number => {
  const value = Number(amount);
  return Number.isFinite(value) ? Math.round(value * 100) : 0;
};

/** 17500050 → «175000.50», −150 → «-1.50». */
export const centsToAmount = (cents: number): string => {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
};
