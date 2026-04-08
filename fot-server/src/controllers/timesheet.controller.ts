import { Response } from 'express';
import { z } from 'zod';
import { supabase } from '../config/database.js';
import { auditService } from '../services/audit.service.js';
import type { AuthenticatedRequest, TimeStatus, IResolvedSchedule } from '../types/index.js';
import { exportTimesheet } from './timesheet-export.controller.js';
import { exportTimesheetMass } from './timesheet-mass-export.controller.js';
import { resolveSchedulesBulk, isWorkingDay, needsSkudCheck, countWorkingDaysUpToToday as schedWorkingDaysUpToToday, countNormHoursUpToToday, getScheduleForDate, getEffectiveLateThreshold } from '../services/schedule.service.js';
import { getInternalAccessPoints } from '../services/skud-shared.service.js';

const validStatuses: TimeStatus[] = ['work', 'vacation', 'dayoff', 'remote', 'unpaid', 'absent', 'sick', 'business_trip', 'manual'];

const createEntrySchema = z.object({
  employee_id: z.number().int().positive(),
  work_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: z.enum(validStatuses as [string, ...string[]]),
  hours_worked: z.number().min(0).max(24).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});

const updateEntrySchema = z.object({
  status: z.enum(validStatuses as [string, ...string[]]).optional(),
  hours_worked: z.number().min(0).max(24).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});

function getWorkingDaysInMonth(year: number, month: number): number {
  const daysInMonth = new Date(year, month, 0).getDate();
  let count = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const day = new Date(year, month - 1, d).getDay();
    if (day !== 0 && day !== 6) count++;
  }
  return count;
}

function getWorkingDaysUpToToday(year: number, month: number): number {
  const now = new Date();
  const curYear = now.getFullYear();
  const curMonth = now.getMonth() + 1;

  if (year < curYear || (year === curYear && month < curMonth)) {
    return getWorkingDaysInMonth(year, month);
  }
  if (year > curYear || (year === curYear && month > curMonth)) {
    return 0;
  }
  const today = now.getDate();
  let count = 0;
  for (let d = 1; d <= today; d++) {
    const day = new Date(year, month - 1, d).getDay();
    if (day !== 0 && day !== 6) count++;
  }
  return count;
}

