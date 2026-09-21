/**
 * Сбор данных для выгрузки боковой панели «Детализация» (Табель → по сотруднику).
 *
 * Лист повторяет панель один в один: строка дня берёт часы, первый вход и последний
 * выход из ТАБЕЛЬНОЙ записи (buildAttendanceEntries, displayMode='actual' — ровно как
 * GET /api/timesheet), а не пересчитывает их по сырым проходам. Иначе цифра в файле
 * разошлась бы с цифрой на экране: табель вычитает обед, режет по длине смены и
 * учитывает корректировки.
 *
 * Порядок строк внутри дня (события, «Перерыв», незачтённые события Sigur) повторяет
 * buildDisplayItems/mergeFailuresIntoDisplay фронта (fot-app/src/utils/skudDisplay.ts).
 * Код продублирован осознанно — фронт и бэк не делят пакет; так же продублирован
 * calculateWorkedSeconds в skud-export.service.ts.
 */
import { query } from '../config/postgres.js';
import { formatDateToISO } from '../utils/date.utils.js';
import { buildAttendanceEntries, type IAttendanceEntry } from './attendance.service.js';
import { isPreHoliday, isWorkingDay, loadCalendarMonth, resolveSchedulesForPeriod } from './schedule.service.js';
import type { IProductionCalendarMonth, IResolvedSchedule } from '../types/index.js';

export interface IDetailExportEvent {
  id: number | string;
  event_date: string;
  event_time: string;
  access_point: string | null;
  direction: 'entry' | 'exit' | null;
}

export interface IDetailExportFailure {
  id: number;
  event_date: string;
  event_time: string;
  access_point: string | null;
  failure_type: string;
  reason: string | null;
}

export type DetailDisplayItem =
  | { kind: 'event'; event: IDetailExportEvent; pairDurationSeconds: number | null; isInternal: boolean }
  | { kind: 'break'; breakSeconds: number }
  | { kind: 'failure'; failure: IDetailExportFailure };

export interface IDetailExportDay {
  date: string;
  /** Предпраздничный рабочий день (−1ч) — подпись как в панели. */
  isPreHoliday: boolean;
  isToday: boolean;
  firstEntry: string | null;
  lastExit: string | null;
  /** «8ч» / «Неявка» / «Б/л» / «Отпуск» / «—» — ровно как getHoursLabel в панели. */
  hoursLabel: string;
  /** «превышение лимита 30 мин • не определён объект (2)» или null. */
  travelNote: string | null;
  items: DetailDisplayItem[];
}

export interface IDetailExportData {
  employeeName: string;
  startDate: string;
  endDate: string;
  days: IDetailExportDay[];
}

/**
 * Реальная календарная дата в ISO. Проверки регуляркой мало: '2026-99-99' её
 * проходит и уходит в SQL текстом, а падает уже в PostgreSQL — наружу это
 * выглядит как 500 вместо внятного 400.
 */
export const isRealIsoDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
};

const timeToSeconds = (time: string): number => {
  const [h = 0, m = 0, s = 0] = time.split(':').map(Number);
  return h * 3600 + m * 60 + s;
};

const nowSeconds = (): number => {
  const now = new Date();
  return now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
};

/** «Hч Mм» / «Hч» / «Mм» / «—» — порт formatHoursLabel (fot-app/src/utils/hoursDisplay.ts). */
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

const formatTravelMinutes = (minutes: number): string => {
  if (minutes <= 0) return '0 мин';
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return `${mins} мин`;
  if (mins === 0) return `${hours}ч`;
  return `${hours}ч ${mins}м`;
};

const isInternalEvent = (event: IDetailExportEvent, internalPoints: Set<string>): boolean =>
  !!event.access_point && internalPoints.has(event.access_point);

/**
 * События дня + строки «Перерыв» между внешними парами. Внутренние проходы попадают
 * в список (isInternal=true), но в парном расчёте не участвуют. Открытый вход затирается
 * только при совпадении точки (повторный пробив того же турникета) — миграция 163.
 */
