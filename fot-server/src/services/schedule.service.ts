/**
 * Сервис графиков работы: resolve (каскад employee → default),
 * bulk, хелперы с учётом производственного календаря.
 */
import { supabase } from '../config/database.js';
import type {
  IResolvedSchedule,
  IDayOverride,
  ICycleDay,
  ScheduleType,
  PatternType,
  IProductionCalendarMonth,
} from '../types/index.js';

export interface IDayScheduleParams {
  work_start: string;
  work_end: string;
  work_hours: number;
}

const DEFAULT_SCHEDULE: IResolvedSchedule = {
  schedule_id: '',
  schedule_type: 'office',
  work_start: '09:00:00',
  work_end: '18:00:00',
  work_hours: 8,
  work_days: [1, 2, 3, 4, 5],
  office_days: null,
  late_threshold_minutes: 0,
  day_overrides: null,
  lunch_minutes: 0,
  respects_holidays: true,
  pattern_type: 'custom',
  expected_saturdays_per_month: 0,
  full_day_threshold_minutes: null,
  weekend_full_day_threshold_minutes: null,
  cycle_length: null,
  cycle_days: null,
  anchor_date: null,
  assignment_anchor_date: null,
  source: 'default',
};

/** ISO day-of-week: 1=Пн..7=Вс */
const getISODow = (date: Date): number => {
  const d = date.getDay();
  return d === 0 ? 7 : d;
};

/** Приводит Date к YYYY-MM-DD (локально) */
const toISODate = (date: Date): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

/**
 * Слот циклического графика для конкретной даты.
 * Возвращает null, если график не циклический или у него нет валидных cycle_*-полей.
 *
 * Сдвиг считается в календарных днях между anchor_date и target date в локальной TZ
 * (UTC-полночь обоих, чтобы DST не плыл). Отрицательный сдвиг (date раньше anchor)
 * корректно нормализуется через ((x % n) + n) % n.
 */
export const getCycleSlot = (
  schedule: IResolvedSchedule,
  date: Date,
): ICycleDay | null => {
  if (schedule.pattern_type !== 'cycle') return null;
  const cycleLength = schedule.cycle_length;
  const cycleDays = schedule.cycle_days;
  const anchor = schedule.assignment_anchor_date ?? schedule.anchor_date;
  if (!cycleLength || !cycleDays || cycleDays.length !== cycleLength || !anchor) {
    return null;
  }

  const [ay, am, ad] = anchor.split('-').map(Number);
  if (!ay || !am || !ad) return null;
  const anchorUtc = Date.UTC(ay, am - 1, ad);
  const targetUtc = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const dayDiff = Math.round((targetUtc - anchorUtc) / 86_400_000);
  const idx = ((dayDiff % cycleLength) + cycleLength) % cycleLength;
  return cycleDays[idx] ?? null;
};

/** Праздник ли день по календарю (holidays + mandatory_holidays) */
const isHoliday = (
  date: Date,
  schedule: IResolvedSchedule,
  calendar: IProductionCalendarMonth | null,
): boolean => {
  if (!calendar) return false;
  const iso = toISODate(date);
  if (calendar.mandatory_holidays?.includes(iso)) return true;
  if (schedule.respects_holidays && calendar.holidays?.includes(iso)) return true;
  return false;
};

/** Предпраздничный ли день для конкретного графика (рабочий, но -1ч). Уважает respects_holidays. */
export const isPreHoliday = (
  date: Date,
  schedule: IResolvedSchedule,
  calendar: IProductionCalendarMonth | null,
): boolean => {
  if (!calendar?.pre_holidays?.length) return false;
  if (!schedule.respects_holidays) return false;
  return calendar.pre_holidays.includes(toISODate(date));
};

export const isWorkingDay = (
  schedule: IResolvedSchedule,
  date: Date,
  calendar: IProductionCalendarMonth | null = null,
): boolean => {
  // Цикл-графики: рабочий статус определяется слотом цикла, а не днём недели.
  // Праздники из календаря применяются только если respects_holidays=true.
  const slot = getCycleSlot(schedule, date);
  if (slot) {
    if (slot.work_hours <= 0) return false;
    return !isHoliday(date, schedule, calendar);
  }
  if (isHoliday(date, schedule, calendar)) return false;
  return schedule.work_days.includes(getISODow(date));
};

