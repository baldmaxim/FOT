/**
 * Сервис графиков работы: resolve (каскад employee → department → category → default),
 * bulk, хелперы с учётом производственного календаря и категорий труда.
 */
import { supabase } from '../config/database.js';
import type {
  IResolvedSchedule,
  IDayOverride,
  ScheduleType,
  PatternType,
  WorkCategory,
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

export const isWorkingDay = (
  schedule: IResolvedSchedule,
  date: Date,
  calendar: IProductionCalendarMonth | null = null,
): boolean => {
  if (isHoliday(date, schedule, calendar)) return false;
  return schedule.work_days.includes(getISODow(date));
};

/** Возвращает work_start/work_end/work_hours для конкретного дня с учётом day_overrides */
export const getScheduleForDate = (schedule: IResolvedSchedule, date: Date): IDayScheduleParams => {
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

/** Чистое рабочее время = длина смены − обед */
export const getNetHours = (schedule: Pick<IResolvedSchedule, 'work_hours' | 'lunch_minutes'>): number => {
  return Math.max(0, schedule.work_hours - schedule.lunch_minutes / 60);
};

/** Порог полного дня для конкретной даты: как в UI табеля */
export const getFullDayThresholdHoursForDate = (
  schedule: IResolvedSchedule,
  date: Date,
  calendar: IProductionCalendarMonth | null = null,
): number => {
  const isDayOff = !isWorkingDay(schedule, date, calendar);
  const daySchedule = getScheduleForDate(schedule, date);
  const netFallbackMinutes = Math.max(0, Math.round(daySchedule.work_hours * 60) - (schedule.lunch_minutes || 0));

  if (isDayOff) {
    if (schedule.weekend_full_day_threshold_minutes != null) {
      return schedule.weekend_full_day_threshold_minutes / 60;
    }
    if (schedule.full_day_threshold_minutes != null) {
      return schedule.full_day_threshold_minutes / 60;
    }
    return netFallbackMinutes / 60;
  }

  if (schedule.full_day_threshold_minutes != null) {
    return schedule.full_day_threshold_minutes / 60;
  }

  return netFallbackMinutes / 60;
};

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
    const date = new Date(year, month - 1, d);
    if (!isWorkingDay(schedule, date, calendar)) continue;
    total += getScheduleForDate(schedule, date).work_hours;
  }
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
    const date = new Date(year, month - 1, d);
    if (!isWorkingDay(schedule, date, calendar)) continue;
    total += getScheduleForDate(schedule, date).work_hours;
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
    .select('year, month, norm_days, norm_hours, holidays, mandatory_holidays')
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

const pickScheduleForDate = (
  rows: Record<string, unknown>[],
  date: string,
): Record<string, unknown> | null => {
  for (const row of rows) {
    if (!isAssignmentActiveOnDate(row.effective_from as string | null | undefined, row.effective_to as string | null | undefined, date)) {
      continue;
    }
    const schedule = extractWorkSchedule(row.work_schedules);
    if (schedule) return schedule;
  }
  return null;
};

/** Resolve для одного сотрудника на дату. Каскад: employee → category → default */
export const resolveSchedule = async (
  employeeId: number,
  _departmentId: string | null,
  date: string,
  workCategory: WorkCategory | null = null,
): Promise<IResolvedSchedule> => {
  // 1. Проверить персональный график сотрудника
  const { data: empSched } = await supabase
    .from('employee_schedule_assignments')
    .select('schedule_id, work_schedules(*)')
    .eq('employee_id', employeeId)
    .lte('effective_from', date)
    .or(`effective_to.is.null,effective_to.gte.${date}`)
    .order('effective_from', { ascending: false })
    .limit(1)
    .maybeSingle();

  const employeeSchedule = extractWorkSchedule(empSched?.work_schedules);
  if (employeeSchedule) {
    return mapToResolved(employeeSchedule, 'employee');
  }

  // 2. Проверить category_schedules
  if (workCategory) {
    const { data: catSched } = await supabase
      .from('category_schedules')
      .select('schedule_id, work_schedules(*)')
      .eq('category', workCategory)
      .lte('effective_from', date)
      .or(`effective_to.is.null,effective_to.gte.${date}`)
      .order('effective_from', { ascending: false })
      .limit(1)
      .maybeSingle();

    const categorySchedule = extractWorkSchedule(catSched?.work_schedules);
    if (categorySchedule) {
      return mapToResolved(categorySchedule, 'category');
    }
  }

  // 3. Дефолт
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

/** Bulk resolve: employee → category → default, 3 параллельных запроса */
export const resolveSchedulesBulk = async (
  employees: { id: number; org_department_id?: string | null; work_category?: WorkCategory | null }[],
  date: string,
): Promise<Map<number, IResolvedSchedule>> => {
  const result = new Map<number, IResolvedSchedule>();
  if (employees.length === 0) return result;

  const employeeIds = employees.map(e => e.id);
  const categories = [...new Set(employees.map(e => e.work_category).filter(Boolean))] as WorkCategory[];

  const [empSchedsRes, catSchedsRes, defaultRes] = await Promise.all([
    supabase
      .from('employee_schedule_assignments')
      .select('employee_id, effective_from, work_schedules(*)')
      .in('employee_id', employeeIds)
      .lte('effective_from', date)
      .or(`effective_to.is.null,effective_to.gte.${date}`)
      .order('effective_from', { ascending: false }),

    categories.length > 0
      ? supabase
          .from('category_schedules')
          .select('category, effective_from, work_schedules(*)')
          .in('category', categories)
          .lte('effective_from', date)
          .or(`effective_to.is.null,effective_to.gte.${date}`)
          .order('effective_from', { ascending: false })
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),

    supabase
      .from('work_schedules')
      .select('*')
      .eq('is_default', true)
      .limit(1)
      .maybeSingle(),
  ]);

  const employeeMap = new Map<number, Record<string, unknown>>();
  for (const row of (empSchedsRes.data || []) as Record<string, unknown>[]) {
    const employeeId = row.employee_id as number;
    if (!employeeMap.has(employeeId)) {
      const schedule = extractWorkSchedule(row.work_schedules);
      if (schedule) employeeMap.set(employeeId, schedule);
    }
  }

  const catMap = new Map<string, Record<string, unknown>>();
  for (const row of (catSchedsRes.data || []) as Record<string, unknown>[]) {
    const cat = row.category as string;
    if (!catMap.has(cat)) {
      const schedule = extractWorkSchedule(row.work_schedules);
      if (schedule) catMap.set(cat, schedule);
    }
  }

  const defaultSched = defaultRes.data as Record<string, unknown> | null;

  for (const emp of employees) {
    if (employeeMap.has(emp.id)) {
      result.set(emp.id, mapToResolved(employeeMap.get(emp.id)!, 'employee'));
    } else if (emp.work_category && catMap.has(emp.work_category)) {
      result.set(emp.id, mapToResolved(catMap.get(emp.work_category)!, 'category'));
    } else if (defaultSched) {
      result.set(emp.id, mapToResolved(defaultSched, 'default'));
    } else {
      result.set(emp.id, { ...DEFAULT_SCHEDULE });
    }
  }

  return result;
};

/** Resolve графиков по каждому дню периода: employee -> category -> default */
export const resolveSchedulesForPeriod = async (
  employees: { id: number; org_department_id?: string | null; work_category?: WorkCategory | null }[],
  startDate: string,
  endDate: string,
): Promise<Map<number, Map<string, IResolvedSchedule>>> => {
  const result = new Map<number, Map<string, IResolvedSchedule>>();
  if (employees.length === 0) return result;

  const employeeIds = employees.map(e => e.id);
  const categories = [...new Set(employees.map(e => e.work_category).filter(Boolean))] as WorkCategory[];

  const [empSchedsRes, catSchedsRes, defaultRes] = await Promise.all([
    supabase
      .from('employee_schedule_assignments')
      .select('employee_id, effective_from, effective_to, work_schedules(*)')
      .in('employee_id', employeeIds)
      .lte('effective_from', endDate)
      .or(`effective_to.is.null,effective_to.gte.${startDate}`)
      .order('effective_from', { ascending: false }),

    categories.length > 0
      ? supabase
          .from('category_schedules')
          .select('category, effective_from, effective_to, work_schedules(*)')
          .in('category', categories)
          .lte('effective_from', endDate)
          .or(`effective_to.is.null,effective_to.gte.${startDate}`)
          .order('effective_from', { ascending: false })
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),

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

  const categoryRows = new Map<string, Record<string, unknown>[]>();
  for (const row of (catSchedsRes.data || []) as Record<string, unknown>[]) {
    const category = row.category as string;
    const rows = categoryRows.get(category) || [];
    rows.push(row);
    categoryRows.set(category, rows);
  }

  const defaultSchedule = defaultRes.data
    ? mapToResolved(defaultRes.data as Record<string, unknown>, 'default')
    : { ...DEFAULT_SCHEDULE };

  for (const employee of employees) {
    const dailyMap = new Map<string, IResolvedSchedule>();
    const employeeAssignments = employeeRows.get(employee.id) || [];
    const categoryAssignments = employee.work_category ? (categoryRows.get(employee.work_category) || []) : [];

    iterateDates(startDate, endDate, (date) => {
      const employeeSchedule = pickScheduleForDate(employeeAssignments, date);
      if (employeeSchedule) {
        dailyMap.set(date, mapToResolved(employeeSchedule, 'employee'));
        return;
      }

      const categorySchedule = pickScheduleForDate(categoryAssignments, date);
      if (categorySchedule) {
        dailyMap.set(date, mapToResolved(categorySchedule, 'category'));
        return;
      }

      dailyMap.set(date, defaultSchedule);
    });

    result.set(employee.id, dailyMap);
  }

  return result;
};

function mapToResolved(
  ws: Record<string, unknown>,
  source: 'employee' | 'category' | 'default',
): IResolvedSchedule {
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
    source,
  };
}