export const buildDetailDisplayItems = (
  events: IDetailExportEvent[],
  internalPoints: Set<string>,
  dateStr: string,
  todayStr: string,
  nowSec?: number,
): DetailDisplayItem[] => {
  const sorted = [...events].sort((a, b) => a.event_time.localeCompare(b.event_time));
  const items: DetailDisplayItem[] = [];
  let pendingEntry: IDetailExportEvent | null = null;
  let lastExitTimeSec: number | null = null;

  for (const ev of sorted) {
    const internal = isInternalEvent(ev, internalPoints);

    if (ev.direction === 'entry') {
      if (!internal && lastExitTimeSec !== null) {
        const gap = timeToSeconds(ev.event_time) - lastExitTimeSec;
        if (gap > 0) items.push({ kind: 'break', breakSeconds: gap });
        lastExitTimeSec = null;
      }
      items.push({ kind: 'event', event: ev, pairDurationSeconds: null, isInternal: internal });
      if (!internal && (pendingEntry === null || ev.access_point === pendingEntry.access_point)) {
        pendingEntry = ev;
      }
      continue;
    }

    let pairDuration: number | null = null;
    if (!internal && pendingEntry) {
      pairDuration = timeToSeconds(ev.event_time) - timeToSeconds(pendingEntry.event_time);
      pendingEntry = null;
      lastExitTimeSec = timeToSeconds(ev.event_time);
    }
    items.push({ kind: 'event', event: ev, pairDurationSeconds: pairDuration, isInternal: internal });
  }

  if (pendingEntry && dateStr === todayStr) {
    const lastItem = items[items.length - 1];
    if (lastItem && lastItem.kind === 'event' && lastItem.event.id === pendingEntry.id) {
      const now = nowSec ?? nowSeconds();
      lastItem.pairDurationSeconds = Math.max(0, now - timeToSeconds(pendingEntry.event_time));
    }
  }

  return items;
};

/**
 * Вставляет незачтённые события Sigur на место по времени. С проходами в пары не
 * группируются — отдельная строка с пометкой. Строки «Перерыв» остаются там, где их
 * поставил buildDetailDisplayItems (после своего exit).
 */
export const mergeDetailFailures = (
  items: DetailDisplayItem[],
  failures: IDetailExportFailure[],
): DetailDisplayItem[] => {
  if (failures.length === 0) return items;

  const getItemTime = (item: DetailDisplayItem): number => {
    if (item.kind === 'event') return timeToSeconds(item.event.event_time);
    if (item.kind === 'failure') return timeToSeconds(item.failure.event_time);
    return Number.MAX_SAFE_INTEGER;
  };

  const result: DetailDisplayItem[] = [];
  const pending = [...failures]
    .sort((a, b) => a.event_time.localeCompare(b.event_time))
    .map<DetailDisplayItem>(failure => ({ kind: 'failure', failure }));

  let cursor = 0;
  for (const item of items) {
    if (item.kind !== 'break') {
      const itemTime = getItemTime(item);
      while (cursor < pending.length && getItemTime(pending[cursor]) <= itemTime) {
        result.push(pending[cursor]);
        cursor += 1;
      }
    }
    result.push(item);
  }
  while (cursor < pending.length) {
    result.push(pending[cursor]);
    cursor += 1;
  }

  return result;
};

/** Выбор видимых часов — порт selectVisibleHours (per-role show_actual_hours, миграция 077). */
const selectVisibleHours = (entry: IAttendanceEntry | null, showActualHours: boolean): number | null => {
  if (!entry) return null;
  if (showActualHours) return entry.hours_worked ?? entry.display_hours_worked ?? null;
  return entry.display_hours_worked ?? entry.hours_worked ?? null;
};

/** Подпись часов дня — порт getHoursLabel панели (часы округляются до целых). */
const buildHoursLabel = (entry: IAttendanceEntry | null, showActualHours: boolean): string => {
  if (!entry) return '—';
  if (entry.status === 'absent') return 'Неявка';
  if (entry.status === 'sick') return 'Б/л';
  if (entry.status === 'vacation') return 'Отпуск';
  const visibleHours = selectVisibleHours(entry, showActualHours);
  return formatHoursLabel(visibleHours != null ? Math.round(visibleHours) : null);
};

/** Подпись проблем «Дороги» — порт getTravelIssueLabel панели. */
const buildTravelNote = (entry: IAttendanceEntry | null): string | null => {
  if (!entry) return null;
  const parts: string[] = [];
  if ((entry.travel_delay_minutes || 0) > 0) {
    parts.push(`превышение лимита ${formatTravelMinutes(entry.travel_delay_minutes || 0)}`);
  }
  if ((entry.travel_problematic_segments || 0) > 0) {
    const count = entry.travel_problematic_segments || 0;
    parts.push(count === 1 ? 'не определён объект' : `не определён объект (${count})`);
  }
  return parts.length > 0 ? parts.join(' • ') : null;
};

const isScheduleDayOff = (
  schedule: IResolvedSchedule | undefined,
  calendar: IProductionCalendarMonth | null,
  date: Date,
): boolean => {
  if (!schedule) {
    const dow = date.getDay();
    return dow === 0 || dow === 6;
  }
  return !isWorkingDay(schedule, date, calendar);
};

