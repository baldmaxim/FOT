/**
 * Ключ основного запроса сетки «Табеля». Внутри ['timesheet-page']: правки табеля сбрасывают его префиксом.
 * Флаг рамок «Нужна корректировка» — в ключе: иначе React Query отдал бы из кэша ответ без weekend_missing_days.
 */
export const timesheetGridQueryKey = (params: {
  month: string;
  rangeStart: string;
  rangeEnd: string;
  departmentKey: string;
  includeWeekendMissing: boolean;
}) => [
  'timesheet-page',
  params.month,
  params.rangeStart,
  params.rangeEnd,
  params.departmentKey,
  'with-objects',
  params.includeWeekendMissing ? 'weekend-missing' : 'plain',
] as const;