/** Возвращает work_start/work_end/work_hours для конкретного дня с учётом day_overrides и cycle_days */
export const getScheduleForDate = (schedule: IResolvedSchedule, date: Date): IDayScheduleParams => {
  const slot = getCycleSlot(schedule, date);
  if (slot) {
    return {
      work_start: slot.work_start ?? schedule.work_start,
      work_end: slot.work_end ?? schedule.work_end,
      work_hours: slot.work_hours,
    };
  }
  if (schedule.day_overrides) {
    const dow = String(getISODow(date));
    const override = schedule.day_overrides[dow];
    if (override) {
      return {
        work_start: override.work_start,
        work_end: override.work_end,
        work_hours: override.work_hours,
      };
    }
  }
  return {
    work_start: schedule.work_start,
    work_end: schedule.work_end,
    work_hours: schedule.work_hours,
  };
};

export const isOfficeDay = (schedule: IResolvedSchedule, date: Date): boolean => {
  if (schedule.schedule_type !== 'hybrid') return schedule.schedule_type === 'office' || schedule.schedule_type === 'shift';
  if (!schedule.office_days) return true;
  return schedule.office_days.includes(getISODow(date));
};

/** Длительность смены = work_end − work_start (без вычета обеда). Учитывает ночные смены. */
export const getShiftDurationHours = (daySchedule: IDayScheduleParams): number => {
  const parse = (value: string): number => {
    const [h = 0, m = 0] = value.split(':').map(Number);
    return h * 60 + m;
  };
  const startMin = parse(daySchedule.work_start);
  let endMin = parse(daySchedule.work_end);
  if (endMin <= startMin) endMin += 24 * 60;
  return Math.max(0, (endMin - startMin) / 60);
};

/** Длительность смены по строкам времени (для нужд контроллера/миграции). */
export const computeShiftDurationHours = (workStart: string, workEnd: string): number => {
  return getShiftDurationHours({ work_start: workStart, work_end: workEnd, work_hours: 0 });
};

/**
 * Нетто-рабочее время = длительность смены − обед.
 * Используется бэкендом при сохранении графика: гарантирует, что в БД всегда лежит нетто,
 * независимо от того, что прислал клиент в поле work_hours.
 */
export const computeNetWorkHours = (
  workStart: string,
  workEnd: string,
  lunchMinutes: number,
): number => {
  return Math.max(0, computeShiftDurationHours(workStart, workEnd) - (lunchMinutes || 0) / 60);
};

/** Порог полного дня для конкретной даты: как в UI табеля.
 *  work_hours хранится как нетто (без обеда), отдельный вычет lunch_minutes не нужен.
 */
export const getFullDayThresholdHoursForDate = (
  schedule: IResolvedSchedule,
  date: Date,
  calendar: IProductionCalendarMonth | null = null,
): number => {
  const isDayOff = !isWorkingDay(schedule, date, calendar);
  const daySchedule = getScheduleForDate(schedule, date);
  // work_hours напрямую: иначе для дробных значений (например 7.53) промежуточный
  // round(*60)/60 = 7.5333 даёт порог чуть выше нормы, и capped факт ложно underwork.
  const fallbackHours = Math.max(0, daySchedule.work_hours);

  if (isDayOff) {
    if (schedule.weekend_full_day_threshold_minutes != null) {
      return schedule.weekend_full_day_threshold_minutes / 60;
    }
    if (schedule.full_day_threshold_minutes != null) {
      return schedule.full_day_threshold_minutes / 60;
    }
    return fallbackHours;
  }

  // Предпраздничный рабочий день: порог снижается на 1 час (но не ниже 0)
  const preHolidayMinusHours = isPreHoliday(date, schedule, calendar) ? 1 : 0;

  if (schedule.full_day_threshold_minutes != null) {
    return Math.max(0, schedule.full_day_threshold_minutes / 60 - preHolidayMinusHours);
  }

  return Math.max(0, fallbackHours - preHolidayMinusHours);
};

/** Норма часов на конкретный день: 0 для нерабочего, work_hours-1 для предпраздничного будня (если respects_holidays), иначе work_hours. */
export const getDayNormHours = (
  schedule: IResolvedSchedule,
  date: Date,
  calendar: IProductionCalendarMonth | null = null,
): number => {
  if (!isWorkingDay(schedule, date, calendar)) return 0;
  const day = getScheduleForDate(schedule, date);
  const minus = isPreHoliday(date, schedule, calendar) ? 1 : 0;
  return Math.max(0, day.work_hours - minus);
};

