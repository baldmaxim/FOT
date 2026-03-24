import { Response } from 'express';
import { supabase } from '../config/database.js';
import { sigurService } from '../services/sigur.service.js';
import { formatDateToISO } from '../utils/date.utils.js';
import { getOrgId } from '../utils/org.utils.js';
import type { AuthenticatedRequest } from '../types/index.js';

import { getDashboardStats } from '../services/skud-dashboard.service.js';
import { getPresence } from '../services/skud-presence.service.js';
import { getDisciplineViolations } from '../services/skud-discipline.service.js';
import {
  getSyncFilteredEmployees,
  queryEventsByEmployeeId,
  searchAndBackfillByName,
  getAccessPointCacheEntry,
  setAccessPointCacheEntry,
} from '../services/skud-shared.service.js';
import { skudWriteController } from './skud-write.controller.js';

const skudReadController = {
  /**
   * GET /api/skud/dashboard-stats?department_id=uuid&period=today|week|month
   */
  async getDashboardStats(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const organizationId = getOrgId(req);
      const departmentId = req.user.position_type === 'header' && req.user.department_id
        ? req.user.department_id
        : (typeof req.query.department_id === 'string' ? req.query.department_id : null);
      const period = (req.query.period as string) || 'today';

      if (!departmentId) {
        res.status(400).json({ success: false, error: 'department_id обязателен' });
        return;
      }

      const data = await getDashboardStats({ organizationId, departmentId, period });
      res.json({ success: true, data });
    } catch (error) {
      console.error('getDashboardStats error:', error);
      res.status(500).json({ success: false, error: 'Ошибка получения аналитики дашборда' });
    }
  },

  /**
   * GET /api/skud/daily-summary
   */
  async getDailySummary(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const organizationId = getOrgId(req);
      const { date } = req.query;

      if (!date || typeof date !== 'string') {
        res.status(400).json({ success: false, error: 'Date parameter required' });
        return;
      }

      const startDate = new Date(date);
      const endDate = new Date(startDate.getFullYear(), startDate.getMonth() + 1, 0);
      const startStr = formatDateToISO(startDate);
      const endStr = formatDateToISO(endDate);

      let query = supabase
        .from('skud_daily_summary')
        .select('*')
        .gte('date', startStr)
        .lte('date', endStr)
        .order('date');

      if (organizationId) query = query.eq('organization_id', organizationId);

      const syncFilter = await getSyncFilteredEmployees(organizationId);
      if (syncFilter) {
        const { empIds: allowedIds } = syncFilter;
        if (allowedIds.size > 0) {
          query = query.in('employee_id', [...allowedIds]);
        } else {
          res.json({ success: true, data: [] });
          return;
        }
      }

      const { data, error } = await query;
      if (error) {
        console.error('Get daily summary error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch daily summary' });
        return;
      }

      res.json({ success: true, data: data || [] });
    } catch (error) {
      console.error('Get daily summary error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch daily summary' });
    }
  },

  /**
   * GET /api/skud/employee-events/:employeeId
   */
  async getEmployeeEvents(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const employeeId = parseInt(req.params.employeeId, 10);
      if (isNaN(employeeId)) {
        res.status(400).json({ success: false, error: 'Invalid employeeId' });
        return;
      }

      if (req.user?.position_type === 'worker') {
        if (!req.user.employee_id || req.user.employee_id !== employeeId) {
          res.status(403).json({ success: false, error: 'Access denied' });
          return;
        }
      }

      const { startDate, endDate } = req.query;
      const organizationId = getOrgId(req);

      const isSelfRequest = req.user.position_type === 'worker' &&
        req.user.employee_id !== null &&
        req.user.employee_id === employeeId;

      let empQuery = supabase.from('employees').select('full_name, organization_id').eq('id', employeeId);
      if (organizationId && !isSelfRequest) empQuery = empQuery.eq('organization_id', organizationId);
      const { data: empData, error: empError } = await empQuery.single();
      console.log(`[employee-events] empData=`, JSON.stringify(empData), `empError=`, empError?.message);

      const effectiveOrgId = isSelfRequest
        ? (empData?.organization_id || organizationId || undefined)
        : (organizationId || empData?.organization_id || undefined);

      const byId = await queryEventsByEmployeeId(employeeId, effectiveOrgId, startDate, endDate);
      console.log(`[employee-events] id=${employeeId} byId=${byId.length} orgId=${effectiveOrgId} dates=${startDate as string}..${endDate as string}`);

      let byName: Record<string, unknown>[] = [];
      if (empData?.full_name && effectiveOrgId) {
        const employeeName = empData.full_name.toLowerCase().trim();
        console.log(`[employee-events] searching by name: "${employeeName}"`);
        byName = await searchAndBackfillByName(employeeId, employeeName, effectiveOrgId, startDate, endDate);
        console.log(`[employee-events] byName=${byName.length}`);
      } else {
        console.log(`[employee-events] skip name search: empData=${!!empData} orgId=${effectiveOrgId}`);
      }

      const seenIds = new Set(byId.map((e: Record<string, unknown>) => e.id));
      const events = [...byId, ...byName.filter((e: Record<string, unknown>) => !seenIds.has(e.id))];
      console.log(`[employee-events] total=${events.length}`);

      const result = events.map((event: Record<string, unknown>) => ({
        id: event.id,
        physical_person: event.physical_person,
        card_number: event.card_number || null,
        event_date: event.event_date,
        event_time: event.event_time,
        access_point: event.access_point,
        direction: event.direction,
        employee_id: event.employee_id,
      }));

      res.json({ success: true, data: result });
    } catch (error) {
      console.error('Get employee events error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch employee events' });
    }
  },

  /**
   * GET /api/skud/events
   */
  async getEvents(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const organizationId = getOrgId(req);
      const { startDate, endDate, accessPoint, employeeId, search } = req.query;
      const searchStr = typeof search === 'string' ? search.trim().toLowerCase() : '';

      let query = supabase
        .from('skud_events')
        .select('*')
        .order('event_date', { ascending: false })
        .order('event_time', { ascending: false });

      query = query.limit(searchStr ? 10000 : 1000);

      if (organizationId) query = query.eq('organization_id', organizationId);
      if (startDate && typeof startDate === 'string') query = query.gte('event_date', startDate);
      if (endDate && typeof endDate === 'string') query = query.lte('event_date', endDate);
      if (accessPoint && typeof accessPoint === 'string') query = query.eq('access_point', accessPoint);
      if (employeeId && typeof employeeId === 'string') query = query.eq('employee_id', parseInt(employeeId, 10));

      const syncFilter = await getSyncFilteredEmployees(organizationId);
      if (syncFilter) {
        const { empIds: allowedIds } = syncFilter;
        if (allowedIds.size > 0) {
          query = query.in('employee_id', [...allowedIds]);
        } else {
          res.json({ success: true, data: [] });
          return;
        }
      }

      const { data, error } = await query;
      if (error) {
        console.error('Get events error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch events' });
        return;
      }

      const decrypted = (data || []).map((event: {
        id: number;
        physical_person: string;
        card_number: string | null;
        event_date: string;
        event_time: string;
        access_point: string | null;
        direction: string | null;
        employee_id: number | null;
      }) => ({
        id: event.id,
        physical_person: event.physical_person,
        card_number: event.card_number || null,
        event_date: event.event_date,
        event_time: event.event_time,
        access_point: event.access_point,
        direction: event.direction,
        employee_id: event.employee_id,
      }));

      const result = searchStr
        ? decrypted.filter(e => (e.physical_person || '').toLowerCase().includes(searchStr))
        : decrypted;

      res.json({ success: true, data: result });
    } catch (error) {
      console.error('Get events error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch events' });
    }
  },

  /**
   * GET /api/skud/access-points
   */
  async getAccessPoints(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (sigurService.isConfigured()) {
        try {
          const sigurAPs = await sigurService.getAccessPoints();
          const names = (sigurAPs as Record<string, unknown>[])
            .map(ap => ((ap.name as string) || '').trim())
            .filter(Boolean);
          const unique = [...new Set(names)].sort();
          res.json({ success: true, data: unique });
          return;
        } catch (sigurErr) {
          console.warn('Sigur access points fallback to DB:', (sigurErr as Error).message);
        }
      }

      const organizationId = getOrgId(req);
      const cacheKey = organizationId || '__all__';
      const cached = getAccessPointCacheEntry(cacheKey);
      if (cached) {
        res.json({ success: true, data: cached });
        return;
      }

      let query = supabase
        .from('skud_events')
        .select('access_point')
        .not('access_point', 'is', null)
        .limit(5000);
      if (organizationId) query = query.eq('organization_id', organizationId);

      const { data, error } = await query;
      if (error) {
        console.error('Get access points error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch access points' });
        return;
      }

      const unique = [...new Set((data || []).map((d: { access_point: string }) => d.access_point))].sort();
      setAccessPointCacheEntry(cacheKey, unique);

      res.json({ success: true, data: unique });
    } catch (error) {
      console.error('Get access points error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch access points' });
    }
  },

  /**
   * GET /api/skud/access-point-settings?department_id=uuid
   */
  async getAccessPointSettings(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      let organizationId = getOrgId(req);
      let departmentId = typeof req.query.department_id === 'string' ? req.query.department_id : null;

      if (!organizationId) {
        const { data: orgs } = await supabase.from('organizations').select('id').limit(1);
        organizationId = orgs?.[0]?.id;
      }

      if (!departmentId) {
        if (!organizationId) {
          res.json({ success: true, data: [] });
          return;
        }
        const { data, error } = await supabase
          .from('skud_access_point_settings')
          .select('access_point_name, is_internal')
          .eq('organization_id', organizationId);

        if (error) {
          console.error('Get access point settings error:', error);
          res.status(500).json({ success: false, error: 'Ошибка получения настроек' });
          return;
        }

        const result = (data || []).map(row => ({
          access_point_name: row.access_point_name,
          is_internal: row.is_internal,
        }));
        res.json({ success: true, data: result });
        return;
      }

      if (!organizationId) {
        const { data: dept } = await supabase.from('org_departments').select('organization_id').eq('id', departmentId).maybeSingle();
        organizationId = dept?.organization_id;
      }

      let query = supabase
        .from('skud_access_point_settings')
        .select('access_point_name, is_internal')
        .eq('department_id', departmentId);
      if (organizationId) query = query.eq('organization_id', organizationId);

      const { data, error } = await query;
      if (error) {
        console.error('Get access point settings error:', error);
        res.status(500).json({ success: false, error: 'Ошибка получения настроек' });
        return;
      }

      const result = (data || []).map(row => ({
        access_point_name: row.access_point_name,
        is_internal: row.is_internal,
      }));

      res.json({ success: true, data: result });
    } catch (error) {
      console.error('Get access point settings error:', error);
      res.status(500).json({ success: false, error: 'Ошибка получения настроек' });
    }
  },

  /**
   * GET /api/skud/organizations
   */
  async getOrganizations(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { data: rows, error } = await supabase
        .from('skud_events')
        .select('organization_id')
        .not('organization_id', 'is', null);

      if (error) {
        res.status(500).json({ success: false, error: error.message });
        return;
      }

      const uniqueOrgIds = [...new Set((rows || []).map(r => r.organization_id))];
      if (uniqueOrgIds.length === 0) {
        res.json({ success: true, data: [] });
        return;
      }

      const { data: orgs } = await supabase
        .from('organizations')
        .select('id, name')
        .in('id', uniqueOrgIds)
        .order('name');

      res.json({ success: true, data: orgs || [] });
    } catch (error) {
      console.error('Get SKUD organizations error:', error);
      res.status(500).json({ success: false, error: 'Ошибка загрузки организаций' });
    }
  },

  /**
   * GET /api/skud/discipline?month=2026-03
   */
  async getDisciplineViolations(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const organizationId = getOrgId(req);
      const fallbackMonth = formatDateToISO(new Date()).slice(0, 7);
      const startMonth = (req.query.startMonth as string) || (req.query.month as string) || fallbackMonth;
      const endMonth = (req.query.endMonth as string) || startMonth;

      const monthPattern = /^\d{4}-\d{2}$/;
      if (!monthPattern.test(startMonth) || !monthPattern.test(endMonth)) {
        res.status(400).json({ success: false, error: 'Некорректный формат месяца. Используйте YYYY-MM' });
        return;
      }

      const data = await getDisciplineViolations({ organizationId, startMonth, endMonth });
      res.json({ success: true, data });
    } catch (error) {
      console.error('getDisciplineViolations error:', error);
      res.status(500).json({ success: false, error: 'Ошибка получения аналитики дисциплины' });
    }
  },

  /**
   * GET /api/skud/presence
   */
  async getPresence(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const organizationId = getOrgId(req);
      const departmentId = req.user.position_type === 'header' && req.user.department_id
        ? req.user.department_id
        : (typeof req.query.department_id === 'string' ? req.query.department_id : null);

      const data = await getPresence({ organizationId, departmentId });
      res.json({ success: true, data });
    } catch (error) {
      console.error('Get presence error:', error);
      res.status(500).json({ success: false, error: 'Ошибка получения статусов' });
    }
  },
};

/** Barrel export — все методы read + write, роуты не меняются */
export const skudController = {
  ...skudReadController,
  ...skudWriteController,
};
