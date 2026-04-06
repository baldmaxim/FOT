/**
 * Сервис графиков работы: resolve (каскад employee → department → default), bulk, хелперы.
 */
import { supabase } from '../config/database.js';
import type { IResolvedSchedule, IDayOverride, ScheduleType } from '../types/index.js';

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
  source: 'default',
};

/** ISO day-of-week: 1=Пн..7=Вс */
const getISODow = (date: Date): number => {
  const d = date.getDay();
  return d === 0 ? 7 : d;
};

export const isWorkingDay = (schedule: IResolvedSchedule, date: Date): boolean =>
  schedule.work_days.includes(getISODow(date));

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

/** Считает рабочие дни в месяце по графику */
export const countWorkingDaysForSchedule = (year: number, month: number, schedule: IResolvedSchedule): number => {
  const daysInMonth = new Date(year, month, 0).getDate();
  let count = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    if (isWorkingDay(schedule, new Date(year, month - 1, d))) count++;
  }
  return count;
};

/** Считает рабочие дни до сегодня включительно */
export const countWorkingDaysUpToToday = (year: number, month: number, schedule: IResolvedSchedule): number => {
  const now = new Date();
  const curYear = now.getFullYear();
  const curMonth = now.getMonth() + 1;

  if (year < curYear || (year === curYear && month < curMonth)) {
    return countWorkingDaysForSchedule(year, month, schedule);
  }
  if (year > curYear || (year === curYear && month > curMonth)) return 0;

  const today = now.getDate();
  let count = 0;
  for (let d = 1; d <= today; d++) {
    if (isWorkingDay(schedule, new Date(year, month - 1, d))) count++;
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

/** Считает норму часов в месяце по графику с учётом day_overrides */
export const countNormHoursForSchedule = (year: number, month: number, schedule: IResolvedSchedule): number => {
  const daysInMonth = new Date(year, month, 0).getDate();
  let total = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, month - 1, d);
    if (!isWorkingDay(schedule, date)) continue;
    total += getScheduleForDate(schedule, date).work_hours;
  }
  return total;
};

/** Считает норму часов до сегодня включительно */
export const countNormHoursUpToToday = (year: number, month: number, schedule: IResolvedSchedule): number => {
  const now = new Date();
  const curYear = now.getFullYear();
  const curMonth = now.getMonth() + 1;

  if (year < curYear || (year === curYear && month < curMonth)) {
    return countNormHoursForSchedule(year, month, schedule);
  }
  if (year > curYear || (year === curYear && month > curMonth)) return 0;

  const today = now.getDate();
  let total = 0;
  for (let d = 1; d <= today; d++) {
    const date = new Date(year, month - 1, d);
    if (!isWorkingDay(schedule, date)) continue;
    total += getScheduleForDate(schedule, date).work_hours;
  }
  return total;
};

/** Нужен ли СКУД-контроль для сотрудника в этот день */
export const needsSkudCheck = (schedule: IResolvedSchedule, date: Date): boolean => {
  if (!isWorkingDay(schedule, date)) return false;
  if (schedule.schedule_type === 'remote') return false;
  if (schedule.schedule_type === 'hybrid' && !isOfficeDay(schedule, date)) return false;
  return true;
};

