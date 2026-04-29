import { Response } from 'express';
import { z } from 'zod';
import { supabase } from '../config/database.js';
import { sigurService } from '../services/sigur.service.js';
import { formatDateToISO } from '../utils/date.utils.js';
import type { AuthenticatedRequest } from '../types/index.js';

import { getDashboardStats } from '../services/skud-dashboard.service.js';
import { getPresence } from '../services/skud-presence.service.js';
import { getDisciplineViolations } from '../services/skud-discipline.service.js';
import {
  buildDisciplineWorkbook,
  buildEmployeeSkudWorkbook,
  formatMonthRangeLabel,
  sanitizeExportFileName,
  type DisciplineExportEmployeeSummary,
  type DisciplineViolationType,
} from '../services/skud-export.service.js';
import {
  getSyncFilteredEmployees,
  queryEventsByEmployeeId,
  searchAndBackfillByName,
  getAccessPointCacheEntry,
  setAccessPointCacheEntry,
} from '../services/skud-shared.service.js';
import { skudWriteController } from './skud-write.controller.js';
import { skudTravelController } from './skud-travel.controller.js';
import {
  canAccessEmployeeInScope,
  getMinSelfHistoryDate,
  isSelfEmployeeRequest,
  resolveManagedDepartmentIds,
  resolveRequestDataScope,
  resolveScopedDepartmentId,
} from '../services/data-scope.service.js';
import type { IAccessPointOption, IDisciplineResult } from '../types/skud.types.js';

const MONTH_PATTERN = /^\d{4}-\d{2}$/;
type DisciplineTab = 'all' | DisciplineViolationType;

function formatDisciplineDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-');
  return `${day}.${month}.${year}`;
}

function normalizeAccessPointName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function parseAccessPointNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }

  return null;
}

function extractAccessPointNumber(row: Record<string, unknown> | { name: string; id: number | null }): number | null {
  const candidate = row as Record<string, unknown>;
  const directKeys = ['id', 'accessPointId', 'accesspointId', 'number', 'accessPointNumber', 'objectNumber', 'tabId'];

  for (const key of directKeys) {
    const parsed = parseAccessPointNumber(candidate[key]);
    if (parsed != null) return parsed;
  }

  const nested = candidate.data;
  if (nested && typeof nested === 'object') {
    for (const key of directKeys) {
      const parsed = parseAccessPointNumber((nested as Record<string, unknown>)[key]);
      if (parsed != null) return parsed;
    }
  }

  return null;
}

function sortAccessPointNames(names: Iterable<string>): string[] {
  return [...names].sort((left, right) => left.localeCompare(right, 'ru'));
}

function buildAccessPointOptions(
  rows: Array<Record<string, unknown> | { name: string; id: number | null }>,
): IAccessPointOption[] {
  const optionsByName = new Map<string, number | null>();

  for (const row of rows) {
    const name = normalizeAccessPointName(row.name);
    if (!name) continue;

    const id = extractAccessPointNumber(row);
    if (!optionsByName.has(name) || (optionsByName.get(name) == null && id != null)) {
      optionsByName.set(name, id);
    }
  }

  return sortAccessPointNames(optionsByName.keys()).map(name => ({
    name,
    id: optionsByName.get(name) ?? null,
  }));
}

function buildAccessPointOptionsFromNames(names: string[]): IAccessPointOption[] {
  return buildAccessPointOptions(
    names.map(name => ({ name, id: null })),
  );
}

