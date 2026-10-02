// Отсечка выгрузки по увольнению: единственная реализация формулы.
//
// Ею пользуются и Excel-выгрузка (timesheet-export.service.ts), и материализация
// версии табеля для 1С (timesheet-version.service.ts). Вынесено в отдельный модуль,
// чтобы версия не тянула весь экспортный сервис: тесты материализации мокают его
// целиком, и вторая копия формулы неизбежно разошлась бы с первой.

/**
 * Строит cutoff-карту ТОЛЬКО для уволенных: дата (включительно), с которой дни
 * не считаются. cutoff = min(excluded_from_timesheet_date [если > startDate], dismissal_date+1).
 * Активные в карту не попадают → их выгрузка не меняется.
 *
 * Гейт по employment_status принципиален: при отложенном увольнении dismissal_date
 * проставляется ещё действующему сотруднику, и отсечка «по наличию даты» вырезала бы
 * его рабочие дни — в неизменяемой редакции табеля это уже не откатить.
 */
export function buildFiredCutoffMap(
  rows: Array<Record<string, unknown>>,
  startDate: string,
): Map<number, string | null> {
  const addOneIso = (iso: string): string => {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + 1);
    return dt.toISOString().slice(0, 10);
  };
  const toIsoDate = (v: unknown): string | null => {
    if (!v) return null;
    if (typeof v === 'string') return v.slice(0, 10);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return null;
  };
  const map = new Map<number, string | null>();
  for (const e of rows) {
    if ((e.employment_status as string | null) !== 'fired') continue;
    const empId = Number(e.id);
    if (!Number.isFinite(empId)) continue;
    const excluded = toIsoDate(e.excluded_from_timesheet_date);
    const dismissal = toIsoDate(e.dismissal_date);
    const dismissalCutoff = dismissal ? addOneIso(dismissal) : null;
    // excluded учитываем только если оно ПОСЛЕ начала периода (иначе не ограничивает наш период).
    const excludedEff = excluded && excluded > startDate ? excluded : null;
    const candidates = [excludedEff, dismissalCutoff].filter((v): v is string => !!v);
    if (candidates.length === 0) continue;
    map.set(empId, candidates.reduce((min, v) => (v < min ? v : min)));
  }
  return map;
}

// ── Уволенный не виден в месяце увольнения (с сентября 2026) ───────────────────────────
//
// С периодов, начинающихся 01.09.2026 и позже, уволенный (employment_status = 'fired' с
// известной dismissal_date) не попадает в табель, подачу, редакцию для 1С и «Единый 1С»
// за месяц увольнения — вместе с отработанными до увольнения днями — и, тем более, за
// следующие месяцы. Месяцы до увольнения не меняются: человек тогда работал. Август и
// раньше 1С уже приняла с уволенными до даты увольнения — там правило прежнее.
// Отложенное увольнение (дата у ещё работающего) и восстановленные (active) не затронуты.

/** Первый месяц, с которого уволенный скрыт в месяце своего увольнения. */
export const FIRED_HIDDEN_FROM_MONTH = '2026-09-01';

/**
 * SQL: нижняя граница dismissal_date, при которой уволенный ещё в составе периода,
 * начинающегося startParam ($N). С 01.09.2026 — 1-е число следующего месяца, раньше —
 * само начало периода (виден до даты увольнения).
 */
export function firedVisibleSinceSql(startParam: string): string {
  return `(CASE WHEN ${startParam}::date >= DATE '${FIRED_HIDDEN_FROM_MONTH}'
                THEN (date_trunc('month', ${startParam}::date::timestamp) + interval '1 month')::date
                ELSE ${startParam}::date END)`;
}

/** SQL: сотрудник в составе периода по статусу — работает или уволен позже. alias — с точкой не нужен. */
export function firedEligibleSql(alias: string | null, startParam: string): string {
  const a = alias ? `${alias}.` : '';
  return `(${a}employment_status = 'active'
             OR (${a}employment_status = 'fired'
                 AND ${a}dismissal_date IS NOT NULL
                 AND ${a}dismissal_date >= ${firedVisibleSinceSql(startParam)}))`;
}

/**
 * SQL: уволенный, скрытый в периоде (для ростера подачи — он зафиксирован при подаче, а
 * увольнение могло случиться позже). До 01.09.2026 — никого: там ростер выгружается целиком.
 */
export function firedHiddenSql(alias: string, startParam: string): string {
  return `(${startParam}::date >= DATE '${FIRED_HIDDEN_FROM_MONTH}'
             AND ${alias}.employment_status IS NOT DISTINCT FROM 'fired'
             AND ${alias}.dismissal_date IS NOT NULL
             AND ${alias}.dismissal_date < (date_trunc('month', ${startParam}::date::timestamp) + interval '1 month')::date)`;
}

const nextMonthStartOf = (isoDate: string): string => {
  const date = new Date(`${isoDate.slice(0, 8)}01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString().slice(0, 10);
};

/** То же, что firedHiddenSql, в TS. periodStart — 'YYYY-MM-DD'. */
export function isFiredHiddenForPeriod(
  row: { employment_status?: unknown; dismissal_date?: unknown },
  periodStart: string,
): boolean {
  if (periodStart < FIRED_HIDDEN_FROM_MONTH) return false;
  if (row.employment_status !== 'fired') return false;
  const value = row.dismissal_date;
  const dismissal = typeof value === 'string'
    ? value.slice(0, 10)
    : value instanceof Date ? value.toISOString().slice(0, 10) : null;
  if (!dismissal) return false;
  return dismissal < nextMonthStartOf(periodStart);
}