/**
 * Статусы записей табеля, при которых день считается «не рабочим» — он
 * не идёт ни в план (norm), ни в факт (fact). На выходных просто игнорируется.
 * absent (прогул) сюда НЕ входит: план остаётся, факт=0 → красная недоработка.
 */
export const NON_WORKING_STATUSES: ReadonlySet<string> = new Set([
  'vacation',
  'sick',
  'educational_leave',
  'unpaid',
]);

/** Считает рабочие дни (будни по графику + minus праздники) */
export const countWorkingDaysForSchedule = (
  year: number,
  month: number,
  schedule: IResolvedSchedule,
  calendar: IProductionCalendarMonth | null = null,
): number => {
  const daysInMonth = new Date(year, month, 0).getDate();
  let count = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    if (isWorkingDay(schedule, new Date(year, month - 1, d), calendar)) count++;
  }
  return count;
};

/** Считает рабочие дни до сегодня включительно */
export const countWorkingDaysUpToToday = (
  year: number,
  month: number,
  schedule: IResolvedSchedule,
  calendar: IProductionCalendarMonth | null = null,
): number => {
  const now = new Date();
  const curYear = now.getFullYear();
  const curMonth = now.getMonth() + 1;

  if (year < curYear || (year === curYear && month < curMonth)) {
    return countWorkingDaysForSchedule(year, month, schedule, calendar);
  }
  if (year > curYear || (year === curYear && month > curMonth)) return 0;

  const today = now.getDate();
  let count = 0;
  for (let d = 1; d <= today; d++) {
    if (isWorkingDay(schedule, new Date(year, month - 1, d), calendar)) count++;
  }
  return count;
};

