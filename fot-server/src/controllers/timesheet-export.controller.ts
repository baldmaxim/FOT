import { Response } from 'express';
import XLSX from 'xlsx';
import { supabase } from '../config/database.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { resolveSchedulesBulk, isWorkingDay, needsSkudCheck, countWorkingDaysForSchedule } from '../services/schedule.service.js';
import { getInternalAccessPoints } from '../services/skud-shared.service.js';

/** GET /api/timesheet/export?month=YYYY-MM&department_id=... */
export async function exportTimesheet(req: AuthenticatedRequest, res: Response) {
  try {
    const { month, department_id } = req.query;

    if (!month || typeof month !== 'string') {
      return res.status(400).json({ success: false, error: 'Параметр month обязателен' });
    }

    const [yearStr, monthStr] = month.split('-');
    const year = parseInt(yearStr);
    const mon = parseInt(monthStr);
    const startDate = `${month}-01`;
    const daysInMonth = new Date(year, mon, 0).getDate();
    const endDate = `${month}-${daysInMonth}`;

    let empQuery = supabase
      .from('employees')
      .select('id, full_name, position_id, org_department_id')
      .eq('employment_status', 'active')
      .eq('is_archived', false)
      .order('full_name');

    if (department_id && typeof department_id === 'string') {
      empQuery = empQuery.eq('org_department_id', department_id);
    }

    const { data: employees } = await empQuery;
    const employeeIds = (employees || []).map(e => e.id);

    // Resolve графики
    const empList = (employees || []).map(e => ({ id: e.id as number, org_department_id: (e.org_department_id as string | null) }));
    const schedulesMap = await resolveSchedulesBulk(empList, startDate);

    // Fetch internal access points (из кэша)
    const BATCH = 500;
    const expInternalPoints = await getInternalAccessPoints();

    // Fetch raw SKUD events
    interface IExpRawEvent {
      employee_id: number;
      event_date: string;
      event_time: string;
      direction: string | null;
      access_point: string | null;
    }
    let expRawEvents: IExpRawEvent[] = [];
    for (let i = 0; i < employeeIds.length; i += BATCH) {
      const batch = employeeIds.slice(i, i + BATCH);
      const { data: sd } = await supabase
        .from('skud_events')
        .select('employee_id, event_date, event_time, direction, access_point')
        .in('employee_id', batch)
        .gte('event_date', startDate)
        .lte('event_date', endDate)
        .order('event_time', { ascending: true });
      expRawEvents.push(...(sd || []));
    }

    // Also find unmatched events by full_name
    const expNameMap = new Map<string, number>();
    for (const emp of employees || []) {
      if (emp.full_name) expNameMap.set(emp.full_name.toLowerCase().trim(), emp.id);
    }
    const expSeenKeys = new Set(expRawEvents.map(e => `${e.employee_id}_${e.event_date}_${e.event_time}`));

    if (expNameMap.size > 0) {
      const { data: unmatchedExp } = await supabase
        .from('skud_events')
        .select('id, physical_person, employee_id, event_date, event_time, direction, access_point')
        .is('employee_id', null)
        .gte('event_date', startDate)
        .lte('event_date', endDate)
        .order('event_time', { ascending: true })
        .limit(5000);

      for (const ev of unmatchedExp || []) {
        const name = ((ev.physical_person as string) || '').toLowerCase().trim();
        const empId = expNameMap.get(name);
        if (empId) {
          const dedupKey = `${empId}_${ev.event_date}_${ev.event_time}`;
          if (!expSeenKeys.has(dedupKey)) {
            expRawEvents.push({
              employee_id: empId,
              event_date: ev.event_date as string,
              event_time: ev.event_time as string,
              direction: ev.direction as string | null,
              access_point: ev.access_point as string | null,
            });
            expSeenKeys.add(dedupKey);
          }
        }
      }
    }

    // Group events (keep all for fallback)
    const expEventsByKey = new Map<string, IExpRawEvent[]>();
    for (const evt of expRawEvents) {
      const key = `${evt.employee_id}_${evt.event_date}`;
      if (!expEventsByKey.has(key)) expEventsByKey.set(key, []);
      expEventsByKey.get(key)!.push(evt);
    }

    // Fetch manual entries
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

    // Merge into map: employee_id -> date -> { status, hours }
    const dataMap = new Map<number, Map<string, { status: string; hours: number }>>();

    // Helper: calc pair ms
    const calcExpPairMs = (evts: IExpRawEvent[]): number => {
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

    // SKUD events first
    for (const [_key, events] of expEventsByKey) {
      // Filter internal; fallback to all if external gives 0
      const extEvents = events.filter(e => !e.access_point || !expInternalPoints.has(e.access_point));
      let totalMs = calcExpPairMs(extEvents);
      if (totalMs === 0 && events.length > 0) {
        totalMs = calcExpPairMs(events);
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
    for (const m of manualEntries) {
      const empId = m.employee_id as number;
      const date = m.work_date as string;
      if (!dataMap.has(empId)) dataMap.set(empId, new Map());
      dataMap.get(empId)!.set(date, {
        status: m.status as string,
        hours: typeof m.hours_worked === 'number' ? m.hours_worked : 0,
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
          empData.set(dateStr, { status: 'remote', hours: sched.work_hours });
        }
      }
    }

    // Position names
    const positionIds = [...new Set((employees || []).map(e => e.position_id).filter(Boolean))];
    const posMap = new Map<string, string>();
    if (positionIds.length > 0) {
      const { data: positions } = await supabase.from('positions').select('id, name').in('id', positionIds);
      (positions || []).forEach((p: { id: string; name: string }) => posMap.set(p.id, p.name));
    }

    const statusLabels: Record<string, string> = {
      work: '', sick: 'Б', vacation: 'О', absent: 'Н',
      business_trip: 'К', dayoff: 'В', remote: 'У', unpaid: 'НО', manual: '',
    };

    const formatHM = (h: number): string => {
      const hrs = Math.floor(h);
      const mins = Math.round((h - hrs) * 60);
      return mins === 0 ? `${hrs}ч` : `${hrs}ч ${mins}м`;
    };

    const monthNames = ['', 'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
      'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
    const dayNames = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

    // Build worksheet data
    const wsData: (string | number | null)[][] = [];

    // Title row
    wsData.push([`Табель учёта рабочего времени — ${monthNames[mon]} ${year}`]);

    // Header row 1: numbers
    const headerRow1: (string | number | null)[] = ['№', 'Сотрудник', 'Должность'];
    for (let d = 1; d <= daysInMonth; d++) headerRow1.push(d);
    headerRow1.push('Факт', 'Норма', '+/−');
    wsData.push(headerRow1);

    // Header row 2: day names
    const headerRow2: (string | number | null)[] = ['', '', ''];
    for (let d = 1; d <= daysInMonth; d++) {
      const dayOfWeek = new Date(year, mon - 1, d).getDay();
      headerRow2.push(dayNames[dayOfWeek]);
    }
    headerRow2.push('', '', '');
    wsData.push(headerRow2);

    // Employee rows
    (employees || []).forEach((emp, idx) => {
      const sched = schedulesMap.get(emp.id);
      const empNormHours = sched
        ? countWorkingDaysForSchedule(year, mon, sched) * sched.work_hours
        : new Date(year, mon, 0).getDate() * 8; // fallback

      const row: (string | number | null)[] = [
        idx + 1,
        emp.full_name,
        emp.position_id ? posMap.get(emp.position_id) || '' : '',
      ];

      let factHours = 0;
      const empData = dataMap.get(emp.id);

      for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${year}-${String(mon).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const dateObj = new Date(year, mon - 1, d);

        // Выходной определяется по графику сотрудника
        const isDayOff = sched ? !isWorkingDay(sched, dateObj) : (dateObj.getDay() === 0 || dateObj.getDay() === 6);

        if (isDayOff) {
          row.push('—');
          continue;
        }

        const entry = empData?.get(dateStr);
        if (!entry) {
          row.push('');
          continue;
        }

        const label = statusLabels[entry.status];
        if (label) {
          row.push(label);
        } else {
          row.push(formatHM(entry.hours));
        }
        factHours += entry.hours;
      }

      const diff = factHours - empNormHours;
      row.push(formatHM(factHours), formatHM(empNormHours), `${diff >= 0 ? '+' : '−'}${formatHM(Math.abs(diff))}`);
      wsData.push(row);
    });

    // Create workbook
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(wsData);

    // Column widths
    ws['!cols'] = [
      { wch: 4 },   // №
      { wch: 30 },  // Сотрудник
      { wch: 25 },  // Должность
      ...Array(daysInMonth).fill({ wch: 6 }),
      { wch: 10 },  // Факт
      { wch: 10 },  // Норма
      { wch: 10 },  // +/−
    ];

    // Merge title row
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: daysInMonth + 5 } }];

    XLSX.utils.book_append_sheet(wb, ws, 'Табель');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="timesheet-${month}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (err) {
    console.error('timesheet.export error:', err);
    res.status(500).json({ success: false, error: 'Ошибка экспорта' });
  }
}
