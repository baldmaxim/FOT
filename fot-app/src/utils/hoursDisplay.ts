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
