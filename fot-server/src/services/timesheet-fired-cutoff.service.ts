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
