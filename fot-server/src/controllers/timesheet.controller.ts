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

      // Fetch internal access points to filter them out
      const BATCH_SIZE = 200;
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

      // Fetch raw SKUD events (filtering internal access points)
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

      // Filter out internal access point events
      if (internalPoints.size > 0) {
        rawEvents = rawEvents.filter(e => !e.access_point || !internalPoints.has(e.access_point));
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

      for (const [key, events] of eventsByKey) {
        // events already sorted by event_time ASC
        const firstEntry = events.find(e => e.direction === 'entry');
        const lastExit = [...events].reverse().find(e => e.direction === 'exit');

        // Calculate total hours: sum of (exit_time - entry_time) pairs
        let totalMs = 0;
        let lastEntryTime: number | null = null;

        for (const evt of events) {
          const [h, m, s] = evt.event_time.split(':').map(Number);
          const ms = (h * 3600 + m * 60 + (s || 0)) * 1000;

          if (evt.direction === 'entry') {
            lastEntryTime = ms;
          } else if (evt.direction === 'exit' && lastEntryTime !== null) {
            totalMs += ms - lastEntryTime;
            lastEntryTime = null;
          }
        }

        // If still inside (last event is entry), don't count open interval
        const totalHours = Math.round((totalMs / 3600000) * 100) / 100;
        const empId = events[0].employee_id;
        const date = events[0].event_date;

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
      const workingDays = getWorkingDaysInMonth(year, mon);
      const normHours = workingDays * 8;
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

      await auditService.logFromRequest(req, req.user!.id, 'CREATE_TIMESHEET_ENTRY', {
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

      await auditService.logFromRequest(req, req.user!.id, 'UPDATE_TIMESHEET_ENTRY', {
        entityType: 'timesheet',
        entityId: String(id),
        details: parsed as Record<string, unknown>,
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