async function loadEmployeeEventsForRequest(
  employeeId: number,
  startDate: unknown,
  endDate: unknown,
  options: {
    includeEmployeeName?: boolean;
    preferFastSingleDay?: boolean;
    useCache?: boolean;
  } = {},
): Promise<{
  employeeName: string;
  events: Array<{
    id: number | string;
    physical_person: string | null;
    card_number: string | null;
    event_date: string;
    event_time: string;
    access_point: string | null;
    direction: 'entry' | 'exit' | null;
    employee_id: number | null;
  }>;
}> {
  const includeEmployeeName = options.includeEmployeeName ?? true;
  const preferFastSingleDay = options.preferFastSingleDay ?? false;
  const useCache = options.useCache ?? false;
  const singleDayRequest = typeof startDate === 'string' && typeof endDate === 'string' && startDate === endDate;
  const cacheKey = `${employeeId}:${String(startDate || '')}:${String(endDate || '')}:${includeEmployeeName ? 'named' : 'anon'}`;

  type EmployeeEventsResponse = {
    employeeName: string;
    events: Array<{
      id: number | string;
      physical_person: string | null;
      card_number: string | null;
      event_date: string;
      event_time: string;
      access_point: string | null;
      direction: 'entry' | 'exit' | null;
      employee_id: number | null;
    }>;
  };

  const cacheTtlMs = 60_000;
  const cacheStore = (loadEmployeeEventsForRequest as typeof loadEmployeeEventsForRequest & {
    __cache?: Map<string, { at: number; data: EmployeeEventsResponse }>;
  }).__cache ??= new Map<string, { at: number; data: EmployeeEventsResponse }>();

  if (useCache) {
    const cached = cacheStore.get(cacheKey);
    if (cached && Date.now() - cached.at < cacheTtlMs) {
      return cached.data;
    }
  }

  const mapEvents = (events: Record<string, unknown>[]) => events.map((event: Record<string, unknown>) => ({
    id: (event.id as number | string) ?? '',
    physical_person: (event.physical_person as string | null) || null,
    card_number: (event.card_number as string | null) || null,
    event_date: String(event.event_date),
    event_time: String(event.event_time),
    access_point: (event.access_point as string | null) || null,
    direction: (event.direction as 'entry' | 'exit' | null) || null,
    employee_id: (event.employee_id as number | null) || null,
  }));

  const byId = await queryEventsByEmployeeId(employeeId, startDate, endDate);
  let employeeName = `Сотрудник_${employeeId}`;
  let employeeFullName: string | null = null;

  if (includeEmployeeName || byId.length === 0 || !preferFastSingleDay) {
    const { data: employeeData } = await supabase
      .from('employees')
      .select('full_name')
      .eq('id', employeeId)
      .single();

    if (employeeData?.full_name) {
      employeeName = employeeData.full_name;
      employeeFullName = employeeData.full_name;
    }
  }

  if (preferFastSingleDay && singleDayRequest && byId.length > 0) {
    const response = {
      employeeName,
      events: mapEvents(byId),
    };
    if (useCache) {
      cacheStore.set(cacheKey, { at: Date.now(), data: response });
    }

    void (async () => {
      try {
        let resolvedFullName = employeeFullName;
        if (!resolvedFullName) {
          const { data: employeeData } = await supabase
            .from('employees')
            .select('full_name')
            .eq('id', employeeId)
            .single();
          resolvedFullName = employeeData?.full_name || null;
        }
        if (!resolvedFullName) return;

        const byName = await searchAndBackfillByName(
          employeeId,
          resolvedFullName.toLowerCase().trim(),
          startDate,
          endDate,
        );
        if (byName.length === 0) return;

        const seenIds = new Set(byId.map((event: Record<string, unknown>) => String(event.id)));
        const merged = [...byId, ...byName.filter((event: Record<string, unknown>) => !seenIds.has(String(event.id)))];
        cacheStore.set(cacheKey, {
          at: Date.now(),
          data: {
            employeeName: resolvedFullName,
            events: mapEvents(merged),
          },
        });
      } catch (error) {
        console.warn('[skud] background employee event backfill failed:', error);
      }
    })();

    return response;
  }

  let byName: Record<string, unknown>[] = [];
  if (employeeFullName) {
    byName = await searchAndBackfillByName(employeeId, employeeFullName.toLowerCase().trim(), startDate, endDate);
  }

  const seenIds = new Set(byId.map((event: Record<string, unknown>) => String(event.id)));
  const merged = [...byId, ...byName.filter((event: Record<string, unknown>) => !seenIds.has(String(event.id)))];

  const response = {
    employeeName,
    events: mapEvents(merged),
  };
  if (useCache) {
    cacheStore.set(cacheKey, { at: Date.now(), data: response });
  }
  return response;
}

