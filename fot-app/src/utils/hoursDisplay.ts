import type { TimesheetEntry, TimesheetObjectEntry } from '../types/timesheet';

// Единый выбор «видимых часов» из табельной записи в зависимости от
// per-role флага show_actual_hours (см. system_roles.show_actual_hours,
// миграция 077).
//
// showActual=false (default) — текущее поведение: display_hours_worked
// (часы, обрезанные сверху плановой нормой дня) с фолбэком на hours_worked.
// showActual=true — фактические часы по СКУД (hours_worked) без урезания.
export const selectVisibleHours = (
  entry: TimesheetEntry | null | undefined,
  showActual: boolean,
): number | null => {
  if (!entry) return null;
  if (showActual) {
    return entry.hours_worked ?? entry.display_hours_worked ?? null;
  }
  return entry.display_hours_worked ?? entry.hours_worked ?? null;
};

export const selectVisibleObjectHours = (
  entry: TimesheetObjectEntry | null | undefined,
  showActual: boolean,
): number => {
  if (!entry) return 0;
  if (showActual) {
    return entry.hours_worked ?? entry.display_hours_worked ?? 0;
  }
  return entry.display_hours_worked ?? entry.hours_worked ?? 0;
};

// Единый форматтер часов «Hч Mм» / «Hч» / «Mм» / «—».
// Используется во всех точках вывода рабочего времени за день, чтобы цифра
// и форма записи совпадали в табеле, боковой панели, модалке дня и карточке
// сотрудника.
export const formatHoursLabel = (hours: number | null | undefined): string => {
  if (hours == null || !Number.isFinite(hours)) return '—';
  if (hours <= 0) return '0ч';
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  if (m === 60) return `${h + 1}ч`;
  if (m === 0) return `${h}ч`;
  if (h === 0) return `${m}м`;
  return `${h}ч ${m}м`;
};

export const formatSecondsLabel = (seconds: number | null | undefined): string => {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return '—';
  return formatHoursLabel(seconds / 3600);
};