const eachDate = (startDate: string, endDate: string): string[] => {
  const dates: string[] = [];
  const [sy, sm, sd] = startDate.split('-').map(Number);
  const [ey, em, ed] = endDate.split('-').map(Number);
  const cursor = new Date(sy, sm - 1, sd);
  const last = new Date(ey, em - 1, ed);
  while (cursor <= last) {
    dates.push(formatDateToISO(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
};

/**
 * Собирает строки выгрузки: табельные дни за период + события СКУД по каждому дню.
 * События/незачтённые события/внутренние точки передаёт контроллер — их выборка
 * зависит от прав запроса (getInternalAccessPointsForRequest сужается по скоупу).
 */
export async function collectEmployeeTimesheetDetail(params: {
  employeeId: number;
  startDate: string;
  endDate: string;
  showActualHours: boolean;
  events: IDetailExportEvent[];
  failures: IDetailExportFailure[];
  internalPoints: Set<string>;
}): Promise<IDetailExportData> {
  const { employeeId, startDate, endDate, showActualHours, events, failures, internalPoints } = params;

  // Состав не фильтруется по employment_status/is_archived: панель показывает и
  // уволенного в периоде — файл должен собраться для того же сотрудника.
  const employeeRows = await query<{ id: number; full_name: string | null }>(
    `SELECT id, full_name FROM employees WHERE id = $1`,
    [employeeId],
  );
  const employee = employeeRows[0];
  if (!employee) {
    throw new Error('EMPLOYEE_NOT_FOUND');
  }
  const employeeName = employee.full_name || `Сотрудник #${employeeId}`;

  const [year, month] = startDate.split('-').map(Number);
  const todayStr = formatDateToISO(new Date());

  const dailySchedulesMap = await resolveSchedulesForPeriod([{ id: employeeId }], startDate, endDate);
  const calendarMonth = await loadCalendarMonth(year, month);

  // Те же параметры, что у интерактивного табеля (timesheet.controller.ts): 'actual'
  // держит first_entry/last_exit (capped_to_schedule их зануляет), synthesizeObjectOnlyDays
  // добавляет дни, существующие только как объектная правка. Запись travel-сегментов
  // выключена — выгрузка read-only.
  const { entries } = await buildAttendanceEntries({
    employees: [{ id: employeeId, full_name: employeeName }],
    startDate,
    endDate,
    dailySchedulesMap,
    calendarMonth,
    todayStr,
    displayMode: 'actual',
    synthesizeObjectOnlyDays: true,
    persistTravelSegments: false,
  });

  const entryByDate = new Map<string, IAttendanceEntry>();
  for (const entry of entries) {
    if (entry.employee_id === employeeId) entryByDate.set(entry.work_date, entry);
  }

  const eventsByDate = new Map<string, IDetailExportEvent[]>();
  for (const event of events) {
    const list = eventsByDate.get(event.event_date);
    if (list) list.push(event);
    else eventsByDate.set(event.event_date, [event]);
  }
  const failuresByDate = new Map<string, IDetailExportFailure[]>();
  for (const failure of failures) {
    const list = failuresByDate.get(failure.event_date);
    if (list) list.push(failure);
    else failuresByDate.set(failure.event_date, [failure]);
  }

  const schedulesByDate = dailySchedulesMap.get(employeeId);
  const nowSec = nowSeconds();
  const days: IDetailExportDay[] = [];

  for (const date of eachDate(startDate, endDate)) {
    // Будущее не выгружаем — панель его тоже не показывает.
    if (date > todayStr) break;

    const entry = entryByDate.get(date) ?? null;
    const [y, m, d] = date.split('-').map(Number);
    const dateObj = new Date(y, m - 1, d);
    const schedule = schedulesByDate?.get(date);
    // Выходной по графику без единой записи панель пропускает целиком.
    if (!entry && isScheduleDayOff(schedule, calendarMonth, dateObj)) continue;

    const dayEvents = eventsByDate.get(date) ?? [];
    const dayFailures = failuresByDate.get(date) ?? [];

    days.push({
      date,
      isPreHoliday: schedule ? isPreHoliday(dateObj, schedule, calendarMonth) : false,
      isToday: date === todayStr,
      firstEntry: entry?.first_entry || null,
      lastExit: entry?.last_exit || null,
      hoursLabel: buildHoursLabel(entry, showActualHours),
      travelNote: buildTravelNote(entry),
      items: mergeDetailFailures(
        buildDetailDisplayItems(dayEvents, internalPoints, date, todayStr, nowSec),
        dayFailures,
      ),
    });
  }

  return { employeeName, startDate, endDate, days };
}