async function getInternalAccessPointsForRequest(req: AuthenticatedRequest): Promise<Set<string>> {
  const scope = await resolveRequestDataScope(req);
  let query = supabase
    .from('skud_access_point_settings')
    .select('access_point_name, is_internal');

  if (scope === 'department') {
    const managedDepartmentIds = await resolveManagedDepartmentIds(req);
    if (managedDepartmentIds.length === 0) {
      return new Set();
    }
    query = query.in('department_id', managedDepartmentIds);
  }

  const { data, error } = await query;
  if (error) throw error;

  return new Set(
    (data || [])
      .filter(row => row.is_internal)
      .map(row => row.access_point_name.trim())
      .filter(Boolean),
  );
}

async function getScopedDisciplineData(
  req: AuthenticatedRequest,
  startMonth: string,
  endMonth: string,
): Promise<IDisciplineResult> {
  const data = await getDisciplineViolations({ startMonth, endMonth });
  const scope = await resolveRequestDataScope(req);

  if (scope !== 'department') {
    return data;
  }

  const managedDepartmentIds = await resolveManagedDepartmentIds(req);
  if (managedDepartmentIds.length === 0) {
    return {
      ...data,
      employees: {},
      violations: [],
    };
  }

  const filteredEmployeeIds = Object.entries(data.employees)
    .filter(([, employee]) => employee.department_id != null && managedDepartmentIds.includes(employee.department_id))
    .map(([employeeId]) => Number(employeeId));
  const employeeIdSet = new Set(filteredEmployeeIds);

  return {
    ...data,
    employees: Object.fromEntries(
      Object.entries(data.employees).filter(([employeeId]) => employeeIdSet.has(Number(employeeId))),
    ),
    violations: data.violations.filter(item => employeeIdSet.has(item.employee_id)),
  };
}

function buildDisciplineEmployeeSummaries(data: IDisciplineResult): DisciplineExportEmployeeSummary[] {
  const map: Record<number, DisciplineExportEmployeeSummary> = {};

  for (const violation of data.violations) {
    if (!map[violation.employee_id]) {
      const employee = data.employees[violation.employee_id] || {
        full_name: `#${violation.employee_id}`,
        position: null,
        department_id: null,
      };

      map[violation.employee_id] = {
        employee_id: violation.employee_id,
        name: employee.full_name,
        position: employee.position || '—',
        department: employee.department_id ? (data.departments[employee.department_id] || '—') : '—',
        departmentId: employee.department_id,
        late: 0,
        underwork: 0,
        early: 0,
        absence: 0,
        total: 0,
        violations: [],
      };
    }

    const summary = map[violation.employee_id];
    summary[violation.type] += 1;
    summary.total += 1;
    summary.violations.push({
      ...violation,
      dateFormatted: formatDisciplineDate(violation.date),
    });
  }

  return Object.values(map).sort((left, right) => right.total - left.total);
}

function filterDisciplineEmployeeSummaries(
  employees: DisciplineExportEmployeeSummary[],
  filters: {
    departmentId: string;
    searchQuery: string;
    activeTab: DisciplineTab;
  },
): DisciplineExportEmployeeSummary[] {
  let filtered = employees;

  if (filters.departmentId) {
    filtered = filtered.filter(employee => employee.departmentId === filters.departmentId);
  }

  if (filters.searchQuery.trim()) {
    const normalizedQuery = filters.searchQuery.trim().toLowerCase();
    filtered = filtered.filter(employee => employee.name.toLowerCase().includes(normalizedQuery));
  }

  if (filters.activeTab !== 'all') {
    const key = filters.activeTab as DisciplineViolationType;
    filtered = filtered
      .filter(employee => employee[key] > 0)
      .sort((left, right) => right[key] - left[key]);
  }

  return filtered;
}

