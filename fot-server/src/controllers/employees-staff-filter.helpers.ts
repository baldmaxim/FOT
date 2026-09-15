/**
 * Общий фильтр «Управления кадрами» для GET /employees (постранично), счётчиков месяца и
 * выгрузки текущей таблицы. База — права, архивность, раздел, отдел, поиск, график; статус и
 * период добавляются отдельно: счётчикам месяца они не нужны (иначе на «Действующих» число
 * уволенных всегда было бы 0).
 */
import { query, queryOne } from '../config/postgres.js';
import {
  normalizeUuidParam,
  resolveManagedDepartmentIds,
  resolveScopedDepartmentId,
} from '../services/data-scope.service.js';
import { resolveEmployeeListReadScope } from '../services/employee-scope-filter.service.js';
import {
  buildSectionConditionSql,
  parseSectionParam,
  resolveSectionFilterContext,
} from '../services/employee-section-filter.service.js';
import { listExplicitDepartmentIdsForUser } from '../services/department-access.service.js';
import { listDirectSubordinates } from '../services/employee-direct-reports.service.js';
import { collectDeptIds } from '../services/skud-shared.service.js';
import { escapeLike } from '../utils/search.utils.js';
import { moscowTodayIso } from '../utils/date.utils.js';
import type { AuthenticatedRequest } from '../types/index.js';

export type StaffStatus = 'active' | 'fired' | 'excluded';
export type StaffPeriod = 'hired_month' | 'fired_month';

const STAFF_STATUSES: readonly StaffStatus[] = ['active', 'fired', 'excluded'];
const STAFF_PERIODS: readonly StaffPeriod[] = ['hired_month', 'fired_month'];

export interface IStaffBaseFilter {
  kind: 'ok';
  whereParts: string[];
  params: unknown[];
  /** Отдел из запроса после проверки доступа (null — без фильтра отдела). */
  departmentId: string | null;
  showArchived: boolean;
}

export type StaffBaseFilterResult =
  | IStaffBaseFilter
  /** Заведомо пустой результат (нет скоупа сотрудника, график без назначений). */
  | { kind: 'empty' }
  | { kind: 'error'; status: number; body: { success: false; error: string; code?: string } };

async function resolveDepartmentFilterIds(departmentId: string | null): Promise<string[] | null> {
  if (!departmentId) return null;
  const ids = await collectDeptIds(departmentId);
  return ids.length > 0 ? ids : [departmentId];
}

const LIST_ERROR = { success: false as const, error: 'Failed to fetch employees' };