/** Порог опоздания с учётом допуска (опционально — для конкретного дня) */
export const getEffectiveLateThreshold = (schedule: IResolvedSchedule, date?: Date): string => {
  const dayParams = date ? getScheduleForDate(schedule, date) : schedule;
  const [h, m, s] = dayParams.work_start.split(':').map(Number);
  const totalMin = h * 60 + m + schedule.late_threshold_minutes;
  const hh = Math.floor(totalMin / 60);
  const mm = totalMin % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(s || 0).padStart(2, '0')}`;
};

/**
 * Норма часов в месяце:
 *  - сумма work_hours по будням графика (с учётом праздников),
 *  - плюс expected_saturdays_per_month × work_hours (для pattern_type='5+2').
 * Обед в норму НЕ входит — считается как length of shift, так как сотрудник физически присутствует.
 */
export const countNormHoursForSchedule = (
  year: number,
  month: number,
  schedule: IResolvedSchedule,
  calendar: IProductionCalendarMonth | null = null,
): number => {
  const daysInMonth = new Date(year, month, 0).getDate();
  let total = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    total += getDayNormHours(schedule, new Date(year, month - 1, d), calendar);
  }
  // Дополнительные субботы — только для классического 5+2 (на день недели).
  // Для cycle норма уже посчитана через getDayNormHours (по слотам цикла).
  if (schedule.pattern_type === '5+2' && schedule.expected_saturdays_per_month > 0) {
    total += schedule.expected_saturdays_per_month * schedule.work_hours;
  }
  return total;
};

/** Считает норму часов до сегодня включительно */
export const countNormHoursUpToToday = (
  year: number,
  month: number,
  schedule: IResolvedSchedule,
  calendar: IProductionCalendarMonth | null = null,
): number => {
  const now = new Date();
  const curYear = now.getFullYear();
  const curMonth = now.getMonth() + 1;

  if (year < curYear || (year === curYear && month < curMonth)) {
    return countNormHoursForSchedule(year, month, schedule, calendar);
  }
  if (year > curYear || (year === curYear && month > curMonth)) return 0;

  const today = now.getDate();
  let total = 0;
  for (let d = 1; d <= today; d++) {
    total += getDayNormHours(schedule, new Date(year, month - 1, d), calendar);
  }
  // Субботы 5+2 учитываются только на полный месяц; до сегодня — пропорционально не считаем
  return total;
};

/** Нужен ли СКУД-контроль для сотрудника в этот день */
export const needsSkudCheck = (
  schedule: IResolvedSchedule,
  date: Date,
  calendar: IProductionCalendarMonth | null = null,
): boolean => {
  if (!isWorkingDay(schedule, date, calendar)) return false;
  if (schedule.schedule_type === 'remote') return false;
  if (schedule.schedule_type === 'hybrid' && !isOfficeDay(schedule, date)) return false;
  return true;
};

/** Загружает месяц производственного календаря (null если нет записи) */
export const loadCalendarMonth = async (
  year: number,
  month: number,
): Promise<IProductionCalendarMonth | null> => {
  const { data } = await supabase
    .from('production_calendar')
    .select('year, month, norm_days, norm_hours, holidays, mandatory_holidays, pre_holidays')
    .eq('year', year)
    .eq('month', month)
    .maybeSingle();
  if (!data) return null;
  return {
    year: data.year as number,
    month: data.month as number,
    norm_days: Number(data.norm_days) || 0,
    norm_hours: Number(data.norm_hours) || 0,
    holidays: (data.holidays as string[]) || [],
    mandatory_holidays: (data.mandatory_holidays as string[]) || [],
    pre_holidays: (data.pre_holidays as string[]) || [],
  };
};

const extractWorkSchedule = (value: unknown): Record<string, unknown> | null => {
  if (!value) return null;
  if (Array.isArray(value)) return (value[0] as Record<string, unknown>) || null;
  return value as Record<string, unknown>;
};

const isAssignmentActiveOnDate = (
  effectiveFrom: string | null | undefined,
  effectiveTo: string | null | undefined,
  date: string,
): boolean => {
  if (!effectiveFrom || effectiveFrom > date) return false;
  return effectiveTo == null || effectiveTo >= date;
};

const iterateDates = (startDate: string, endDate: string, cb: (date: string) => void): void => {
  const cursor = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);

  while (cursor <= end) {
    cb(toISODate(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
};

interface IPickedAssignment {
  schedule: Record<string, unknown>;
  assignment_anchor_date: string | null;
}

const pickScheduleForDate = (
  rows: Record<string, unknown>[],
  date: string,
): IPickedAssignment | null => {
  for (const row of rows) {
    if (!isAssignmentActiveOnDate(row.effective_from as string | null | undefined, row.effective_to as string | null | undefined, date)) {
      continue;
    }
    const schedule = extractWorkSchedule(row.work_schedules);
    if (schedule) {
      return {
        schedule,
        assignment_anchor_date: (row.anchor_date as string | null | undefined) ?? null,
      };
    }
  }
  return null;
};

/** Resolve графика объекта на дату. Возвращает null, если для объекта нет назначения */
export const resolveObjectSchedule = async (
  objectId: string,
  date: string,
): Promise<IResolvedSchedule | null> => {
  const { data } = await supabase
    .from('object_schedule_assignments')
    .select('schedule_id, anchor_date, work_schedules(*)')
    .eq('object_id', objectId)
    .lte('effective_from', date)
    .or(`effective_to.is.null,effective_to.gte.${date}`)
    .order('effective_from', { ascending: false })
    .limit(1)
    .maybeSingle();

  const objectSchedule = extractWorkSchedule(data?.work_schedules);
  if (!objectSchedule) return null;
  const assignmentAnchor = (data?.anchor_date as string | null | undefined) ?? null;
  return mapToResolved(objectSchedule, 'object', assignmentAnchor);
};

/** Resolve графиков объектов по каждому дню периода. Возвращает только даты с объектным назначением */
export const resolveObjectSchedulesForPeriod = async (
  objectIds: string[],
  startDate: string,
  endDate: string,
): Promise<Map<string, Map<string, IResolvedSchedule>>> => {
  const result = new Map<string, Map<string, IResolvedSchedule>>();
  if (objectIds.length === 0) return result;

  const uniqueObjectIds = [...new Set(objectIds.filter(Boolean))];
  if (uniqueObjectIds.length === 0) return result;

  const { data } = await supabase
    .from('object_schedule_assignments')
    .select('object_id, effective_from, effective_to, anchor_date, work_schedules(*)')
    .in('object_id', uniqueObjectIds)
    .lte('effective_from', endDate)
    .or(`effective_to.is.null,effective_to.gte.${startDate}`)
    .order('effective_from', { ascending: false });

  const objectRows = new Map<string, Record<string, unknown>[]>();
  for (const row of (data || []) as Record<string, unknown>[]) {
    const objectId = String(row.object_id || '');
    if (!objectId) continue;
    const rows = objectRows.get(objectId) || [];
    rows.push(row);
    objectRows.set(objectId, rows);
  }

  for (const objectId of uniqueObjectIds) {
    const dailyMap = new Map<string, IResolvedSchedule>();
    const assignmentRows = objectRows.get(objectId) || [];

    iterateDates(startDate, endDate, (date) => {
      const picked = pickScheduleForDate(assignmentRows, date);
      if (picked) {
        dailyMap.set(date, mapToResolved(picked.schedule, 'object', picked.assignment_anchor_date));
      }
    });

    if (dailyMap.size > 0) {
      result.set(objectId, dailyMap);
    }
  }

  return result;
};

/** Resolve для одного сотрудника на дату. Каскад: employee → default */
export const resolveSchedule = async (
  employeeId: number,
  _departmentId: string | null,
  date: string,
): Promise<IResolvedSchedule> => {
  // 1. Проверить персональный график сотрудника
  const { data: empSched } = await supabase
    .from('employee_schedule_assignments')
    .select('schedule_id, anchor_date, work_schedules(*)')
    .eq('employee_id', employeeId)
    .lte('effective_from', date)
    .or(`effective_to.is.null,effective_to.gte.${date}`)
    .order('effective_from', { ascending: false })
    .limit(1)
    .maybeSingle();

  const employeeSchedule = extractWorkSchedule(empSched?.work_schedules);
  if (employeeSchedule) {
    const assignmentAnchor = (empSched?.anchor_date as string | null | undefined) ?? null;
    return mapToResolved(employeeSchedule, 'employee', assignmentAnchor);
  }

  // 2. Дефолт
  const { data: defaultSched } = await supabase
    .from('work_schedules')
    .select('*')
    .eq('is_default', true)
    .limit(1)
    .maybeSingle();

  if (defaultSched) {
    return mapToResolved(defaultSched as Record<string, unknown>, 'default');
  }

  return { ...DEFAULT_SCHEDULE };
};

/** Bulk resolve: employee → default, 2 параллельных запроса */
export const resolveSchedulesBulk = async (
  employees: { id: number; org_department_id?: string | null }[],
  date: string,
): Promise<Map<number, IResolvedSchedule>> => {
  const result = new Map<number, IResolvedSchedule>();
  if (employees.length === 0) return result;

  const employeeIds = employees.map(e => e.id);

  const [empSchedsRes, defaultRes] = await Promise.all([
    supabase
      .from('employee_schedule_assignments')
      .select('employee_id, effective_from, anchor_date, work_schedules(*)')
      .in('employee_id', employeeIds)
      .lte('effective_from', date)
      .or(`effective_to.is.null,effective_to.gte.${date}`)
      .order('effective_from', { ascending: false }),

    supabase
      .from('work_schedules')
      .select('*')
      .eq('is_default', true)
      .limit(1)
      .maybeSingle(),
  ]);

  const employeeMap = new Map<number, { schedule: Record<string, unknown>; anchor: string | null }>();
  for (const row of (empSchedsRes.data || []) as Record<string, unknown>[]) {
    const employeeId = row.employee_id as number;
    if (!employeeMap.has(employeeId)) {
      const schedule = extractWorkSchedule(row.work_schedules);
      if (schedule) {
        employeeMap.set(employeeId, {
          schedule,
          anchor: (row.anchor_date as string | null | undefined) ?? null,
        });
      }
    }
  }

  const defaultSched = defaultRes.data as Record<string, unknown> | null;

  for (const emp of employees) {
    const empEntry = employeeMap.get(emp.id);
    if (empEntry) {
      result.set(emp.id, mapToResolved(empEntry.schedule, 'employee', empEntry.anchor));
    } else if (defaultSched) {
      result.set(emp.id, mapToResolved(defaultSched, 'default'));
    } else {
      result.set(emp.id, { ...DEFAULT_SCHEDULE });
    }
  }

  return result;
};

/** Resolve графиков по каждому дню периода: employee → default */
export const resolveSchedulesForPeriod = async (
  employees: { id: number; org_department_id?: string | null }[],
  startDate: string,
  endDate: string,
): Promise<Map<number, Map<string, IResolvedSchedule>>> => {
  const result = new Map<number, Map<string, IResolvedSchedule>>();
  if (employees.length === 0) return result;

  const employeeIds = employees.map(e => e.id);

  const [empSchedsRes, defaultRes] = await Promise.all([
    supabase
      .from('employee_schedule_assignments')
      .select('employee_id, effective_from, effective_to, anchor_date, work_schedules(*)')
      .in('employee_id', employeeIds)
      .lte('effective_from', endDate)
      .or(`effective_to.is.null,effective_to.gte.${startDate}`)
      .order('effective_from', { ascending: false }),

    supabase
      .from('work_schedules')
      .select('*')
      .eq('is_default', true)
      .limit(1)
      .maybeSingle(),
  ]);

  const employeeRows = new Map<number, Record<string, unknown>[]>();
  for (const row of (empSchedsRes.data || []) as Record<string, unknown>[]) {
    const employeeId = row.employee_id as number;
    const rows = employeeRows.get(employeeId) || [];
    rows.push(row);
    employeeRows.set(employeeId, rows);
  }

  const defaultSchedule = defaultRes.data
    ? mapToResolved(defaultRes.data as Record<string, unknown>, 'default')
    : { ...DEFAULT_SCHEDULE };

  for (const employee of employees) {
    const dailyMap = new Map<string, IResolvedSchedule>();
    const employeeAssignments = employeeRows.get(employee.id) || [];

    iterateDates(startDate, endDate, (date) => {
      const picked = pickScheduleForDate(employeeAssignments, date);
      if (picked) {
        dailyMap.set(date, mapToResolved(picked.schedule, 'employee', picked.assignment_anchor_date));
        return;
      }
      dailyMap.set(date, defaultSchedule);
    });

    result.set(employee.id, dailyMap);
  }

  return result;
};

function parseCycleDays(value: unknown): ICycleDay[] | null {
  if (!Array.isArray(value)) return null;
  const result: ICycleDay[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const obj = item as Record<string, unknown>;
    const workHours = Number(obj.work_hours);
    if (!Number.isFinite(workHours)) return null;
    const slot: ICycleDay = { work_hours: workHours };
    if (typeof obj.work_start === 'string') slot.work_start = obj.work_start;
    if (typeof obj.work_end === 'string') slot.work_end = obj.work_end;
    if (obj.lunch_minutes != null && Number.isFinite(Number(obj.lunch_minutes))) {
      slot.lunch_minutes = Number(obj.lunch_minutes);
    }
    result.push(slot);
  }
  return result;
}

function mapToResolved(
  ws: Record<string, unknown>,
  source: 'object' | 'employee' | 'default',
  assignmentAnchorDate: string | null = null,
): IResolvedSchedule {
  const cycleLength = ws.cycle_length == null ? null : Number(ws.cycle_length);
  return {
    schedule_id: ws.id as string,
    schedule_type: (ws.schedule_type as ScheduleType) || 'office',
    work_start: (ws.work_start as string) || '09:00:00',
    work_end: (ws.work_end as string) || '18:00:00',
    work_hours: Number(ws.work_hours) || 8,
    work_days: (ws.work_days as number[]) || [1, 2, 3, 4, 5],
    office_days: (ws.office_days as number[] | null) || null,
    late_threshold_minutes: Number(ws.late_threshold_minutes) || 0,
    day_overrides: (ws.day_overrides as Record<string, IDayOverride> | null) || null,
    lunch_minutes: Number(ws.lunch_minutes) || 0,
    respects_holidays: ws.respects_holidays !== false,
    pattern_type: (ws.pattern_type as PatternType) || 'custom',
    expected_saturdays_per_month: Number(ws.expected_saturdays_per_month) || 0,
    full_day_threshold_minutes:
      ws.full_day_threshold_minutes == null ? null : Number(ws.full_day_threshold_minutes),
    weekend_full_day_threshold_minutes:
      ws.weekend_full_day_threshold_minutes == null ? null : Number(ws.weekend_full_day_threshold_minutes),
    cycle_length: Number.isFinite(cycleLength) ? (cycleLength as number) : null,
    cycle_days: parseCycleDays(ws.cycle_days),
    anchor_date: (ws.anchor_date as string | null) ?? null,
    assignment_anchor_date: assignmentAnchorDate,
    source,
  };
}
