import { Response } from 'express';
import { z } from 'zod';
import { supabase } from '../config/database.js';
import { auditService } from '../services/audit.service.js';
import { getOrgId } from '../utils/org.utils.js';
import type { AuthenticatedRequest, TimeStatus } from '../types/index.js';
import { exportTimesheet } from './timesheet-export.controller.js';

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
      const organizationId = getOrgId(req);
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
            stats: { employeeCount: 0, workingDays: getWorkingDaysInMonth(year, mon), normHours: getWorkingDaysInMonth(year, mon) * 8, actualHours: 0, deviations: { late: 0, absent: 0, sick: 0 } },
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

      if (organizationId) {
        empQuery = empQuery.eq('organization_id', organizationId);
      }

      if (hasDeptFilter) {
        empQuery = empQuery.eq('org_department_id', department_id as string);
      }

      const { data: employees, error: empError } = await empQuery;
      if (empError) throw empError;

      const employeeIds = (employees || []).map(e => e.id);

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

      const BATCH_SIZE = 200;

      // Load internal access points for filtering
      let internalPointsQuery = supabase
        .from('skud_access_point_settings')
        .select('access_point_name')
        .eq('is_internal', true);
      if (organizationId) {
        internalPointsQuery = internalPointsQuery.eq('organization_id', organizationId);
      }
      const { data: apSettings } = await internalPointsQuery;
      const internalPoints = new Set<string>(
        (apSettings || []).map((s: { access_point_name: string }) => s.access_point_name.trim()),
      );

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

      if (empNameMap.size > 0 && organizationId) {
        const unmatchedQuery = supabase
          .from('skud_events')
          .select('id, physical_person, employee_id, event_date, event_time, direction, access_point')
          .eq('organization_id', organizationId)
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
          }).catch(() => {});
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

      // Merge: manual corrections take priority over SKUD
      const entries: Array<Record<string, unknown>> = [];
      const seenKeys = new Set<string>();

      for (const m of manualEntries) {
        const key = `${m.employee_id}_${m.work_date}`;
        seenKeys.add(key);
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

      // Compute stats
      const workingDays = getWorkingDaysUpToToday(year, mon);
      const normHours = workingDays * 8 * employeeIds.length;
      let actualHours = 0;
      const deviations = { late: 0, absent: 0, sick: 0 };

      for (const entry of entries) {
        if (entry.hours_worked && typeof entry.hours_worked === 'number') {
          actualHours += entry.hours_worked;
        }
        if (entry.status === 'absent') deviations.absent++;
        if (entry.status === 'sick') deviations.sick++;
        if (entry.status === 'work' && typeof entry.hours_worked === 'number' && entry.hours_worked < 8) {
          deviations.late++;
        }
      }

      const employeesWithNames = (employees || []).map(e => ({
        ...e,
        position_name: e.position_id ? posMap.get(e.position_id) || null : null,
      }));

      res.json({
        success: true,
        data: {
          employees: employeesWithNames,
          entries,
          stats: {
            employeeCount: employeeIds.length,
            workingDays,
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
};