/** Параметры запроса → условия WHERE для таблицы employees (без алиаса). */
export async function buildStaffBaseFilter(req: AuthenticatedRequest): Promise<StaffBaseFilterResult> {
  const { scope, globalRead } = await resolveEmployeeListReadScope(req);
  if (!scope) {
    return { kind: 'error', status: 403, body: { success: false, error: 'Data scope не настроен для роли' } };
  }
  const showArchived = req.query.archived === 'true';
  const sectionParam = parseSectionParam(req.query.section);
  if (!sectionParam.ok) {
    return { kind: 'error', status: 400, body: { success: false, error: 'Некорректный раздел', code: 'INVALID_SECTION' } };
  }
  const sectionContext = sectionParam.section
    ? await resolveSectionFilterContext(req, sectionParam.section, globalRead)
    : null;
  const requestedDepartmentId = typeof req.query.department_id === 'string' ? req.query.department_id : null;
  const departmentId = globalRead
    ? normalizeUuidParam(requestedDepartmentId)
    : await resolveScopedDepartmentId(req, requestedDepartmentId);
  // Явно запрошенный недоступный отдел — отказ, а не «тихий» полный список.
  if (requestedDepartmentId && !departmentId) {
    return {
      kind: 'error',
      status: 403,
      body: { success: false, error: 'Access denied to this department', code: 'DEPARTMENT_ACCESS_DENIED' },
    };
  }
  const managedDepartmentIds = scope === 'department' && !requestedDepartmentId
    ? await resolveManagedDepartmentIds(req)
    : [];
  const departmentFilterIds = requestedDepartmentId
    ? await resolveDepartmentFilterIds(departmentId)
    : (managedDepartmentIds.length > 0 ? managedDepartmentIds : await resolveDepartmentFilterIds(departmentId));
  // Сам руководитель и его прямые подчинённые из чужих отделов (как в табеле).
  let selfEmployeeIdToInclude: number | null = null;
  let directReportIds: number[] = [];
  if (scope === 'department' && req.user.employee_id) {
    const explicitDeptIds = await listExplicitDepartmentIdsForUser(req.user.id, req.user.employee_id);
    directReportIds = await listDirectSubordinates(req.user.employee_id);
    if (explicitDeptIds.length > 0 || directReportIds.length > 0) {
      selfEmployeeIdToInclude = req.user.employee_id;
    }
  }
  const additionalEmployeeIds = [...new Set([
    ...directReportIds,
    ...(selfEmployeeIdToInclude != null ? [selfEmployeeIdToInclude] : []),
  ])];

  const params: unknown[] = [showArchived];
  const whereParts: string[] = [`is_archived = $${params.length}`];

  if (scope === 'self') {
    if (!req.user.employee_id) return { kind: 'empty' };
    params.push(req.user.employee_id);
    whereParts.push(`id = $${params.length}`);
  } else if (departmentFilterIds?.length) {
    params.push(departmentFilterIds);
    const deptIdx = params.length;
    if (additionalEmployeeIds.length > 0) {
      params.push(additionalEmployeeIds);
      whereParts.push(`(org_department_id = ANY($${deptIdx}::uuid[]) OR id = ANY($${params.length}::int[]))`);
    } else {
      whereParts.push(`org_department_id = ANY($${deptIdx}::uuid[])`);
    }
  } else if (additionalEmployeeIds.length > 0) {
    params.push(additionalEmployeeIds);
    whereParts.push(`id = ANY($${params.length}::int[])`);
  } else if (scope === 'department') {
    // department-scope без отделов и без назначений — не отдаём всю таблицу.
    return { kind: 'empty' };
  }

  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  if (search) {
    params.push(`%${escapeLike(search)}%`);
    whereParts.push(`full_name ILIKE $${params.length}`);
  }
  if (sectionContext) {
    whereParts.push(buildSectionConditionSql(sectionContext, 'employees', params));
  }

  // График: schedule_id=<uuid> или __default__ (legacy). «Сегодня» — Europe/Moscow.
  const scheduleParam = typeof req.query.schedule_id === 'string' ? req.query.schedule_id.trim() : '';
  if (scheduleParam) {
    const today = moscowTodayIso();
    let isDefaultRequested = false;
    if (scheduleParam === '__default__') {
      isDefaultRequested = true;
    } else {
      try {
        const tplRow = await queryOne<{ is_default: boolean | null }>(
          'SELECT is_default FROM work_schedules WHERE id = $1',
          [scheduleParam],
        );
        isDefaultRequested = !!tplRow?.is_default;
      } catch (tplErr) {
        console.error('Get schedule template error:', tplErr);
        return { kind: 'error', status: 500, body: LIST_ERROR };
      }
    }

    let activeAss: Array<{ employee_id: number; schedule_id: string }>;
    try {
      activeAss = await query<{ employee_id: number; schedule_id: string }>(
        `SELECT employee_id, schedule_id
           FROM employee_schedule_assignments
          WHERE effective_from <= $1
            AND (effective_to IS NULL OR effective_to >= $1)`,
        [today],
      );
    } catch (assErr) {
      console.error('Get schedule assignments error:', assErr);
      return { kind: 'error', status: 500, body: LIST_ERROR };
    }

    if (isDefaultRequested) {
      const excluded = [...new Set(
        activeAss.filter(r => r.schedule_id !== scheduleParam).map(r => Number(r.employee_id)),
      )];
      if (excluded.length > 0) {
        params.push(excluded);
        whereParts.push(`id <> ALL($${params.length}::int[])`);
      }
    } else {
      const ids = [...new Set(
        activeAss.filter(r => r.schedule_id === scheduleParam).map(r => Number(r.employee_id)),
      )];
      if (ids.length === 0) return { kind: 'empty' };
      params.push(ids);
      whereParts.push(`id = ANY($${params.length}::int[])`);
    }
  }

  return { kind: 'ok', whereParts, params, departmentId, showArchived };
}

export type StrictParseResult<T> = { ok: true; value: T } | { ok: false };

/** Строгий статус (новые клиенты и новые эндпоинты): нет параметра — active. */
export function parseStaffStatus(value: unknown): StrictParseResult<StaffStatus> {
  if (value === undefined || value === '') return { ok: true, value: 'active' };
  return typeof value === 'string' && (STAFF_STATUSES as readonly string[]).includes(value)
    ? { ok: true, value: value as StaffStatus }
    : { ok: false };
}

/** Период «с начала месяца»: нет параметра — null. */
export function parseStaffPeriod(value: unknown): StrictParseResult<StaffPeriod | null> {
  if (value === undefined || value === '') return { ok: true, value: null };
  return typeof value === 'string' && (STAFF_PERIODS as readonly string[]).includes(value)
    ? { ok: true, value: value as StaffPeriod }
    : { ok: false };
}

/** Первое число месяца и «сегодня» по Москве — на каждый запрос, не при импорте. */
export function resolveMonthRange(now: Date = new Date()): { monthStart: string; today: string } {
  const today = moscowTodayIso(now);
  return { monthStart: `${today.slice(0, 7)}-01`, today };
}

/** Условие статуса, как было в списке: неизвестный статус (legacy) — без условия. */
export function statusConditionSql(status: string | undefined): string | null {
  if (status === 'fired') return `employment_status = 'fired'`;
  if (status === 'excluded') return `excluded_from_timesheet = true AND employment_status <> 'fired'`;
  if (status === 'active' || !status) return `employment_status <> 'fired'`;
  return null;
}

/** Условие периода месяца; параметры дописываются в params. */
export function periodConditionSql(
  period: StaffPeriod,
  range: { monthStart: string; today: string },
  params: unknown[],
): string {
  params.push(range.monthStart);
  const fromIdx = params.length;
  params.push(range.today);
  const column = period === 'hired_month' ? 'hire_date' : 'dismissal_date';
  return `${column} BETWEEN $${fromIdx}::date AND $${params.length}::date`;
}