/** Resolve для одного сотрудника на дату */
export const resolveSchedule = async (
  employeeId: number,
  departmentId: string | null,
  date: string,
): Promise<IResolvedSchedule> => {
  // 1. Проверить employee_schedules
  const { data: empSched } = await supabase
    .from('employee_schedules')
    .select('schedule_id, work_schedules(*)')
    .eq('employee_id', employeeId)
    .lte('effective_from', date)
    .or(`effective_to.is.null,effective_to.gte.${date}`)
    .order('effective_from', { ascending: false })
    .limit(1)
    .single();

  if (empSched?.work_schedules) {
    const ws = Array.isArray(empSched.work_schedules) ? empSched.work_schedules[0] : empSched.work_schedules;
    if (ws) return mapToResolved(ws as Record<string, unknown>, 'employee');
  }

  // 2. Проверить department_schedules
  if (departmentId) {
    const { data: deptSched } = await supabase
      .from('department_schedules')
      .select('schedule_id, work_schedules(*)')
      .eq('department_id', departmentId)
      .lte('effective_from', date)
      .or(`effective_to.is.null,effective_to.gte.${date}`)
      .order('effective_from', { ascending: false })
      .limit(1)
      .single();

    if (deptSched?.work_schedules) {
      const ws = Array.isArray(deptSched.work_schedules) ? deptSched.work_schedules[0] : deptSched.work_schedules;
      if (ws) return mapToResolved(ws as Record<string, unknown>, 'department');
    }
  }

  // 3. Дефолт
  const { data: defaultSched } = await supabase
    .from('work_schedules')
    .select('*')
    .eq('is_default', true)
    .limit(1)
    .single();

  if (defaultSched) {
    return mapToResolved(defaultSched as Record<string, unknown>, 'default');
  }

  return { ...DEFAULT_SCHEDULE };
};

/** Bulk resolve для массива сотрудников — оптимизировано через 3 запроса */
export const resolveSchedulesBulk = async (
  employees: { id: number; org_department_id: string | null }[],
  date: string,
): Promise<Map<number, IResolvedSchedule>> => {
  const result = new Map<number, IResolvedSchedule>();
  if (employees.length === 0) return result;

  const employeeIds = employees.map(e => e.id);
  const departmentIds = [...new Set(employees.map(e => e.org_department_id).filter(Boolean))] as string[];

  // Параллельные запросы
  const [empSchedsRes, deptSchedsRes, defaultRes] = await Promise.all([
    supabase
      .from('employee_schedules')
      .select('employee_id, effective_from, work_schedules(*)')
      .in('employee_id', employeeIds)
      .lte('effective_from', date)
      .or(`effective_to.is.null,effective_to.gte.${date}`)
      .order('effective_from', { ascending: false }),

    departmentIds.length > 0
      ? supabase
          .from('department_schedules')
          .select('department_id, effective_from, work_schedules(*)')
          .in('department_id', departmentIds)
          .lte('effective_from', date)
          .or(`effective_to.is.null,effective_to.gte.${date}`)
          .order('effective_from', { ascending: false })
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),

    supabase
      .from('work_schedules')
      .select('*')
      .eq('is_default', true)
      .limit(1)
      .single(),
  ]);

  // Маппинг employee_id → schedule (берём первый = последний по effective_from)
  const empMap = new Map<number, Record<string, unknown>>();
  for (const row of (empSchedsRes.data || []) as Record<string, unknown>[]) {
    const empId = row.employee_id as number;
    if (!empMap.has(empId) && row.work_schedules) {
      empMap.set(empId, row.work_schedules as Record<string, unknown>);
    }
  }

  // Маппинг department_id → schedule
  const deptMap = new Map<string, Record<string, unknown>>();
  for (const row of (deptSchedsRes.data || []) as Record<string, unknown>[]) {
    const deptId = row.department_id as string;
    if (!deptMap.has(deptId) && row.work_schedules) {
      deptMap.set(deptId, row.work_schedules as Record<string, unknown>);
    }
  }

  const defaultSched = defaultRes.data as Record<string, unknown> | null;

  // Resolve для каждого
  for (const emp of employees) {
    if (empMap.has(emp.id)) {
      result.set(emp.id, mapToResolved(empMap.get(emp.id)!, 'employee'));
    } else if (emp.org_department_id && deptMap.has(emp.org_department_id)) {
      result.set(emp.id, mapToResolved(deptMap.get(emp.org_department_id)!, 'department'));
    } else if (defaultSched) {
      result.set(emp.id, mapToResolved(defaultSched, 'default'));
    } else {
      result.set(emp.id, { ...DEFAULT_SCHEDULE });
    }
  }

  return result;
};

function mapToResolved(
  ws: Record<string, unknown>,
  source: 'employee' | 'department' | 'default',
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
    source,
  };
}
