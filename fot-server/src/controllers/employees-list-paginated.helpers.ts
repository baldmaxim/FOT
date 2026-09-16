/**
 * GET /api/employees?page=… — постраничный режим списка (OFFSET, курсор по ФИО, курсор с
 * сортировкой по столбцу). Legacy-режим без page остаётся в employees.controller.
 *
 * Совместимость: без sort — прежнее поведение и next_cursor { name, id } (старый фронт после
 * деплоя бэка). С sort — строгие статус/период и next_cursor { name, key, isNull, id }.
 */
import type { Response } from 'express';
import { query, queryOne } from '../config/postgres.js';
import { auditService } from '../services/audit.service.js';
import { getKnownArchiveDepartment, reconcileFiredEmployeesArchiveDepartment } from '../services/employee-archive-department.service.js';
import { STAFF_COMMENT_LIST_COLUMNS_SQL } from '../services/employee-staff-comment.service.js';
import type { AuthenticatedRequest } from '../types/index.js';
import {
  KEYSET_NAME_SQL,
  mapEmployeeRows,
  parseKeysetParams,
  respondKeysetPage,
  type IKeysetParams,
} from './employees-list-page.helpers.js';
import {
  buildStaffBaseFilter,
  parseStaffPeriod,
  parseStaffStatus,
  periodConditionSql,
  resolveMonthRange,
  statusConditionSql,
} from './employees-staff-filter.helpers.js';
import {
  appendColumnFilters,
  parseStaffColumnFilters,
  StaffFilterUnavailableError,
} from './employees-staff-column-filters.helpers.js';
import {
  buildSortCursorSql,
  buildSortOrderSql,
  buildStaffSortKeySql,
  parseStaffSort,
  parseStaffSortCursor,
  StaffSortUnavailableError,
  type IStaffSort,
  type IStaffSortCursor,
} from './employees-staff-sort.helpers.js';

export const LIST_COLUMNS = 'id, full_name, position_id, email, org_department_id, employment_status, department_locked, is_archived, archived_at, created_at, updated_at, excluded_from_timesheet, excluded_from_timesheet_at';
// Оклады в «Управлении кадрами» не отдаются (ключ /salary/terms). Даты — для столбцов,
// dismissal_date — кнопке отмены запланированного увольнения, комментарий — столбцу «Комментарий».
export const STAFF_COLUMNS = `${LIST_COLUMNS}, hire_date, birth_date, dismissal_date, ${STAFF_COMMENT_LIST_COLUMNS_SQL}`;

const badRequest = (res: Response, error: string, code: string): void => {
  res.status(400).json({ success: false, error, code });
};