export const timesheetController = {
  /** GET /api/timesheet?month=YYYY-MM&department_id=... */
  async getAll(req: AuthenticatedRequest, res: Response) {
    try {
      const { month } = req.query;
      // Для header: принудительно фильтруем по его отделу
      const department_id = req.user.position_type === 'header' && req.user.department_id
        ? req.user.department_id
        : req.query.department_id;

      if (!month || typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({ success: false, error: 'Параметр month обязателен (формат YYYY-MM)' });
      }

      const [yearStr, monthStr] = month.split('-');
      const year = parseInt(yearStr);
      const mon = parseInt(monthStr);
      const startDate = `${month}-01`;
      const endDate = `${month}-${new Date(year, mon, 0).getDate()}`;

      const hasDeptFilter = department_id && typeof department_id === 'string';

      if (!hasDeptFilter) {
        return res.json({
          success: true,
          data: {
            employees: [],
            entries: [],
            stats: { employeeCount: 0, workingDays: getWorkingDaysUpToToday(year, mon), normHours: getWorkingDaysUpToToday(year, mon) * 8, actualHours: 0, deviations: { late: 0, absent: 0, sick: 0 } },
          },
        });
      }

      // Fetch employees
      let empQuery = supabase
        .from('employees')
        .select('id, full_name, position_id, org_department_id, employment_status')
        .eq('employment_status', 'active')
        .eq('is_archived', false)
        .order('full_name');

      if (hasDeptFilter) {
        empQuery = empQuery.eq('org_department_id', department_id as string);
      }

      const { data: employees, error: empError } = await empQuery;
      if (empError) throw empError;

      const employeeIds = (employees || []).map(e => e.id);

      // Resolve графики для всех сотрудников
      const empList = (employees || []).map(e => ({ id: e.id as number, org_department_id: (e.org_department_id as string | null) }));
      const schedulesMap = await resolveSchedulesBulk(empList, startDate);

      // Fetch position names
      const positionIds = [...new Set((employees || []).map(e => e.position_id).filter(Boolean))];
      const posMap = new Map<string, string>();
      if (positionIds.length > 0) {
        const { data: positions } = await supabase
          .from('positions')
          .select('id, name')
          .in('id', positionIds);
        (positions || []).forEach((p: { id: string; name: string }) => posMap.set(p.id, p.name));
      }

      const BATCH_SIZE = 500;

      // Load internal access points for filtering (из кэша)
      const internalPoints = await getInternalAccessPoints();

      // Fetch raw SKUD events
      interface IRawEvent {
        employee_id: number;
        event_date: string;
        event_time: string;
        direction: string | null;
        access_point: string | null;
      }
      let rawEvents: IRawEvent[] = [];
      for (let i = 0; i < employeeIds.length; i += BATCH_SIZE) {
        const batch = employeeIds.slice(i, i + BATCH_SIZE);
        const { data, error } = await supabase
          .from('skud_events')
          .select('employee_id, event_date, event_time, direction, access_point')
          .in('employee_id', batch)
          .gte('event_date', startDate)
          .lte('event_date', endDate)
          .order('event_time', { ascending: true });
        if (error) throw error;
        rawEvents.push(...(data || []));
      }

      // Also find unmatched events (employee_id IS NULL) by full_name
      const empNameMap = new Map<string, number>();
      for (const emp of employees || []) {
        if (emp.full_name) empNameMap.set(emp.full_name.toLowerCase().trim(), emp.id);
      }
      const seenEventIds = new Set(rawEvents.map(e => `${e.employee_id}_${e.event_date}_${e.event_time}`));

      if (empNameMap.size > 0) {
        const unmatchedQuery = supabase
          .from('skud_events')
          .select('id, physical_person, employee_id, event_date, event_time, direction, access_point')
          .is('employee_id', null)
          .gte('event_date', startDate)
          .lte('event_date', endDate)
          .order('event_time', { ascending: true })
          .limit(5000);

        const { data: unmatchedEvents } = await unmatchedQuery;
        const idsToBackfill: { id: number; empId: number }[] = [];

        for (const ev of unmatchedEvents || []) {
          const name = ((ev.physical_person as string) || '').toLowerCase().trim();
          const empId = empNameMap.get(name);
          if (empId) {
            const dedupKey = `${empId}_${ev.event_date}_${ev.event_time}`;
            if (!seenEventIds.has(dedupKey)) {
              rawEvents.push({
                employee_id: empId,
                event_date: ev.event_date as string,
                event_time: ev.event_time as string,
                direction: ev.direction as string | null,
                access_point: ev.access_point as string | null,
              });
              seenEventIds.add(dedupKey);
            }
            idsToBackfill.push({ id: ev.id as number, empId });
          }
        }

        // Backfill employee_id in background
        if (idsToBackfill.length > 0) {
          const ids = idsToBackfill.map(x => x.id);
          const empIds = idsToBackfill.map(x => x.empId);
          Promise.resolve(supabase.rpc('bulk_update_employee_ids', {
            p_event_ids: ids,
            p_employee_ids: empIds,
          })).then(() => {
            console.log(`[timesheet] backfilled employee_id on ${idsToBackfill.length} events`);
          }).catch((err: unknown) => console.error('[timesheet] backfill failed:', err));
        }
      }

      // Group events by employee_id + date and compute first_entry, last_exit, total_hours
      const skudMap = new Map<string, { employee_id: number; date: string; first_entry: string | null; last_exit: string | null; total_hours: number }>();

      // Group events
      const eventsByKey = new Map<string, IRawEvent[]>();
      for (const evt of rawEvents) {
        const key = `${evt.employee_id}_${evt.event_date}`;
        if (!eventsByKey.has(key)) eventsByKey.set(key, []);
        eventsByKey.get(key)!.push(evt);
      }

      // Helper: московское время (события СКУД в MSK)
      const getMoscowNow = (): { dateStr: string; timeMs: number } => {
        const msk = new Date().toLocaleString('en-US', { timeZone: 'Europe/Moscow' });
        const d = new Date(msk);
        const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const timeMs = (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) * 1000;
        return { dateStr, timeMs };
      };
      const mskNow = getMoscowNow();

      // Helper: calculate total ms from entry/exit pairs
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
        // Если остался открытый вход (сотрудник на месте) и это сегодня — считаем до текущего времени (MSK)
        if (entry !== null && evts.length > 0 && evts[0].event_date === mskNow.dateStr) {
          if (mskNow.timeMs > entry) {
            total += mskNow.timeMs - entry;
          }
        }
        return total;
      };

      for (const [key, events] of eventsByKey) {
        // Filter out internal access points (like EmployeeSkudSection does)
        const extEvents = events.filter(e => !e.access_point || !internalPoints.has(e.access_point));

        // Calculate hours from external events; fallback to all if external gives 0
        let totalMs = calcPairMs(extEvents);
        if (totalMs === 0 && events.length > 0) {
          totalMs = calcPairMs(events);
        }

        const totalHours = Math.round((totalMs / 3600000) * 100) / 100;
        const empId = events[0].employee_id;
        const date = events[0].event_date;

        // first_entry/last_exit: use external if they gave hours, otherwise all
        const usedFallback = calcPairMs(extEvents) === 0 && events.length > 0;
        const srcEvents = usedFallback ? events : (extEvents.length > 0 ? extEvents : events);
        const firstEntry = srcEvents.find(e => e.direction === 'entry');
        const lastExit = [...srcEvents].reverse().find(e => e.direction === 'exit');

        skudMap.set(key, {
          employee_id: empId,
          date,
          first_entry: firstEntry?.event_time || null,
          last_exit: lastExit?.event_time || null,
          total_hours: totalHours,
        });
      }

      // Fetch manual corrections from tender_timesheet
      let manualEntries: Array<Record<string, unknown>> = [];
      for (let i = 0; i < employeeIds.length; i += BATCH_SIZE) {
        const batch = employeeIds.slice(i, i + BATCH_SIZE);
        const { data, error } = await supabase
          .from('tender_timesheet')
          .select('*')
          .in('employee_id', batch)
          .gte('work_date', startDate)
          .lte('work_date', endDate);
        if (error) throw error;
        manualEntries.push(...(data || []));
      }

      // Resolve corrected_by names
      const correctorIds = [...new Set(
        manualEntries
          .map(m => m.corrected_by as number | null)
          .filter((id): id is number => id != null)
      )];
      const correctorNames = new Map<number, string>();
      if (correctorIds.length > 0) {
        const { data: correctors } = await supabase
          .from('employees')
          .select('id, full_name')
          .in('id', correctorIds);
        for (const c of correctors || []) {
          correctorNames.set(c.id as number, c.full_name as string);
        }
      }

      // Merge: manual corrections take priority over SKUD
      const entries: Array<Record<string, unknown>> = [];
      const seenKeys = new Set<string>();

      for (const m of manualEntries) {
        const key = `${m.employee_id}_${m.work_date}`;
        seenKeys.add(key);
        if (m.corrected_by) {
          m.corrected_by_name = correctorNames.get(m.corrected_by as number) || null;
        }
        entries.push(m);
      }

      for (const [key, s] of skudMap) {
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);

        const isPresent = s.total_hours > 0 || s.first_entry !== null;
        entries.push({
          id: null,
          employee_id: s.employee_id,
          work_date: s.date,
          status: isPresent ? 'work' : 'absent',
          hours_worked: isPresent ? s.total_hours : 0,
          is_correction: false,
          first_entry: s.first_entry,
          last_exit: s.last_exit,
        });
      }

      // Автозаполнение для remote/hybrid-remote дней
      const today = new Date();
      const todayStr = today.toISOString().slice(0, 10);
      const daysInMonth = new Date(year, mon, 0).getDate();

      for (const empId of employeeIds) {
        const sched = schedulesMap.get(empId);
        if (!sched) continue;

        for (let d = 1; d <= daysInMonth; d++) {
          const dateObj = new Date(year, mon - 1, d);
          const dateStr = `${month}-${String(d).padStart(2, '0')}`;
          const key = `${empId}_${dateStr}`;

          // Пропускаем будущие дни и дни с уже имеющимися записями
          if (dateStr > todayStr) continue;
          if (seenKeys.has(key)) continue;

          // Проверяем рабочий ли день по графику
          if (!isWorkingDay(sched, dateObj)) continue;

          // Если не нужен СКУД-контроль (remote или hybrid на remote-день) — автозаполнение
          if (!needsSkudCheck(sched, dateObj)) {
            seenKeys.add(key);
            entries.push({
              id: null,
              employee_id: empId,
              work_date: dateStr,
              status: 'remote',
              hours_worked: getScheduleForDate(sched, dateObj).work_hours,
              is_correction: false,
              first_entry: null,
              last_exit: null,
            });
          }
        }
      }

      // Compute stats (schedule-aware)
      let normHours = 0;
      let totalWorkingDays = 0;
      for (const empId of employeeIds) {
        const sched = schedulesMap.get(empId);
        const empWorkDays = sched
          ? schedWorkingDaysUpToToday(year, mon, sched)
          : getWorkingDaysUpToToday(year, mon);
        normHours += sched
          ? countNormHoursUpToToday(year, mon, sched)
          : empWorkDays * 8;
        totalWorkingDays = Math.max(totalWorkingDays, empWorkDays);
      }

      let actualHours = 0;
      const deviations = { late: 0, absent: 0, sick: 0 };

      for (const entry of entries) {
        if (entry.hours_worked && typeof entry.hours_worked === 'number') {
          actualHours += entry.hours_worked;
        }
        if (entry.status === 'absent') deviations.absent++;
        if (entry.status === 'sick') deviations.sick++;

        // Проверка опоздания по времени прихода
        const empSched = schedulesMap.get(entry.employee_id as number);
        const lateThreshold = empSched ? getEffectiveLateThreshold(empSched) : '09:00:00';
        if (entry.status === 'work' && entry.first_entry && entry.first_entry > lateThreshold) {
          deviations.late++;
        }
      }

      const employeesWithNames = (employees || []).map(e => ({
        ...e,
        position_name: e.position_id ? posMap.get(e.position_id) || null : null,
      }));

      // Сериализация графиков для фронтенда
      const schedulesObj: Record<number, IResolvedSchedule> = {};
      for (const [id, sched] of schedulesMap) {
        schedulesObj[id] = sched;
      }

      res.json({
        success: true,
        data: {
          employees: employeesWithNames,
          entries,
          schedules: schedulesObj,
          stats: {
            employeeCount: employeeIds.length,
            workingDays: totalWorkingDays,
            normHours,
            actualHours,
            deviations,
          },
        },
      });
    } catch (err) {
      console.error('timesheet.getAll error:', err);
      res.status(500).json({ success: false, error: 'Ошибка загрузки табеля' });
    }
  },

  /** POST /api/timesheet */
  async create(req: AuthenticatedRequest, res: Response) {
    try {
      const parsed = createEntrySchema.parse(req.body);

      const { data, error } = await supabase
        .from('tender_timesheet')
        .upsert({
          employee_id: parsed.employee_id,
          work_date: parsed.work_date,
          status: parsed.status,
          hours_worked: parsed.hours_worked ?? null,
          is_correction: false,
        }, { onConflict: 'employee_id,work_date' })
        .select()
        .single();

      if (error) throw error;

      await auditService.logFromRequest(req, req.user.id, 'CREATE_TIMESHEET_ENTRY', {
        entityType: 'timesheet',
        entityId: String(data.id),
        details: {
          employee_id: parsed.employee_id,
          work_date: parsed.work_date,
          status: parsed.status,
        },
      });

      res.json({ success: true, data });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ success: false, error: 'Ошибка валидации', details: err.errors });
      }
      console.error('timesheet.create error:', err);
      res.status(500).json({ success: false, error: 'Ошибка создания записи' });
    }
  },

  /** PUT /api/timesheet/:id */
  async update(req: AuthenticatedRequest, res: Response) {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ success: false, error: 'Некорректный ID' });

      const parsed = updateEntrySchema.parse(req.body);

      const { data, error } = await supabase
        .from('tender_timesheet')
        .update({
          ...parsed,
          is_correction: true,
          corrected_by: req.user.employee_id ?? null,
          corrected_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', id)
        .select()
        .single();

      if (error) throw error;
      if (!data) return res.status(404).json({ success: false, error: 'Запись не найдена' });

      await auditService.logFromRequest(req, req.user.id, 'UPDATE_TIMESHEET_ENTRY', {
        entityType: 'timesheet',
        entityId: String(id),
        details: { ...parsed },
      });

      res.json({ success: true, data });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ success: false, error: 'Ошибка валидации', details: err.errors });
      }
      console.error('timesheet.update error:', err);
      res.status(500).json({ success: false, error: 'Ошибка обновления записи' });
    }
  },

  /** GET /api/timesheet/export?month=YYYY-MM&department_id=... */
  export: exportTimesheet,

  /** POST /api/timesheet/export-mass  body: { month, department_ids } */
  exportMass: exportTimesheetMass,
};
