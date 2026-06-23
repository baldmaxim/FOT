import { Response } from 'express';
import * as Sentry from '@sentry/node';
import { z } from 'zod';
import { query } from '../config/postgres.js';
import { sigurService } from '../services/sigur.service.js';
import { formatDateToISO } from '../utils/date.utils.js';
import type { AuthenticatedRequest } from '../types/index.js';

import { getDashboardStats } from '../services/skud-dashboard.service.js';
import { getPresence } from '../services/skud-presence.service.js';
import { getPresenceByObject, filterPresenceByEmployeeIds, mergePresenceResponses } from '../services/skud-presence-by-object.service.js';
import { resolveAccessibleObjectIdsForRequest } from '../services/employee-skud-object-access.service.js';
import { getDisciplineViolations } from '../services/skud-discipline.service.js';
import { getDisciplineKpi, type KpiMetric } from '../services/discipline-kpi.service.js';
import {
  buildDisciplineWorkbook,
  buildDisciplineKpiWorkbook,
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
  getSelfHistoryLimitForUser,
  isSelfEmployeeRequest,
  resolveAccessibleEmployeeIds,
  resolveManagedDepartmentIds,
  resolveRequestDataScope,
  resolveScopedDepartmentId,
  hasObjectViewScope,
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

interface ISkudEventFailureResponse {
  id: number;
  employee_id: number | null;
  physical_person: string | null;
  card_number: string | null;
  event_date: string;
  event_time: string;
  event_at: string | null;
  access_point: string | null;
  direction: 'entry' | 'exit' | null;
  failure_type: string;
  failure_type_id: number | null;
  reason: string | null;
}

async function loadEmployeeEventFailuresForRequest(
  employeeId: number,
  startDate: unknown,
  endDate: unknown,
): Promise<ISkudEventFailureResponse[]> {
  const conditions: string[] = ['employee_id = $1'];
  const params: unknown[] = [employeeId];
  if (typeof startDate === 'string' && startDate) {
    params.push(startDate);
    conditions.push(`event_date >= $${params.length}`);
  }
  if (typeof endDate === 'string' && endDate) {
    params.push(endDate);
    conditions.push(`event_date <= $${params.length}`);
  }

  let data: Record<string, unknown>[] = [];
  try {
    data = await query<Record<string, unknown>>(
      `SELECT id, employee_id, physical_person, card_number, event_date, event_time, event_at, access_point, direction, failure_type, failure_type_id, reason
       FROM skud_event_failures
       WHERE ${conditions.join(' AND ')}
       ORDER BY event_date ASC, event_time ASC`,
      params,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[skud] loadEmployeeEventFailuresForRequest error:', message);
    return [];
  }
  return (data || []).map((row: Record<string, unknown>) => ({
    id: Number(row.id),
    employee_id: (row.employee_id as number | null) ?? null,
    physical_person: (row.physical_person as string | null) ?? null,
    card_number: (row.card_number as string | null) ?? null,
    event_date: String(row.event_date),
    event_time: String(row.event_time),
    event_at: (row.event_at as string | null) ?? null,
    access_point: (row.access_point as string | null) ?? null,
    direction: (row.direction as 'entry' | 'exit' | null) ?? null,
    failure_type: String(row.failure_type),
    failure_type_id: (row.failure_type_id as number | null) ?? null,
    reason: (row.reason as string | null) ?? null,
  }));
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
    const employeeRows = await query<{ full_name: string | null }>(
      'SELECT full_name FROM employees WHERE id = $1 LIMIT 1',
      [employeeId],
    );
    const employeeData = employeeRows[0];

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
          const employeeRows = await query<{ full_name: string | null }>(
            'SELECT full_name FROM employees WHERE id = $1 LIMIT 1',
            [employeeId],
          );
          resolvedFullName = employeeRows[0]?.full_name || null;
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
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (scope === 'department') {
    const managedDepartmentIds = await resolveManagedDepartmentIds(req);
    if (managedDepartmentIds.length === 0) {
      return new Set();
    }
    params.push(managedDepartmentIds);
    conditions.push(`department_id = ANY($${params.length}::uuid[])`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const data = await query<{ access_point_name: string; is_internal: boolean }>(
    `SELECT access_point_name, is_internal FROM skud_access_point_settings ${whereClause}`,
    params,
  );

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

  // Полный набор данных — только системному админу ('all'). Для 'self'
  // (пользователь без назначенного отдела/бригады) скоуп пуст: код ниже
  // через resolveManagedDepartmentIds → [] вернёт пустой результат.
  if (scope === 'all') {
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

  // Объектный view-скоуп (миграция 167 + объекты): дополнительно сужаем до видимого
  // набора (full-отделы + view∩объекты), иначе показались бы все члены view-отделов.
  const objectViewScope = await hasObjectViewScope(req);
  const accessibleEmployeeIds = objectViewScope ? await resolveAccessibleEmployeeIds(req) : null;

  const filteredEmployeeIds = Object.entries(data.employees)
    .filter(([employeeId, employee]) => {
      if (employee.department_id == null || !managedDepartmentIds.includes(employee.department_id)) return false;
      if (accessibleEmployeeIds && accessibleEmployeeIds !== 'all') return accessibleEmployeeIds.has(Number(employeeId));
      return true;
    })
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

const KPI_METRICS: KpiMetric[] = ['attendance', 'sick', 'unpaid'];

function parseKpiMetrics(raw: unknown): KpiMetric[] {
  if (typeof raw !== 'string' || !raw.trim()) return [...KPI_METRICS];
  const requested = raw.split(',').map(value => value.trim()).filter(Boolean);
  const filtered = KPI_METRICS.filter(metric => requested.includes(metric));
  return filtered.length > 0 ? filtered : [...KPI_METRICS];
}

type DisciplineKpiQuery = {
  scope: 'employee' | 'department';
  employeeId: number | null;
  departmentId: string | null;
  startMonth: string;
  endMonth: string;
  metrics: KpiMetric[];
};

function parseDisciplineKpiQuery(req: AuthenticatedRequest): DisciplineKpiQuery | { error: string } {
  const fallbackMonth = formatDateToISO(new Date()).slice(0, 7);
  const startMonth = (req.query.startMonth as string) || fallbackMonth;
  const endMonth = (req.query.endMonth as string) || startMonth;
  if (!MONTH_PATTERN.test(startMonth) || !MONTH_PATTERN.test(endMonth)) {
    return { error: 'Некорректный формат месяца. Используйте YYYY-MM' };
  }

  const scope: 'employee' | 'department' = req.query.scope === 'department' ? 'department' : 'employee';
  const employeeIdRaw = req.query.employee_id;
  const employeeId = typeof employeeIdRaw === 'string' && /^\d+$/.test(employeeIdRaw) ? Number(employeeIdRaw) : null;
  const departmentId = typeof req.query.department_id === 'string' && req.query.department_id.trim()
    ? req.query.department_id.trim()
    : null;

  if (scope === 'employee' && employeeId == null) return { error: 'Не указан сотрудник (employee_id)' };
  if (scope === 'department' && !departmentId) return { error: 'Не указан отдел (department_id)' };

  return { scope, employeeId, departmentId, startMonth, endMonth, metrics: parseKpiMetrics(req.query.metrics) };
}

/**
 * Резолвит целевой набор сотрудников для KPI с учётом уже применённого scope
 * (data — результат getScopedDisciplineData, ограниченный видимостью пользователя).
 * scope=employee: сотрудник должен входить в видимый набор. scope=department:
 * выбранный отдел + его потомки, пересечённые с видимым набором.
 */
async function resolveKpiTarget(
  scope: 'employee' | 'department',
  employeeId: number | null,
  departmentId: string | null,
  data: IDisciplineResult,
): Promise<{ employeeIds: number[]; subject: string; accessible: boolean }> {
  if (scope === 'employee') {
    if (employeeId == null || !data.employees[employeeId]) {
      return { employeeIds: [], subject: '', accessible: false };
    }
    return {
      employeeIds: [employeeId],
      subject: data.employees[employeeId].full_name || `#${employeeId}`,
      accessible: true,
    };
  }

  if (!departmentId) return { employeeIds: [], subject: '', accessible: false };
  const descendants = await query<{ id: string }>(
    'SELECT id FROM public.get_descendant_department_ids($1::uuid[])',
    [[departmentId]],
  );
  const deptSet = new Set([departmentId, ...(descendants || []).map(row => row.id)]);
  const employeeIds = Object.entries(data.employees)
    .filter(([, employee]) => employee.department_id != null && deptSet.has(employee.department_id))
    .map(([id]) => Number(id));
  return { employeeIds, subject: data.departments[departmentId] || 'Отдел', accessible: true };
}

function buildDisciplineEmployeeSummaries(data: IDisciplineResult): DisciplineExportEmployeeSummary[] {
  const map: Record<number, DisciplineExportEmployeeSummary> = {};

  // Базовые строки по ВСЕМ сотрудникам в скоупе (а не только нарушителям),
  // чтобы «Часов отработано/по графику» имели смысл за весь период.
  for (const [idStr, employee] of Object.entries(data.employees)) {
    const id = Number(idStr);
    map[id] = {
      employee_id: id,
      name: employee.full_name || `#${id}`,
      position: employee.position || '—',
      department: employee.department_id ? (data.departments[employee.department_id] || '—') : '—',
      departmentId: employee.department_id,
      late: 0,
      underwork: 0,
      early: 0,
      absence: 0,
      total: 0,
      worked_hours: employee.worked_hours ?? 0,
      norm_hours: employee.norm_hours ?? 0,
      violations: [],
    };
  }

  for (const violation of data.violations) {
    if (!map[violation.employee_id]) {
      map[violation.employee_id] = {
        employee_id: violation.employee_id,
        name: `#${violation.employee_id}`,
        position: '—',
        department: '—',
        departmentId: null,
        late: 0,
        underwork: 0,
        early: 0,
        absence: 0,
        total: 0,
        worked_hours: 0,
        norm_hours: 0,
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

  return Object.values(map).sort((left, right) =>
    left.department.localeCompare(right.department, 'ru') || left.name.localeCompare(right.name, 'ru'),
  );
}

function filterDisciplineEmployeeSummaries(
  employees: DisciplineExportEmployeeSummary[],
  filters: {
    departmentIds: string[];
    searchQuery: string;
    activeTab: DisciplineTab;
    onlyViolations: boolean;
  },
): DisciplineExportEmployeeSummary[] {
  let filtered = employees;

  if (filters.departmentIds.length > 0) {
    const set = new Set(filters.departmentIds);
    filtered = filtered.filter(employee => employee.departmentId !== null && set.has(employee.departmentId));
  }

  if (filters.searchQuery.trim()) {
    const normalizedQuery = filters.searchQuery.trim().toLowerCase();
    filtered = filtered.filter(employee => employee.name.toLowerCase().includes(normalizedQuery));
  }

  if (filters.onlyViolations) {
    filtered = filtered.filter(employee => employee.total > 0);
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
  force: z.enum(['1', 'true']).optional(),
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
      const { period, month, force } = parsed.data;

      const requestedDepartmentId = parsed.data.department_id ?? null;
      const departmentId = await resolveScopedDepartmentId(req, requestedDepartmentId);

      if (requestedDepartmentId && !departmentId) {
        res.status(403).json({
          success: false,
          error: 'Access denied to this department',
          code: 'DEPARTMENT_ACCESS_DENIED',
        });
        return;
      }
      if (!departmentId) {
        res.status(400).json({ success: false, error: 'department_id обязателен' });
        return;
      }

      // Объектный view-скоуп: сужаем сотрудников отдела до видимого набора (отделы ∩ объекты).
      let allowedEmployeeIds: Set<number> | undefined;
      if (await hasObjectViewScope(req)) {
        const acc = await resolveAccessibleEmployeeIds(req);
        if (acc !== 'all') allowedEmployeeIds = acc;
      }

      const data = await getDashboardStats({
        departmentId,
        period,
        month,
        showActualHours: !!req.user.show_actual_hours,
        force: !!force,
        allowedEmployeeIds,
      });
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

      const conditions: string[] = ['date >= $1', 'date <= $2'];
      const params: unknown[] = [startStr, endStr];

      const syncFilter = await getSyncFilteredEmployees();
      if (syncFilter) {
        const { empIds: allowedIds } = syncFilter;
        if (allowedIds.size > 0) {
          params.push([...allowedIds]);
          conditions.push(`employee_id = ANY($${params.length}::bigint[])`);
        } else {
          res.json({ success: true, data: [] });
          return;
        }
      }

      let data: unknown[];
      try {
        data = await query(
          `SELECT employee_id, date, first_entry, last_exit, total_hours, is_present
           FROM skud_daily_summary
           WHERE ${conditions.join(' AND ')}
           ORDER BY date`,
          params,
        );
      } catch (error) {
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
      if (isSelfEmployeeRequest(req, employeeId) && typeof startDate === 'string') {
        const selfLimit = getSelfHistoryLimitForUser(req.user);
        if (selfLimit.minDate !== null && startDate < selfLimit.minDate) {
          res.status(403).json({ success: false, error: selfLimit.message });
          return;
        }
      }

      const [{ events }, failures] = await Promise.all([
        loadEmployeeEventsForRequest(employeeId, startDate, endDate, {
          includeEmployeeName: false,
          preferFastSingleDay: true,
          useCache: true,
        }),
        loadEmployeeEventFailuresForRequest(employeeId, startDate, endDate),
      ]);
      res.json({ success: true, data: events, failures });
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

      if (isSelfEmployeeRequest(req, employeeId)) {
        const selfLimit = getSelfHistoryLimitForUser(req.user);
        if (selfLimit.minDate !== null && startDate < selfLimit.minDate) {
          res.status(403).json({ success: false, error: selfLimit.message });
          return;
        }
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

      const limit = searchStr ? 10000 : 1000;
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (startDate && typeof startDate === 'string') {
        params.push(startDate);
        conditions.push(`event_date >= $${params.length}`);
      }
      if (endDate && typeof endDate === 'string') {
        params.push(endDate);
        conditions.push(`event_date <= $${params.length}`);
      }
      if (accessPoint && typeof accessPoint === 'string') {
        params.push(accessPoint);
        conditions.push(`access_point = $${params.length}`);
      }
      if (employeeId && typeof employeeId === 'string') {
        params.push(parseInt(employeeId, 10));
        conditions.push(`employee_id = $${params.length}`);
      }

      const syncFilter = await getSyncFilteredEmployees();
      if (syncFilter) {
        const { empIds: allowedIds } = syncFilter;
        if (allowedIds.size > 0) {
          params.push([...allowedIds]);
          conditions.push(`employee_id = ANY($${params.length}::bigint[])`);
        } else {
          res.json({ success: true, data: [] });
          return;
        }
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      let data: Array<{
        id: number;
        physical_person: string;
        card_number: string | null;
        event_date: string;
        event_time: string;
        access_point: string | null;
        direction: string | null;
        employee_id: number | null;
      }> = [];
      try {
        data = await query(
          `SELECT id, physical_person, card_number, event_date, event_time, access_point, direction, employee_id
           FROM skud_events
           ${whereClause}
           ORDER BY event_date DESC, event_time DESC
           LIMIT ${limit}`,
          params,
        );
      } catch (error) {
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
   * GET /api/skud/event-failures
   * Ошибочные события Sigur (PASS_DENY, READER_ERROR, ...). Не участвуют
   * в расчётах табеля — только лог для UI и аудита.
   */
  async getEventFailures(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { startDate, endDate, employeeId, failureType, search } = req.query;
      const searchStr = typeof search === 'string' ? search.trim().toLowerCase() : '';
      const limit = Math.min(2000, Math.max(1, parseInt(String(req.query.limit ?? 500), 10) || 500));
      const offset = Math.max(0, parseInt(String(req.query.offset ?? 0), 10) || 0);

      // Проверяем whitelist scope ДО построения запроса. Если employeeId задан
      // и он не входит в allowed — сразу пусто. Если allowed пуст — сразу пусто.
      // Большой `.in('employee_id', [...тысячи_id])` НЕ передаём в PostgREST:
      // на большом каталоге это даёт UND_ERR_HEADERS_OVERFLOW (URL/headers > 16KB
      // у undici) и валит запрос с TypeError: fetch failed.
      const empIdNum = typeof employeeId === 'string' && employeeId ? parseInt(employeeId, 10) : NaN;
      const hasEmpIdFilter = !isNaN(empIdNum);

      const syncFilter = await getSyncFilteredEmployees();
      if (syncFilter) {
        const { empIds: allowedIds } = syncFilter;
        if (allowedIds.size === 0) {
          res.json({ success: true, data: [], total: 0 });
          return;
        }
        if (hasEmpIdFilter && !allowedIds.has(empIdNum)) {
          res.json({ success: true, data: [], total: 0 });
          return;
        }
        if (!hasEmpIdFilter) {
          // Без выбранного сотрудника не возвращаем глобальный лог: UI требует
          // сначала выбрать сотрудника, иначе .in(...) с тысячами id ломает PostgREST.
          res.json({ success: true, data: [], total: 0 });
          return;
        }
      }

      const conditions: string[] = [];
      const params: unknown[] = [];

      if (typeof startDate === 'string' && startDate) {
        params.push(startDate);
        conditions.push(`event_date >= $${params.length}`);
      }
      if (typeof endDate === 'string' && endDate) {
        params.push(endDate);
        conditions.push(`event_date <= $${params.length}`);
      }
      if (hasEmpIdFilter) {
        params.push(empIdNum);
        conditions.push(`employee_id = $${params.length}`);
      }
      if (typeof failureType === 'string' && failureType) {
        params.push(failureType);
        conditions.push(`failure_type = $${params.length}`);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      let data: Record<string, unknown>[] = [];
      try {
        data = await query<Record<string, unknown>>(
          `SELECT id, employee_id, physical_person, card_number, event_date, event_time, event_at, access_point, direction, failure_type, failure_type_id, reason
           FROM skud_event_failures
           ${whereClause}
           ORDER BY event_date DESC, event_time DESC
           LIMIT ${limit} OFFSET ${offset}`,
          params,
        );
      } catch (error) {
        console.error('getEventFailures error:', error);
        Sentry.captureException(error, { tags: { route: 'GET /api/skud/event-failures' } });
        res.status(500).json({ success: false, error: 'Failed to fetch event failures' });
        return;
      }

      const rows = (data || []).map((row: Record<string, unknown>) => ({
        id: Number(row.id),
        employee_id: (row.employee_id as number | null) ?? null,
        physical_person: (row.physical_person as string | null) ?? null,
        card_number: (row.card_number as string | null) ?? null,
        event_date: String(row.event_date),
        event_time: String(row.event_time),
        event_at: (row.event_at as string | null) ?? null,
        access_point: (row.access_point as string | null) ?? null,
        direction: (row.direction as 'entry' | 'exit' | null) ?? null,
        failure_type: String(row.failure_type),
        failure_type_id: (row.failure_type_id as number | null) ?? null,
        reason: (row.reason as string | null) ?? null,
      }));

      const filtered = searchStr
        ? rows.filter(r => (r.physical_person || '').toLowerCase().includes(searchStr))
        : rows;

      res.json({ success: true, data: filtered, total: filtered.length });
    } catch (error) {
      console.error('getEventFailures error:', error);
      Sentry.captureException(error, { tags: { route: 'GET /api/skud/event-failures' } });
      res.status(500).json({ success: false, error: 'Failed to fetch event failures' });
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

      let data: { access_point: string | null }[] = [];
      try {
        data = await query<{ access_point: string | null }>(
          `SELECT access_point FROM skud_events WHERE access_point IS NOT NULL LIMIT 5000`,
        );
      } catch (error) {
        console.error('Get access points error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch access points' });
        return;
      }

      const unique = sortAccessPointNames(
        new Set(
          (data || [])
            .map(row => normalizeAccessPointName(row.access_point))
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
        let data: { access_point_name: string; is_internal: boolean }[] = [];
        try {
          data = await query<{ access_point_name: string; is_internal: boolean }>(
            'SELECT access_point_name, is_internal FROM skud_access_point_settings',
          );
        } catch (error) {
          console.error('Get access point settings error:', error);
          res.status(500).json({ success: false, error: 'Ошибка получения настроек' });
          return;
        }

        const aggregated = new Map<string, boolean>();
        for (const row of data || []) {
          const name = row.access_point_name.trim();
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

      let data: { access_point_name: string; is_internal: boolean }[] = [];
      try {
        data = await query<{ access_point_name: string; is_internal: boolean }>(
          'SELECT access_point_name, is_internal FROM skud_access_point_settings WHERE department_id = $1',
          [departmentId],
        );
      } catch (error) {
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

      const departmentIdsRaw = typeof req.query.department_ids === 'string' ? req.query.department_ids
        : typeof req.query.department_id === 'string' ? req.query.department_id : '';
      const departmentIds = departmentIdsRaw.split(',').map(s => s.trim()).filter(Boolean);
      const searchQuery = typeof req.query.search === 'string' ? req.query.search : '';
      const onlyViolations = req.query.only_violations === '1' || req.query.only_violations === 'true';
      const data = await getScopedDisciplineData(req, startMonth, endMonth);
      const employees = buildDisciplineEmployeeSummaries(data);
      const source = filterDisciplineEmployeeSummaries(employees, {
        departmentIds,
        searchQuery,
        activeTab: tab as DisciplineTab,
        onlyViolations,
      });
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
   * GET /api/skud/discipline/kpi — KPI-сводка по сотруднику или отделу.
   */
  async getDisciplineKpi(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const parsed = parseDisciplineKpiQuery(req);
      if ('error' in parsed) {
        res.status(400).json({ success: false, error: parsed.error });
        return;
      }
      const { scope, employeeId, departmentId, startMonth, endMonth, metrics } = parsed;

      const data = await getScopedDisciplineData(req, startMonth, endMonth);
      const { employeeIds, subject, accessible } = await resolveKpiTarget(scope, employeeId, departmentId, data);
      if (scope === 'employee' && !accessible) {
        res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
        return;
      }

      const result = await getDisciplineKpi({ scope, subject, startMonth, endMonth, metrics, employeeIds, discipline: data });
      res.json({ success: true, data: result });
    } catch (error) {
      console.error('getDisciplineKpi error:', error);
      res.status(500).json({ success: false, error: 'Ошибка получения KPI дисциплины' });
    }
  },

  /**
   * GET /api/skud/discipline/kpi/export — KPI-сводка в Excel.
   */
  async exportDisciplineKpi(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const parsed = parseDisciplineKpiQuery(req);
      if ('error' in parsed) {
        res.status(400).json({ success: false, error: parsed.error });
        return;
      }
      const { scope, employeeId, departmentId, startMonth, endMonth, metrics } = parsed;

      const data = await getScopedDisciplineData(req, startMonth, endMonth);
      const { employeeIds, subject, accessible } = await resolveKpiTarget(scope, employeeId, departmentId, data);
      if (scope === 'employee' && !accessible) {
        res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
        return;
      }

      const result = await getDisciplineKpi({ scope, subject, startMonth, endMonth, metrics, employeeIds, discipline: data });
      const workbook = buildDisciplineKpiWorkbook(result);
      const buffer = await workbook.xlsx.writeBuffer();
      const fileName = sanitizeExportFileName(
        `KPI_дисциплины_${(subject || 'отчёт').replace(/\s+/g, '_')}_${formatMonthRangeLabel(startMonth, endMonth).replace(/\s+/g, '_')}.xlsx`,
      );

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      );
      res.send(Buffer.from(buffer));
    } catch (error) {
      console.error('exportDisciplineKpi error:', error);
      res.status(500).json({ success: false, error: 'Ошибка экспорта KPI дисциплины' });
    }
  },

  /**
   * GET /api/skud/presence
   */
  async getPresence(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const requestedDepartmentId = typeof req.query.department_id === 'string' ? req.query.department_id : null;
      const departmentId = await resolveScopedDepartmentId(req, requestedDepartmentId);
      // Без этой проверки запрос с недоступным department_id «тихо» падал в
      // getPresence({ departmentId: null }) → данные присутствия по всем отделам компании.
      if (requestedDepartmentId && !departmentId) {
        res.status(403).json({
          success: false,
          error: 'Access denied to this department',
          code: 'DEPARTMENT_ACCESS_DENIED',
        });
        return;
      }

      const data = await getPresence({ departmentId });
      res.json({ success: true, data });
    } catch (error) {
      console.error('Get presence error:', error);
      res.status(500).json({ success: false, error: 'Ошибка получения статусов' });
    }
  },

  /**
   * GET /api/skud/presence-by-object
   * Агрегированное присутствие по физическим объектам (travel_objects) и компаниям.
   * Режимы выдачи:
   *  - all      — админ/тех-юзер: полная картина по всем объектам;
   *  - object   — есть приписки в employee_skud_object_access: фильтр по object_ids;
   *  - employee — приписок нет, но есть скоуп сотрудников (руководитель без
   *               назначенных объектов): показываем его сотрудников на объектах,
   *               где они сейчас присутствуют.
   */
  async getPresenceByObject(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const scope = await resolveAccessibleObjectIdsForRequest(req);

      let data: Awaited<ReturnType<typeof getPresenceByObject>>;
      let scopeMode: 'all' | 'object' | 'employee' | 'object_employee';

      if (scope.is_unrestricted) {
        data = await getPresenceByObject({ allowedObjectIds: 'all' });
        scopeMode = 'all';
      } else if (scope.object_ids.length > 0) {
        data = await getPresenceByObject({ allowedObjectIds: scope.object_ids });
        // Объектный view-скоуп: на его объектах показываем только сотрудников его
        // view-отделов (отделы ∩ объекты), а не всех присутствующих на объекте.
        if (await hasObjectViewScope(req)) {
          const empIds = await resolveAccessibleEmployeeIds(req);
          if (empIds !== 'all') data = filterPresenceByEmployeeIds(data, empIds);
        }
        scopeMode = 'object';

        // Union: к назначенному объекту (целиком) добавляем доступных сотрудников
        // пользователя на ДРУГИХ объектах, где они сейчас присутствуют. Чужие объекты
        // помечаем is_partial — показаны только его люди, а не весь онлайн объекта.
        // object_id === null («Без объекта») в union не включаем.
        const unionEmpIds = await resolveAccessibleEmployeeIds(req);
        if (unionEmpIds !== 'all' && unionEmpIds.size > 0) {
          const all = await getPresenceByObject({ allowedObjectIds: 'all' });
          const mine = filterPresenceByEmployeeIds(all, unionEmpIds);
          const assignedSet = new Set(scope.object_ids);
          const elsewhere = mine.buckets
            .filter(b => b.object_id !== null && !assignedSet.has(b.object_id))
            .map(b => ({ ...b, is_partial: true }));
          if (elsewhere.length > 0) {
            data = mergePresenceResponses(data, { ...mine, buckets: elsewhere });
            scopeMode = 'object_employee';
          }
        }
      } else {
        const empIds = await resolveAccessibleEmployeeIds(req);
        if (empIds !== 'all' && empIds.size > 0) {
          const full = await getPresenceByObject({ allowedObjectIds: 'all' });
          data = filterPresenceByEmployeeIds(full, empIds);
          scopeMode = 'employee';
        } else {
          data = await getPresenceByObject({ allowedObjectIds: [] });
          scopeMode = 'object';
        }
      }

      res.json({
        success: true,
        data: {
          ...data,
          scope_mode: scopeMode,
          is_unrestricted: scope.is_unrestricted,
          assigned_object_ids: scope.object_ids,
        },
      });
    } catch (error) {
      console.error('Get presence by object error:', error);
      res.status(500).json({ success: false, error: 'Ошибка получения присутствия по объектам' });
    }
  },
};

/** Barrel export — все методы read + write, роуты не меняются */
export const skudController = {
  ...skudReadController,
  ...skudWriteController,
  ...skudTravelController,
};