export async function respondEmployeesPage(req: AuthenticatedRequest, res: Response, t0: number): Promise<void> {
  const isStaffView = req.query.view === 'staff';
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  // «Текущие сотрудники» (view=staff) показывают до 1000 строк — таблица виртуализирована.
  const maxPageSize = isStaffView ? 1000 : 200;
  const pageSize = Math.min(maxPageSize, Math.max(1, parseInt(req.query.pageSize as string) || 50));
  const status = req.query.status as string | undefined;

  const sortParsed = parseStaffSort(req.query);
  if (!sortParsed.ok) return badRequest(res, 'Некорректная сортировка', 'INVALID_SORT');
  // «Исключённые» сортируются по дате исключения: столбцовая сортировка к ним не применяется.
  const sort = status === 'excluded' ? null : sortParsed.sort;

  let sortedAfter: IStaffSortCursor | null = null;
  let legacyKeyset: IKeysetParams | null = null;
  if (sort) {
    // Сортировка — только курсорная подгрузка; статус строгий.
    if (req.query.keyset !== '1') return badRequest(res, 'Сортировка доступна только с курсором', 'INVALID_SORT');
    if (!parseStaffStatus(status).ok) return badRequest(res, 'Некорректный статус', 'INVALID_STATUS');
    const cursor = parseStaffSortCursor(req.query);
    if (!cursor.ok) return badRequest(res, 'Некорректный курсор списка', 'INVALID_CURSOR');
    sortedAfter = cursor.after;
  } else {
    // keyset=1 — подгрузка порциями по курсору (ФИО, id): сдвиги между порциями не теряют строк.
    const keysetParsed = parseKeysetParams(req.query, status);
    if (!keysetParsed.ok) return badRequest(res, 'Некорректный курсор списка', 'INVALID_CURSOR');
    legacyKeyset = keysetParsed.keyset;
  }
  const periodParsed = parseStaffPeriod(req.query.period);
  if (!periodParsed.ok) return badRequest(res, 'Некорректный период', 'INVALID_PERIOD');
  const columnFiltersParsed = parseStaffColumnFilters(req.query.cf);
  if (!columnFiltersParsed.ok) return badRequest(res, 'Некорректные фильтры столбцов', 'INVALID_COLUMN_FILTERS');

  const filter = await buildStaffBaseFilter(req);
  if (filter.kind === 'error') {
    res.status(filter.status).json(filter.body);
    return;
  }
  if (filter.kind === 'empty') {
    res.json({ success: true, data: [], meta: { page, pageSize, total: 0, totalPages: 0 } });
    return;
  }

  if (status === 'fired' && filter.departmentId) {
    const archiveDepartment = await getKnownArchiveDepartment();
    if (archiveDepartment?.id === filter.departmentId) {
      await reconcileFiredEmployeesArchiveDepartment(req.user.id);
    }
  }

  const { whereParts, params, showArchived } = filter;
  const statusSql = statusConditionSql(status);
  if (statusSql) whereParts.push(statusSql);
  if (periodParsed.value) whereParts.push(periodConditionSql(periodParsed.value, resolveMonthRange(), params));
  try {
    await appendColumnFilters(whereParts, params, columnFiltersParsed.filters);
  } catch (error) {
    if (error instanceof StaffFilterUnavailableError) {
      res.status(409).json({ success: false, error: error.message, code: 'FILTER_UNAVAILABLE' });
      return;
    }
    throw error;
  }

  const selectCols = isStaffView ? STAFF_COLUMNS : LIST_COLUMNS;

  if (sort) {
    await respondSortedKeysetPage(req, res, { t0, selectCols, whereParts, params, pageSize, sort, after: sortedAfter, showArchived });
    return;
  }

  // id — тай-брейк: без него у однофамильцев порядок между запросами не детерминирован.
  const orderSql = status === 'excluded'
    ? 'ORDER BY excluded_from_timesheet_at DESC, id DESC'
    : `ORDER BY ${KEYSET_NAME_SQL} ASC, id ASC`;

  if (legacyKeyset) {
    await respondKeysetPage(req, res, { t0, selectCols, whereParts, params, orderSql, pageSize, keyset: legacyKeyset, showArchived });
    return;
  }

  const offset = (page - 1) * pageSize;
  params.push(pageSize);
  const limitIdx = params.length;
  params.push(offset);
  const offsetIdx = params.length;

  let data: Array<Record<string, unknown> & { total_count: number }>;
  let emptyPageTotal: number | null = null;
  try {
    data = await query<Record<string, unknown> & { total_count: number }>(
      `SELECT ${selectCols}, count(*) OVER ()::int AS total_count
         FROM employees
        WHERE ${whereParts.join(' AND ')}
        ${orderSql}
        LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    );
    // Страница за пределами результата: оконного count нет — считаем тем же WHERE.
    if (data.length === 0 && offset > 0) {
      const countRow = await queryOne<{ total: number | string }>(
        `SELECT count(*)::int AS total FROM employees WHERE ${whereParts.join(' AND ')}`,
        params.slice(0, limitIdx - 1),
      );
      emptyPageTotal = countRow ? Number(countRow.total) : 0;
    }
  } catch (err) {
    console.error('Get employees paginated error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch employees' });
    return;
  }

  const employees = await mapEmployeeRows(data, isStaffView);
  const total = data.length > 0 ? Number(data[0].total_count) : (emptyPageTotal ?? 0);

  auditService.logFromRequest(req, req.user.id, 'VIEW_EMPLOYEES', {
    details: { count: employees.length, page, archived: showArchived },
  }).catch((err: unknown) => console.error('[audit] VIEW_EMPLOYEES log failed:', err));

  console.log(`[getAll] Paginated page=${page} size=${pageSize} total=${total} in ${Date.now() - t0}ms`);
  res.json({
    success: true,
    data: employees,
    meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  });
}

interface ISortedPageInput {
  t0: number;
  selectCols: string;
  whereParts: string[];
  params: unknown[];
  pageSize: number;
  sort: IStaffSort;
  after: IStaffSortCursor | null;
  showArchived: boolean;
}

/**
 * Порция по курсору (ключ сортировки, id). Ключ вычисляется во внутреннем SELECT, порядок и
 * условие курсора — во внешнем по одной колонке sort_key. total — count без курсора.
 */
async function respondSortedKeysetPage(req: AuthenticatedRequest, res: Response, input: ISortedPageInput): Promise<void> {
  const { t0, selectCols, whereParts, params, pageSize, sort, after, showArchived } = input;
  const filterParams = [...params];
  const filterWhere = whereParts.join(' AND ');

  const pageParams = [...params];
  let sortKeySql: string;
  try {
    sortKeySql = await buildStaffSortKeySql(sort.key, pageParams);
  } catch (err) {
    if (err instanceof StaffSortUnavailableError) {
      res.status(409).json({ success: false, error: err.message, code: 'SORT_UNAVAILABLE' });
      return;
    }
    throw err;
  }
  const cursorSql = after ? `WHERE ${buildSortCursorSql('s', sort.dir, after, pageParams)}` : '';
  pageParams.push(pageSize + 1);
  const limitIdx = pageParams.length;

  let rows: Array<Record<string, unknown>>;
  let total: number;
  try {
    const [pageRows, countRow] = await Promise.all([
      query<Record<string, unknown>>(
        `SELECT s.*
           FROM (SELECT ${selectCols}, ${sortKeySql} AS sort_key
                   FROM employees
                  WHERE ${filterWhere}) s
          ${cursorSql}
          ${buildSortOrderSql('s', sort.dir)}
          LIMIT $${limitIdx}`,
        pageParams,
      ),
      queryOne<{ total: number | string }>(
        `SELECT count(*)::int AS total FROM employees WHERE ${filterWhere}`,
        filterParams,
      ),
    ]);
    rows = pageRows;
    total = countRow ? Number(countRow.total) : 0;
  } catch (err) {
    console.error('Get employees sorted page error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch employees' });
    return;
  }

  const hasMore = rows.length > pageSize;
  const kept = hasMore ? rows.slice(0, pageSize) : rows;
  const last = kept[kept.length - 1];
  const nextCursor = hasMore && last
    ? {
        name: typeof last.full_name === 'string' ? last.full_name : '',
        key: typeof last.sort_key === 'string' ? last.sort_key : null,
        isNull: typeof last.sort_key !== 'string',
        id: Number(last.id),
      }
    : null;

  // Служебный ключ сортировки клиенту не отдаётся.
  const employees = await mapEmployeeRows(
    kept.map(({ sort_key: _sortKey, ...row }) => row),
    req.query.view === 'staff',
  );

  auditService.logFromRequest(req, req.user.id, 'VIEW_EMPLOYEES', {
    details: { count: employees.length, keyset: true, sort: sort.key, dir: sort.dir, archived: showArchived },
  }).catch((err: unknown) => console.error('[audit] VIEW_EMPLOYEES log failed:', err));

  console.log(`[getAll] Sorted ${sort.key} ${sort.dir} after=${after ? after.id : '-'} size=${pageSize} total=${total} in ${Date.now() - t0}ms`);
  res.json({
    success: true,
    data: employees,
    meta: { page: 1, pageSize, total, totalPages: Math.ceil(total / pageSize), next_cursor: nextCursor },
  });
}
