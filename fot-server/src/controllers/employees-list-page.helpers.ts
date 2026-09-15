/**
 * Постраничный список GET /api/employees: преобразование строк и курсорный режим (keyset=1).
 *
 * Курсор (ФИО, id) вместо OFFSET нужен подгрузке «Текущих сотрудников» порциями: если между
 * порциями кого-то добавили или уволили, OFFSET сдвигал бы следующую порцию — строка
 * повторялась бы или пропадала. Сортировка и условие курсора используют одно выражение имени,
 * поэтому порядок и сравнение идут по одной коллации.
 */
import type { Response } from 'express';
import { query, queryOne } from '../config/postgres.js';
import { auditService } from '../services/audit.service.js';
import { loadStructureCache, decryptEmployeeList } from '../services/employee-mapper.service.js';
import { getAllDepartmentsTree } from '../services/skud-shared.service.js';
import { buildSignDepartmentIndex, resolveEmployeeSign } from '../utils/employee-sign.js';
import type { AuthenticatedRequest, EmployeeEncrypted } from '../types/index.js';

/** Имя для сортировки и курсора: колонка допускает NULL, а (NULL, id) > (...) выбросил бы строку. */
export const KEYSET_NAME_SQL = "COALESCE(full_name, '')";

export interface IKeysetCursor {
  name: string;
  id: number;
}

export interface IKeysetParams {
  /** null — первая порция. */
  after: IKeysetCursor | null;
}

export type KeysetParseResult =
  | { ok: true; keyset: IKeysetParams | null }
  | { ok: false };

/**
 * keyset=1 включает курсорный режим; after_name + after_id — оба или ни одного.
 * Для «Исключённых» (сортировка по дате исключения) курсор по ФИО неприменим — отказ.
 */
export function parseKeysetParams(queryParams: Record<string, unknown>, status: string | undefined): KeysetParseResult {
  const enabled = queryParams.keyset === '1';
  const hasName = queryParams.after_name !== undefined;
  const hasId = queryParams.after_id !== undefined;
  if (!enabled) return hasName || hasId ? { ok: false } : { ok: true, keyset: null };
  if (status === 'excluded') return { ok: false };
  if (hasName !== hasId) return { ok: false };
  if (!hasName) return { ok: true, keyset: { after: null } };

  const name = queryParams.after_name;
  const idRaw = queryParams.after_id;
  if (typeof name !== 'string' || typeof idRaw !== 'string' || !/^\d+$/.test(idRaw)) return { ok: false };
  const id = Number(idRaw);
  if (!Number.isSafeInteger(id) || id <= 0) return { ok: false };
  return { ok: true, keyset: { after: { name, id } } };
}

/** Строки employees → ответ списка; для view=staff — дата рождения и признак сотрудника. */
export async function mapEmployeeRows(
  rows: Array<Record<string, unknown>>,
  isStaffView: boolean,
): Promise<Array<Record<string, unknown>>> {
  const structureCache = await loadStructureCache();
  const signIndex = isStaffView ? buildSignDepartmentIndex(await getAllDepartmentsTree()) : null;
  return rows.map(emp => {
    const mapped = decryptEmployeeList(emp as unknown as EmployeeEncrypted, structureCache);
    if (!signIndex) return mapped as unknown as Record<string, unknown>;
    return {
      ...mapped,
      birth_date: typeof emp.birth_date === 'string' ? emp.birth_date : null,
      sign: resolveEmployeeSign({
        employmentStatus: mapped.employment_status,
        departmentId: mapped.org_department_id,
        deptById: signIndex,
      }),
    };
  });
}

interface IKeysetPageInput {
  t0: number;
  selectCols: string;
  /** Условия фильтров без курсора (права, отдел, раздел, статус, поиск, график). */
  whereParts: string[];
  params: unknown[];
  orderSql: string;
  pageSize: number;
  keyset: IKeysetParams;
  showArchived: boolean;
}

/**
 * Порция по курсору: LIMIT pageSize + 1 (лишняя строка — признак следующей порции),
 * total — отдельный count с теми же фильтрами, но без курсора (иначе был бы остаток).
 */
export async function respondKeysetPage(
  req: AuthenticatedRequest,
  res: Response,
  input: IKeysetPageInput,
): Promise<void> {
  const { t0, selectCols, whereParts, params, orderSql, pageSize, keyset, showArchived } = input;
  const filterWhere = whereParts.join(' AND ');
  const filterParams = [...params];

  const pageParams = [...params];
  const pageWhere = [...whereParts];
  if (keyset.after) {
    pageParams.push(keyset.after.name);
    const nameIdx = pageParams.length;
    pageParams.push(keyset.after.id);
    pageWhere.push(`(${KEYSET_NAME_SQL}, id) > ($${nameIdx}::text, $${pageParams.length}::int)`);
  }
  pageParams.push(pageSize + 1);
  const limitIdx = pageParams.length;

  let rows: Array<Record<string, unknown>>;
  let total: number;
  try {
    const [pageRows, countRow] = await Promise.all([
      query<Record<string, unknown>>(
        `SELECT ${selectCols}
           FROM employees
          WHERE ${pageWhere.join(' AND ')}
          ${orderSql}
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
    console.error('Get employees keyset page error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch employees' });
    return;
  }

  const hasMore = rows.length > pageSize;
  const pageRowsKept = hasMore ? rows.slice(0, pageSize) : rows;
  const last = pageRowsKept[pageRowsKept.length - 1];
  const nextCursor: IKeysetCursor | null = hasMore && last
    ? { name: typeof last.full_name === 'string' ? last.full_name : '', id: Number(last.id) }
    : null;

  const employees = await mapEmployeeRows(pageRowsKept, req.query.view === 'staff');

  auditService.logFromRequest(req, req.user.id, 'VIEW_EMPLOYEES', {
    details: { count: employees.length, keyset: true, archived: showArchived },
  }).catch((err: unknown) => console.error('[audit] VIEW_EMPLOYEES log failed:', err));

  console.log(`[getAll] Keyset after=${keyset.after ? keyset.after.id : '-'} size=${pageSize} total=${total} in ${Date.now() - t0}ms`);
  res.json({
    success: true,
    data: employees,
    meta: {
      page: 1,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
      next_cursor: nextCursor,
    },
  });
}