const dashboardStatsQuerySchema = z.object({
  department_id: z.string().optional(),
  period: z.enum(['today', 'week', 'month']).default('today'),
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
});

const skudReadController = {
  /**
   * GET /api/skud/dashboard-stats?department_id=uuid&period=today|week|month
   */
  async getDashboardStats(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const parsed = dashboardStatsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ success: false, error: 'Некорректные параметры запроса', details: parsed.error.flatten() });
        return;
      }
      const { period, month } = parsed.data;

      const departmentId = await resolveScopedDepartmentId(
        req,
        parsed.data.department_id ?? null,
      );

      if (!departmentId) {
        res.status(400).json({ success: false, error: 'department_id обязателен' });
        return;
      }

      const data = await getDashboardStats({ departmentId, period, month });
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
        .select('employee_id, date, first_entry, last_exit, total_hours, is_present')
        .gte('date', startStr)
        .lte('date', endStr)
        .order('date');

      const syncFilter = await getSyncFilteredEmployees();
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

      if (!(await canAccessEmployeeInScope(req, employeeId))) {
        res.status(403).json({ success: false, error: 'Access denied' });
        return;
      }

      const { startDate, endDate } = req.query;
      if (
        isSelfEmployeeRequest(req, employeeId)
        && typeof startDate === 'string'
        && startDate < getMinSelfHistoryDate()
      ) {
        res.status(403).json({ success: false, error: 'Доступ только за текущий и прошлый месяц' });
        return;
      }

      const { events } = await loadEmployeeEventsForRequest(employeeId, startDate, endDate, {
        includeEmployeeName: false,
        preferFastSingleDay: true,
        useCache: true,
      });
      res.json({ success: true, data: events });
    } catch (error) {
      console.error('Get employee events error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch employee events' });
    }
  },

  /**
   * GET /api/skud/employee-events/:employeeId/export
   */
  async exportEmployeeEvents(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const employeeId = parseInt(req.params.employeeId, 10);
      if (isNaN(employeeId)) {
        res.status(400).json({ success: false, error: 'Invalid employeeId' });
        return;
      }

      if (!(await canAccessEmployeeInScope(req, employeeId))) {
        res.status(403).json({ success: false, error: 'Access denied' });
        return;
      }

      const startDate = typeof req.query.startDate === 'string' ? req.query.startDate : '';
      const endDate = typeof req.query.endDate === 'string' ? req.query.endDate : '';
      if (!startDate || !endDate) {
        res.status(400).json({ success: false, error: 'Параметры startDate и endDate обязательны' });
        return;
      }

      if (isSelfEmployeeRequest(req, employeeId) && startDate < getMinSelfHistoryDate()) {
        res.status(403).json({ success: false, error: 'Доступ только за текущий и прошлый месяц' });
        return;
      }

      const { employeeName, events } = await loadEmployeeEventsForRequest(employeeId, startDate, endDate);
      const internalPoints = await getInternalAccessPointsForRequest(req);
      const workbook = buildEmployeeSkudWorkbook({
        employeeName,
        startDate,
        endDate,
        events,
        internalPoints,
      });
      const buffer = await workbook.xlsx.writeBuffer();

      const fileName = sanitizeExportFileName(
        `СКУД_${employeeName.replace(/\s+/g, '_')}_${startDate.split('-').reverse().join('-')}_${endDate.split('-').reverse().join('-')}.xlsx`,
      );

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      );
      res.send(Buffer.from(buffer));
    } catch (error) {
      console.error('exportEmployeeEvents error:', error);
      res.status(500).json({ success: false, error: 'Ошибка экспорта событий СКУД' });
    }
  },

  /**
   * GET /api/skud/events
   */
  async getEvents(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { startDate, endDate, accessPoint, employeeId, search } = req.query;
      const searchStr = typeof search === 'string' ? search.trim().toLowerCase() : '';

      let query = supabase
        .from('skud_events')
        .select('id, physical_person, card_number, event_date, event_time, access_point, direction, employee_id')
        .order('event_date', { ascending: false })
        .order('event_time', { ascending: false });

      query = query.limit(searchStr ? 10000 : 1000);

      if (startDate && typeof startDate === 'string') query = query.gte('event_date', startDate);
      if (endDate && typeof endDate === 'string') query = query.lte('event_date', endDate);
      if (accessPoint && typeof accessPoint === 'string') query = query.eq('access_point', accessPoint);
      if (employeeId && typeof employeeId === 'string') query = query.eq('employee_id', parseInt(employeeId, 10));

      const syncFilter = await getSyncFilteredEmployees();
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
      const connection = (req.query.connection as 'internal' | 'external') || undefined;
      const includeMeta = req.query.includeMeta === '1' || req.query.includeMeta === 'true';
      if (await sigurService.isConfigured()) {
        try {
          const sigurAPs = await sigurService.getAccessPoints(connection);
          const options = buildAccessPointOptions(sigurAPs as Record<string, unknown>[]);
          res.json({ success: true, data: includeMeta ? options : options.map(option => option.name) });
          return;
        } catch (sigurErr) {
          console.warn('Sigur access points fallback to DB:', (sigurErr as Error).message);
        }
      }

      const cacheKey = connection ? `__all__:${connection}` : '__all__';
      const cached = getAccessPointCacheEntry(cacheKey);
      if (cached) {
        res.json({ success: true, data: includeMeta ? buildAccessPointOptionsFromNames(cached) : cached });
        return;
      }

      const query = supabase
        .from('skud_events')
        .select('access_point')
        .not('access_point', 'is', null)
        .limit(5000);

      const { data, error } = await query;
      if (error) {
        console.error('Get access points error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch access points' });
        return;
      }

      const unique = sortAccessPointNames(
        new Set(
          (data || [])
            .map((row: { access_point: string | null }) => normalizeAccessPointName(row.access_point))
            .filter((name): name is string => !!name),
        ),
      );
      setAccessPointCacheEntry(cacheKey, unique);

      res.json({ success: true, data: includeMeta ? buildAccessPointOptionsFromNames(unique) : unique });
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
      // Признак «внутренняя точка» — физическое свойство точки, а не привилегия отдела:
      // если точка помечена internal хотя бы в одном отделе, она internal везде.
      // Без явного department_id всегда отдаём агрегированный список (BOOL_OR по имени),
      // иначе руководитель, не управляющий отделом-владельцем точки, получал бы пустые
      // internalPoints — и события с «Коридора» учитывались бы как внешние, формируя
      // ложные перерывы между парами вход/выход.
      const requestedDepartmentId = typeof req.query.department_id === 'string'
        ? req.query.department_id
        : null;

      if (!requestedDepartmentId) {
        const { data, error } = await supabase
          .from('skud_access_point_settings')
          .select('access_point_name, is_internal');

        if (error) {
          console.error('Get access point settings error:', error);
          res.status(500).json({ success: false, error: 'Ошибка получения настроек' });
          return;
        }

        const aggregated = new Map<string, boolean>();
        for (const row of data || []) {
          const name = (row.access_point_name as string).trim();
          const current = aggregated.get(name) ?? false;
          aggregated.set(name, current || Boolean(row.is_internal));
        }

        res.json({
          success: true,
          data: Array.from(aggregated.entries()).map(([access_point_name, is_internal]) => ({
            access_point_name,
            is_internal,
          })),
        });
        return;
      }

      // Явный ?department_id=xxx — для админской страницы /skud-settings,
      // где редактируются настройки конкретного отдела. Проверяем scope.
      const departmentId = await resolveScopedDepartmentId(req, requestedDepartmentId);
      if (!departmentId) {
        res.json({ success: true, data: [] });
        return;
      }

      const query = supabase
        .from('skud_access_point_settings')
        .select('access_point_name, is_internal')
        .eq('department_id', departmentId);

      const { data, error } = await query;
      if (error) {
        console.error('Get access point settings error:', error);
        res.status(500).json({ success: false, error: 'Ошибка получения настроек' });
        return;
      }

      const result = (data || []).map(row => ({
        access_point_name: row.access_point_name.trim(),
        is_internal: row.is_internal,
      }));

      res.json({ success: true, data: result });
    } catch (error) {
      console.error('Get access point settings error:', error);
      res.status(500).json({ success: false, error: 'Ошибка получения настроек' });
    }
  },

  /**
   * GET /api/skud/discipline?month=2026-03
   */
  async getDisciplineViolations(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const fallbackMonth = formatDateToISO(new Date()).slice(0, 7);
      const startMonth = (req.query.startMonth as string) || (req.query.month as string) || fallbackMonth;
      const endMonth = (req.query.endMonth as string) || startMonth;

      if (!MONTH_PATTERN.test(startMonth) || !MONTH_PATTERN.test(endMonth)) {
        res.status(400).json({ success: false, error: 'Некорректный формат месяца. Используйте YYYY-MM' });
        return;
      }

      const data = await getScopedDisciplineData(req, startMonth, endMonth);
      res.json({ success: true, data });
    } catch (error) {
      console.error('getDisciplineViolations error:', error);
      res.status(500).json({ success: false, error: 'Ошибка получения аналитики дисциплины' });
    }
  },

  /**
   * GET /api/skud/discipline/export
   */
  async exportDisciplineViolations(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const fallbackMonth = formatDateToISO(new Date()).slice(0, 7);
      const startMonth = (req.query.startMonth as string) || (req.query.month as string) || fallbackMonth;
      const endMonth = (req.query.endMonth as string) || startMonth;

      if (!MONTH_PATTERN.test(startMonth) || !MONTH_PATTERN.test(endMonth)) {
        res.status(400).json({ success: false, error: 'Некорректный формат месяца. Используйте YYYY-MM' });
        return;
      }

      const tab = typeof req.query.tab === 'string' ? req.query.tab : 'all';
      if (!['all', 'late', 'underwork', 'early', 'absence'].includes(tab)) {
        res.status(400).json({ success: false, error: 'Некорректный тип фильтра' });
        return;
      }

      const departmentId = typeof req.query.department_id === 'string' ? req.query.department_id : '';
      const searchQuery = typeof req.query.search === 'string' ? req.query.search : '';
      const data = await getScopedDisciplineData(req, startMonth, endMonth);
      const employees = buildDisciplineEmployeeSummaries(data);
      const filtered = filterDisciplineEmployeeSummaries(employees, {
        departmentId,
        searchQuery,
        activeTab: tab as DisciplineTab,
      });
      const source = filtered.length > 0 ? filtered : employees;
      const workbook = buildDisciplineWorkbook({ employees: source });
      const buffer = await workbook.xlsx.writeBuffer();
      const fileName = sanitizeExportFileName(
        `Аналитика_дисциплины_${formatMonthRangeLabel(startMonth, endMonth).replace(/\s+/g, '_')}.xlsx`,
      );

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      );
      res.send(Buffer.from(buffer));
    } catch (error) {
      console.error('exportDisciplineViolations error:', error);
      res.status(500).json({ success: false, error: 'Ошибка экспорта аналитики дисциплины' });
    }
  },

  /**
   * GET /api/skud/presence
   */
  async getPresence(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const departmentId = await resolveScopedDepartmentId(
        req,
        typeof req.query.department_id === 'string' ? req.query.department_id : null,
      );

      const data = await getPresence({ departmentId });
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
  ...skudTravelController,
};
