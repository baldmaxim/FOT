import { supabase } from '../config/database.js';
import { resolveSchedulesBulk, isWorkingDay, needsSkudCheck, getScheduleForDate } from './schedule.service.js';
import { getInternalAccessPoints } from './skud-shared.service.js';
import type { IResolvedSchedule } from '../types/index.js';

interface IRawEvent {
  employee_id: number;
  event_date: string;
  event_time: string;
  direction: string | null;
  access_point: string | null;
}

export interface IExportEmployee {
  id: number;
  full_name: string;
  position_id: string | null;
  org_department_id: string | null;
}

export interface IDepartmentTimesheetData {
  departmentName: string;
  departmentId: string | null;
  isBrigade: boolean;
  employees: IExportEmployee[];
  schedulesMap: Map<number, IResolvedSchedule>;
  dataMap: Map<number, Map<string, { status: string; hours: number; corrected?: boolean }>>;
  posMap: Map<string, string>;
  year: number;
  mon: number;
  daysInMonth: number;
}

const BATCH = 500;

const calcPairMs = (evts: IRawEvent[]): number => {
  let total = 0;
  let entry: number | null = null;
  for (const evt of evts) {
    const [h, m, s] = evt.event_time.split(':').map(Number);
    const ms = (h * 3600 + m * 60 + (s || 0)) * 1000;
    if (evt.direction === 'entry') {
      if (entry === null) entry = ms;
    } else if (evt.direction === 'exit' && entry !== null) {
      total += ms - entry;
      entry = null;
    }
  }
  return total;
};

export async function fetchTimesheetDataForDepartment(
  month: string,
  departmentId: string | null,
): Promise<IDepartmentTimesheetData> {
  const [yearStr, monthStr] = month.split('-');
  const year = parseInt(yearStr);
  const mon = parseInt(monthStr);
  const startDate = `${month}-01`;
  const daysInMonth = new Date(year, mon, 0).getDate();
  const endDate = `${month}-${daysInMonth}`;

  // Имя отдела
  let departmentName = 'Все отделы';
  if (departmentId) {
    const { data: dept } = await supabase
      .from('org_departments')
      .select('name')
      .eq('id', departmentId)
      .single();
    if (dept?.name) departmentName = dept.name;
  }

  // Сотрудники
  let empQuery = supabase
    .from('employees')
    .select('id, full_name, position_id, org_department_id')
    .eq('employment_status', 'active')
    .eq('is_archived', false)
    .order('full_name');

  if (departmentId) {
    empQuery = empQuery.eq('org_department_id', departmentId);
  }

  const { data: employees } = await empQuery;
  const empArr: IExportEmployee[] = (employees || []).map(e => ({
    id: e.id as number,
    full_name: e.full_name as string,
    position_id: (e.position_id as string | null),
    org_department_id: (e.org_department_id as string | null),
  }));
  const employeeIds = empArr.map(e => e.id);

  // Графики
  const empList = empArr.map(e => ({ id: e.id, org_department_id: e.org_department_id }));
  const schedulesMap = await resolveSchedulesBulk(empList, startDate);

  // Internal access points
  const internalPoints = await getInternalAccessPoints();

  // SKUD events
  let rawEvents: IRawEvent[] = [];
  for (let i = 0; i < employeeIds.length; i += BATCH) {
    const batch = employeeIds.slice(i, i + BATCH);
    const { data: sd } = await supabase
      .from('skud_events')
      .select('employee_id, event_date, event_time, direction, access_point')
      .in('employee_id', batch)
      .gte('event_date', startDate)
      .lte('event_date', endDate)
      .order('event_time', { ascending: true });
    rawEvents.push(...(sd || []));
  }

  // Unmatched events by full_name
  const nameMap = new Map<string, number>();
  for (const emp of empArr) {
    if (emp.full_name) nameMap.set(emp.full_name.toLowerCase().trim(), emp.id);
  }
  const seenKeys = new Set(rawEvents.map(e => `${e.employee_id}_${e.event_date}_${e.event_time}`));

  if (nameMap.size > 0) {
    const { data: unmatched } = await supabase
      .from('skud_events')
      .select('id, physical_person, employee_id, event_date, event_time, direction, access_point')
      .is('employee_id', null)
      .gte('event_date', startDate)
      .lte('event_date', endDate)
      .order('event_time', { ascending: true })
      .limit(5000);

    for (const ev of unmatched || []) {
      const name = ((ev.physical_person as string) || '').toLowerCase().trim();
      const empId = nameMap.get(name);
      if (empId) {
        const dedupKey = `${empId}_${ev.event_date}_${ev.event_time}`;
        if (!seenKeys.has(dedupKey)) {
          rawEvents.push({
            employee_id: empId,
            event_date: ev.event_date as string,
            event_time: ev.event_time as string,
            direction: ev.direction as string | null,
            access_point: ev.access_point as string | null,
          });
          seenKeys.add(dedupKey);
        }
      }
    }
  }

  // Group events
  const eventsByKey = new Map<string, IRawEvent[]>();
  for (const evt of rawEvents) {
    const key = `${evt.employee_id}_${evt.event_date}`;
    if (!eventsByKey.has(key)) eventsByKey.set(key, []);
    eventsByKey.get(key)!.push(evt);
  }

  // dataMap: employee_id -> date -> { status, hours, corrected? }
  const dataMap = new Map<number, Map<string, { status: string; hours: number; corrected?: boolean }>>();

  // SKUD events
  for (const [, events] of eventsByKey) {
    const extEvents = events.filter(e => !e.access_point || !internalPoints.has(e.access_point));
    let totalMs = calcPairMs(extEvents);
    if (totalMs === 0 && events.length > 0) {
      totalMs = calcPairMs(events);
    }
    const totalHours = Math.round((totalMs / 3600000) * 100) / 100;
    const empId = events[0].employee_id;
    const date = events[0].event_date;
    const isPresent = totalHours > 0 || events.some(e => e.direction === 'entry');

    if (!dataMap.has(empId)) dataMap.set(empId, new Map());
    dataMap.get(empId)!.set(date, {
      status: isPresent ? 'work' : 'absent',
      hours: isPresent ? totalHours : 0,
    });
  }

  // Manual corrections override SKUD
  let manualEntries: Array<Record<string, unknown>> = [];
  for (let i = 0; i < employeeIds.length; i += BATCH) {
    const batch = employeeIds.slice(i, i + BATCH);
    const { data: md } = await supabase
      .from('tender_timesheet')
      .select('employee_id, work_date, status, hours_worked')
      .in('employee_id', batch)
      .gte('work_date', startDate)
      .lte('work_date', endDate);
    manualEntries.push(...(md || []));
  }

  for (const m of manualEntries) {
    const empId = m.employee_id as number;
    const date = m.work_date as string;
    if (!dataMap.has(empId)) dataMap.set(empId, new Map());
    dataMap.get(empId)!.set(date, {
      status: m.status as string,
      hours: typeof m.hours_worked === 'number' ? m.hours_worked : 0,
      corrected: true,
    });
  }

  // Автозаполнение remote/hybrid-remote дней
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  for (const empId of employeeIds) {
    const sched = schedulesMap.get(empId);
    if (!sched) continue;
    if (!dataMap.has(empId)) dataMap.set(empId, new Map());
    const empData = dataMap.get(empId)!;

    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(mon).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      if (dateStr > todayStr) continue;
      if (empData.has(dateStr)) continue;

      const dateObj = new Date(year, mon - 1, d);
      if (!isWorkingDay(sched, dateObj)) continue;
      if (!needsSkudCheck(sched, dateObj)) {
        empData.set(dateStr, { status: 'remote', hours: getScheduleForDate(sched, dateObj).work_hours });
      }
    }
  }

  // Positions
  const positionIds = [...new Set(empArr.map(e => e.position_id).filter(Boolean))] as string[];
  const posMap = new Map<string, string>();
  if (positionIds.length > 0) {
    const { data: positions } = await supabase.from('positions').select('id, name').in('id', positionIds);
    (positions || []).forEach((p: { id: string; name: string }) => posMap.set(p.id, p.name));
  }

  return {
    departmentName,
    departmentId,
    isBrigade: departmentName.toLowerCase().startsWith('бр.'),
    employees: empArr,
    schedulesMap,
    dataMap,
    posMap,
    year,
    mon,
    daysInMonth,
  };
}
