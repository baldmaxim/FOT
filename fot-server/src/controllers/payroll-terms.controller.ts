/**
 * Условия оплаты сотрудников: чтение истории и назначение (в т.ч. массовое).
 *
 * Скоуп проверяется по каждому сотруднику отдельно (canEditEmployeeInScope):
 * ролевого права на страницу мало — бухгалтер подразделения не должен править
 * условия чужих людей. Массовое назначение возвращает отчёт «применено / отклонено»,
 * а не молча пропускает недоступных.
 */
import type { Response } from 'express';
import { z } from 'zod';

import type { AuthenticatedRequest } from '../types/index.js';
import { query, queryOne } from '../config/postgres.js';
import { getContractorRootId } from '../config/contractor.js';
import {
  appendPayrollColumnFilters,
  buildPayrollCursorSql,
  buildPayrollOrderSql,
  isPayrollValueFilterColumn,
  parsePayrollColumnFilters,
  parsePayrollSort,
  parsePayrollSortCursor,
  payrollSortKeySql,
  payrollValueKeySql,
  payrollValueOrderSql,
  type IPayrollSortCursor,
} from './payroll-terms-list.helpers.js';
import {
  canAccessEmployeeInScope,
  canEditEmployeeInScope,
  resolveAccessibleDepartmentIds,
} from '../services/data-scope.service.js';
import { auditService } from '../services/audit.service.js';
import {
  assignTerms,
  assignTermsBulk,
  getTermsHistory,
  getTermsOnDate,
  type IAssignResult,
} from '../services/payroll/payroll-terms.service.js';

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ожидается YYYY-MM-DD');
const moneySchema = z.coerce.number().positive('Сумма должна быть больше нуля');
/** Премия и проживание могут быть нулевыми: 0 — «явно не положено», отсутствие — «не задано». */
const optionalMoneySchema = z.coerce.number().min(0, 'Сумма не может быть отрицательной').optional();

/**
 * Сумма привязана к виду оплаты: у оклада — monthly_salary, у почасовой — hourly_rate.
 * Тот же XOR стоит в БД (payroll_terms_amount_xor); дублируем здесь, чтобы вернуть
 * пользователю понятный текст, а не 500 от констрейнта.
 */
const termsBodySchema = z.object({
  staff_category: z.enum(['office', 'itr', 'worker']),
  calc_type: z.enum(['salary', 'hourly']),
  monthly_salary: moneySchema.optional(),
  hourly_rate: moneySchema.optional(),
  bonus_amount: optionalMoneySchema,
  housing_compensation: optionalMoneySchema,
  staff_units: z.coerce.number().positive().max(2).optional(),
  organization_id: z.string().uuid().nullable().optional(),
  effective_from: dateSchema,
  change_reason: z.string().trim().max(500).optional(),
  order_number: z.string().trim().max(100).optional(),
  order_date: dateSchema.optional(),
  note: z.string().trim().max(1000).optional(),
}).superRefine((value, ctx) => {
  if (value.calc_type === 'salary' && value.monthly_salary === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Для оплаты по графику нужен оклад' });
  }
  if (value.calc_type === 'hourly' && value.hourly_rate === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Для почасовой оплаты нужна часовая ставка' });
  }
});

const bulkBodySchema = z.object({
  employee_ids: z.array(z.coerce.number().int().positive()).min(1).max(500),
}).and(termsBodySchema);

function handleZodError(error: unknown, res: Response): boolean {
  if (error instanceof z.ZodError) {
    res.status(400).json({ success: false, error: error.errors[0]?.message ?? 'Некорректные данные' });
    return true;
  }
  return false;
}

/** GET /api/payroll/terms/employee/:empId — история условий сотрудника. */
const getByEmployee = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = Number(req.params.empId);
    if (!Number.isInteger(employeeId) || !(await canAccessEmployeeInScope(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }
    const data = await getTermsHistory(employeeId);
    res.json({ success: true, data });
  } catch (err) {
    console.error('payrollTerms.getByEmployee error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения условий оплаты' });
  }
};

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;
/** Вариантов в списке фильтра столбца; на один больше — признак «показаны не все». */
const COLUMN_VALUES_LIMIT = 300;

/** Экранирует %, _ и \ — иначе ввод «50%» в поиске работал бы как шаблон. */
const toIlikePattern = (value: string): string => `%${value.replace(/[\\%_]/g, char => `\\${char}`)}%`;

/**
 * Общая часть выборки списка и вариантов фильтра. Параметры $1–$8:
 * $1 дата, $2 подразделение, $3 категория, $4 вид оплаты, $5 «только без условий»,
 * $6 корень подрядчиков, $7 доступные отделы, $8 поиск.
 *
 * scoped   — свой штат в скоупе пользователя (без фильтров по условиям оплаты);
 * filtered — scoped + фильтры по категории / виду оплаты / «только без условий» + фильтры столбцов.
 *
 * «Без условий» считается по scoped, а не по filtered: при фильтре «Категория: Офис»
 * сотрудники без условий в выборку не попадают по определению, и счётчик показал бы 0,
 * хотя люди, которые не попадут в расчёт, есть.
 *
 * Подрядчики исключаются через NOT EXISTS, а не NOT IN: у сотрудника без отдела
 * `NULL IN (...)` даёт NULL, и он молча выпал бы из списка.
 *
 * График — имя графика на дату выборки, как у «Текущих сотрудников»: последнее действующее
 * назначение по дате начала, иначе график по умолчанию. Считается в SQL, чтобы ячейка,
 * сортировка и фильтр по графику совпадали.
 */
const buildBaseCtes = (columnFilterSql: string): string => `
  WITH contractor_depts AS (
    SELECT id FROM public.get_descendant_department_ids(ARRAY[$6::uuid])
     WHERE $6::uuid IS NOT NULL
  ),
  -- Фильтр подразделения — поддерево: выбрали департамент, видны все его бригады.
  filter_depts AS (
    SELECT id FROM public.get_descendant_department_ids(ARRAY[$2::uuid])
     WHERE $2::uuid IS NOT NULL
  ),
  default_schedule AS (
    SELECT NULLIF(btrim(w.name), '') AS name FROM work_schedules w WHERE w.is_default ORDER BY w.id LIMIT 1
  ),
  scoped AS (
    SELECT e.id   AS employee_id,
           e.full_name,
           e.tab_number,
           d.id   AS department_id,
           d.name AS department_name,
           p.name AS position_name,
           COALESCE(
             (SELECT NULLIF(btrim(ws.name), '')
                FROM (SELECT a.schedule_id
                        FROM employee_schedule_assignments a
                       WHERE a.employee_id = e.id
                         AND a.effective_from <= $1::date
                         AND (a.effective_to IS NULL OR a.effective_to >= $1::date)
                       ORDER BY a.effective_from DESC, a.id DESC
                       LIMIT 1) cur
                LEFT JOIN work_schedules ws ON ws.id = cur.schedule_id),
             (SELECT name FROM default_schedule)
           ) AS schedule_name,
           t.id   AS terms_id,
           t.staff_category,
           t.calc_type,
           t.monthly_salary,
           t.hourly_rate,
           t.bonus_amount,
           t.housing_compensation,
           t.staff_units,
           t.effective_from,
           t.effective_to
      FROM employees e
      LEFT JOIN org_departments d ON d.id = e.org_department_id
      LEFT JOIN positions p ON p.id = e.position_id
      LEFT JOIN payroll_compensation_terms t
             ON t.employee_id = e.id
            AND t.effective_from <= $1::date
            AND (t.effective_to IS NULL OR t.effective_to >= $1::date)
     WHERE e.employment_status = 'active'
       AND e.is_archived IS NOT TRUE
       AND ($2::uuid IS NULL OR e.org_department_id IN (SELECT id FROM filter_depts))
       AND NOT EXISTS (SELECT 1 FROM contractor_depts c WHERE c.id = e.org_department_id)
       AND ($7::uuid[] IS NULL OR e.org_department_id = ANY($7::uuid[]))
       AND ($8::text IS NULL OR e.full_name ILIKE $8::text OR e.tab_number ILIKE $8::text)
  ),
  filtered AS (
    SELECT * FROM scoped
     WHERE ($3::text IS NULL OR staff_category = $3::text)
       AND ($4::text IS NULL OR calc_type = $4::text)
       AND ($5::boolean IS NOT TRUE OR terms_id IS NULL)${columnFilterSql ? `\n       AND ${columnFilterSql}` : ''}
  )`;

/**
 * Список: итоги + порция. Параметры $9 LIMIT, $10 OFFSET, $11/$12 — курсор прежнего порядка
 * (ФИО, id) для старого фронта; сортировка по столбцу и её курсор — параметры с $13.
 *
 * Порции по курсору: экран подгружает список при прокрутке, и между порциями никто не
 * теряется и не повторяется, даже если штат изменился. Итоги считаются без курсора.
 * sort_key_text — ключ последней строки текстом: из него строится next_cursor без потери
 * точности числового ключа.
 */
const buildListSql = (options: {
  columnFilterSql: string;
  sortKeySql: string;
  cursorSql: string;
  orderSql: string;
}): string => `${buildBaseCtes(options.columnFilterSql)},
  keyed AS (
    SELECT filtered.*, ${options.sortKeySql} AS sort_key FROM filtered
  )
  SELECT
    (SELECT count(*) FROM filtered)                          AS total,
    (SELECT count(*) FROM scoped WHERE terms_id IS NULL)     AS without_terms_total,
    (SELECT count(*) FROM scoped WHERE terms_id IS NOT NULL) AS with_terms_total,
    COALESCE((
      -- ORDER BY внутри json_agg: next_cursor берётся из последнего элемента массива,
      -- порядок подзапроса агрегат гарантированно не сохраняет.
      SELECT json_agg(p ORDER BY ${options.orderSql.replace(/\bk\./g, 'p.')})
        FROM (SELECT k.*, k.sort_key::text AS sort_key_text FROM keyed k
               WHERE ${options.cursorSql}
               ORDER BY ${options.orderSql}
               LIMIT $9 OFFSET $10) p
    ), '[]'::json) AS rows`;

/** Прежний порядок и курсор (ФИО, id): без параметра sort — как до сортировки по столбцам. */
const LEGACY_SORT_KEY_SQL = `COALESCE(full_name, '')`;
const LEGACY_CURSOR_SQL = `($12::int IS NULL OR (k.sort_key, k.employee_id) > ($11::text, $12::int))`;
const LEGACY_ORDER_SQL = `k.sort_key, k.employee_id`;

/** Строка списка (json_agg отдаёт NUMERIC числами, sort_key_text — текстом). */
interface IPayrollTermsListRow {
  employee_id: number;
  full_name: string | null;
  tab_number: string | null;
  department_id: string | null;
  department_name: string | null;
  position_name: string | null;
  schedule_name: string | null;
  terms_id: number | null;
  staff_category: string | null;
  calc_type: string | null;
  monthly_salary: string | number | null;
  hourly_rate: string | number | null;
  bonus_amount: string | number | null;
  housing_compensation: string | number | null;
  staff_units: string | number | null;
  effective_from: string | null;
  effective_to: string | null;
  sort_key?: unknown;
  sort_key_text?: string | null;
}

/** Параметры выборки, общие для списка и вариантов фильтра. */
const baseQuerySchema = z.object({
  date: dateSchema.optional(),
  department_id: z.string().uuid().optional(),
  staff_category: z.enum(['office', 'itr', 'worker']).optional(),
  calc_type: z.enum(['salary', 'hourly']).optional(),
  without_terms: z.enum(['true', 'false']).optional(),
  q: z.string().trim().max(100).optional(),
});

type BaseQuery = z.infer<typeof baseQuerySchema>;

/** $1–$8 для buildBaseCtes. */
const buildBaseParams = async (req: AuthenticatedRequest, query: BaseQuery) => {
  const onDate = query.date ?? new Date().toISOString().slice(0, 10);
  const accessible = await resolveAccessibleDepartmentIds(req);
  // Корень «Подрядные организации» не найден — подрядчиков не исключаем, но говорим
  // об этом экрану: молча показать лишних людей в зарплатном списке нельзя.
  const contractorRootId = await getContractorRootId();
  const params: unknown[] = [
    onDate,
    query.department_id ?? null,
    query.staff_category ?? null,
    query.calc_type ?? null,
    query.without_terms === 'true',
    contractorRootId,
    accessible === 'all' ? null : accessible,
    query.q ? toIlikePattern(query.q) : null,
  ];
  return { onDate, contractorRootId, params };
};

const badRequest = (res: Response, error: string, code: string): void => {
  res.status(400).json({ success: false, error, code });
};

/**
 * GET /api/payroll/terms — список условий оплаты своего штата.
 *
 * Отдаёт и тех, у кого условий нет: без них сотрудник не попадёт в расчёт,
 * и такой пропуск должен быть виден на экране, а не обнаружиться в день выплаты.
 *
 * Поиск, фильтры столбцов, сортировка и порции — на сервере: список больше одной порции,
 * и сортировка в браузере переставляла бы только загруженные строки.
 */
const list = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const parsed = baseQuerySchema.extend({
      page: z.coerce.number().int().min(1).default(1),
      page_size: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE, `Не больше ${MAX_PAGE_SIZE} строк на страницу`)
        .default(DEFAULT_PAGE_SIZE),
    }).parse(req.query);

    const query = req.query as Record<string, unknown>;

    const sortResult = parsePayrollSort(query);
    if (!sortResult.ok) return badRequest(res, 'Некорректная сортировка', 'INVALID_SORT');
    const { sort } = sortResult;

    const filtersResult = parsePayrollColumnFilters(query.cf);
    if (!filtersResult.ok) return badRequest(res, 'Некорректные фильтры столбцов', 'INVALID_COLUMN_FILTERS');

    const { onDate, contractorRootId, params } = await buildBaseParams(req, parsed);

    // Прежний курсор (ФИО, id) — только без сортировки по столбцу.
    let legacyAfter: { name: string; id: number } | null = null;
    let sortedAfter: IPayrollSortCursor | null = null;
    if (sort) {
      const cursor = parsePayrollSortCursor(query, payrollSortKeySql(sort.key).cast);
      if (!cursor.ok) return badRequest(res, 'Некорректный курсор списка', 'INVALID_CURSOR');
      sortedAfter = cursor.after;
    } else {
      const legacy = z.object({
        after_name: z.string().max(300).optional(),
        after_id: z.coerce.number().int().positive().optional(),
      }).safeParse(query);
      const hasName = legacy.success && legacy.data.after_name !== undefined;
      const hasId = legacy.success && legacy.data.after_id !== undefined;
      if (!legacy.success || hasName !== hasId) {
        return badRequest(res, 'Курсор списка задаётся парой after_name и after_id', 'INVALID_CURSOR');
      }
      if (legacy.data.after_name !== undefined && legacy.data.after_id !== undefined) {
        legacyAfter = { name: legacy.data.after_name, id: legacy.data.after_id };
      }
    }

    const hasCursor = legacyAfter !== null || sortedAfter !== null;
    // С курсором порция отсчитывается от него, номер страницы не участвует.
    const offset = hasCursor ? 0 : (parsed.page - 1) * parsed.page_size;
    params.push(parsed.page_size, offset, legacyAfter?.name ?? null, legacyAfter?.id ?? null);

    const whereParts: string[] = [];
    appendPayrollColumnFilters(whereParts, params, filtersResult.filters);

    const sql = buildListSql({
      columnFilterSql: whereParts.join('\n       AND '),
      sortKeySql: sort ? payrollSortKeySql(sort.key).sql : LEGACY_SORT_KEY_SQL,
      // $11/$12 при сортировке по столбцу всегда NULL, но упомянуты в SQL: неиспользованный
      // параметр PostgreSQL отвергает («could not determine data type of parameter»).
      cursorSql: sort
        ? `$11::text IS NULL AND $12::int IS NULL AND ${sortedAfter ? buildPayrollCursorSql('k', sort, sortedAfter, params) : 'TRUE'}`
        : LEGACY_CURSOR_SQL,
      orderSql: sort ? buildPayrollOrderSql('k', sort.dir) : LEGACY_ORDER_SQL,
    });

    const result = await queryOne<{
      total: string | number;
      without_terms_total: string | number;
      with_terms_total: string | number;
      rows: IPayrollTermsListRow[];
    }>(sql, params);

    const pageRows = result?.rows ?? [];
    // Полная порция — возможно, есть следующая. Курсор повторяет ключ сортировки в SQL.
    const lastRow = pageRows.length === parsed.page_size ? pageRows[pageRows.length - 1] : null;
    let nextCursor: { name: string; id: number } | { key: string | null; isNull: boolean; id: number } | null = null;
    if (lastRow) {
      const keyText = lastRow.sort_key_text ?? null;
      nextCursor = sort
        ? { key: keyText, isNull: keyText === null, id: lastRow.employee_id }
        : { name: lastRow.full_name ?? '', id: lastRow.employee_id };
    }

    // Служебные поля ключа наружу не отдаём.
    const data = pageRows.map(({ sort_key: _sortKey, sort_key_text: _sortKeyText, ...row }) => row);

    res.json({
      success: true,
      data,
      meta: {
        date: onDate,
        page: parsed.page,
        page_size: parsed.page_size,
        sort: sort ?? null,
        next_cursor: nextCursor,
        total: Number(result?.total ?? 0),
        without_terms_total: Number(result?.without_terms_total ?? 0),
        // Сколько в выборке уже имеют условия. 0 при фильтре по категории — значит,
        // фильтровать не по чему: категория появляется только после назначения.
        with_terms_total: Number(result?.with_terms_total ?? 0),
        contractors_excluded: contractorRootId !== null,
        // Фронт убирает этот узел из дерева подразделений: подрядчики исключены из списка,
        // и выбор их ветки всегда давал бы пустой результат.
        contractor_root_id: contractorRootId,
      },
    });
  } catch (err) {
    if (handleZodError(err, res)) return;
    console.error('payrollTerms.list error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения списка условий оплаты' });
  }
};

/**
 * GET /api/payroll/terms/column-values?column=… — варианты фильтра столбца с количеством.
 *
 * Та же выборка, что у списка (скоуп, подрядчики, подразделение, поиск, фильтры других
 * столбцов), но без фильтра самого столбца — иначе после выбора одного значения остальные
 * исчезли бы из списка и снять выбор было бы не из чего.
 */
const columnValues = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const parsed = baseQuerySchema.extend({
      column: z.string(),
      value_q: z.string().trim().max(100).optional(),
    }).parse(req.query);

    if (!isPayrollValueFilterColumn(parsed.column)) {
      return badRequest(res, 'Для столбца нет фильтра по значениям', 'INVALID_COLUMN');
    }
    const column = parsed.column;

    const filtersResult = parsePayrollColumnFilters((req.query as Record<string, unknown>).cf);
    if (!filtersResult.ok) return badRequest(res, 'Некорректные фильтры столбцов', 'INVALID_COLUMN_FILTERS');

    const { params } = await buildBaseParams(req, parsed);
    const whereParts: string[] = [];
    appendPayrollColumnFilters(whereParts, params, filtersResult.filters, { exclude: column });

    params.push(parsed.value_q ? toIlikePattern(parsed.value_q) : null);
    const valueSearchIdx = params.length;
    params.push(COLUMN_VALUES_LIMIT + 1);
    const limitIdx = params.length;

    const sql = `${buildBaseCtes(whereParts.join('\n       AND '))}
      SELECT v.value, count(*)::int AS count
        FROM (SELECT ${payrollValueKeySql(column)} AS value, ${payrollValueOrderSql(column)} AS ord FROM filtered) v
       WHERE ($${valueSearchIdx}::text IS NULL OR v.value ILIKE $${valueSearchIdx}::text)
       GROUP BY v.value
       ORDER BY min(v.ord) ASC NULLS LAST, v.value ASC NULLS LAST
       LIMIT $${limitIdx}::int`;

    // Список вариантов — одна строка на значение; queryOne не подходит.
    const rows = await query<{ value: string | null; count: number }>(sql, params);
    const truncated = rows.length > COLUMN_VALUES_LIMIT;

    res.json({
      success: true,
      data: { values: truncated ? rows.slice(0, COLUMN_VALUES_LIMIT) : rows, truncated },
    });
  } catch (err) {
    if (handleZodError(err, res)) return;
    console.error('payrollTerms.columnValues error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения значений фильтра' });
  }
};

/** POST /api/payroll/terms/employee/:empId — назначить или сменить условия. */
const assign = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = Number(req.params.empId);
    if (!Number.isInteger(employeeId) || !(await canEditEmployeeInScope(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }

    const body = termsBodySchema.parse(req.body);
    const previous = await getTermsOnDate(employeeId, body.effective_from);

    const termsId = await assignTerms({
      employeeId,
      staffCategory: body.staff_category,
      calcType: body.calc_type,
      monthlySalary: body.monthly_salary ?? null,
      hourlyRate: body.hourly_rate ?? null,
      bonusAmount: body.bonus_amount ?? null,
      housingCompensation: body.housing_compensation ?? null,
      staffUnits: body.staff_units,
      organizationId: body.organization_id ?? null,
      effectiveFrom: body.effective_from,
      changeReason: body.change_reason ?? null,
      orderNumber: body.order_number ?? null,
      orderDate: body.order_date ?? null,
      note: body.note ?? null,
      createdBy: req.user.id,
    });

    await auditService.logFromRequest(req, req.user.id, 'PAYROLL_TERMS_ASSIGNED', {
      entityType: 'payroll_compensation_terms',
      entityId: String(termsId),
      details: {
        employee_id: employeeId,
        effective_from: body.effective_from,
        staff_category: body.staff_category,
        calc_type: body.calc_type,
        // Суммы в аудит пишем: это кадровое основание, а не секрет.
        monthly_salary: body.monthly_salary ?? null,
        hourly_rate: body.hourly_rate ?? null,
        bonus_amount: body.bonus_amount ?? null,
        housing_compensation: body.housing_compensation ?? null,
        previous_terms_id: previous?.id ?? null,
        previous_calc_type: previous?.calc_type ?? null,
      },
    });

    res.json({ success: true, data: { terms_id: termsId } });
  } catch (err) {
    if (handleZodError(err, res)) return;
    console.error('payrollTerms.assign error:', err);
    res.status(500).json({ success: false, error: 'Ошибка назначения условий оплаты' });
  }
};

/**
 * POST /api/payroll/terms/bulk — массовое назначение с общей датой.
 *
 * Недоступные по скоупу не выбрасываются молча, а попадают в skipped: иначе
 * пользователь решит, что применил условия ко всем выделенным.
 */
const assignBulk = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const body = bulkBodySchema.parse(req.body);

    const allowed: number[] = [];
    const skipped: IAssignResult['skipped'] = [];
    for (const employeeId of body.employee_ids) {
      if (await canEditEmployeeInScope(req, employeeId)) allowed.push(employeeId);
      else skipped.push({ employee_id: employeeId, reason: 'NO_ACCESS', message: 'Нет доступа к сотруднику' });
    }

    const result = await assignTermsBulk(allowed, {
      staffCategory: body.staff_category,
      calcType: body.calc_type,
      monthlySalary: body.monthly_salary ?? null,
      hourlyRate: body.hourly_rate ?? null,
      bonusAmount: body.bonus_amount ?? null,
      housingCompensation: body.housing_compensation ?? null,
      staffUnits: body.staff_units,
      organizationId: body.organization_id ?? null,
      effectiveFrom: body.effective_from,
      changeReason: body.change_reason ?? null,
      orderNumber: body.order_number ?? null,
      orderDate: body.order_date ?? null,
      note: body.note ?? null,
      createdBy: req.user.id,
    });

    const payload: IAssignResult = {
      applied: result.applied,
      skipped: [...skipped, ...result.skipped],
    };

    await auditService.logFromRequest(req, req.user.id, 'PAYROLL_TERMS_BULK_ASSIGNED', {
      entityType: 'payroll_compensation_terms',
      entityId: body.effective_from,
      details: {
        requested: body.employee_ids.length,
        applied: payload.applied.length,
        skipped: payload.skipped.length,
        staff_category: body.staff_category,
        calc_type: body.calc_type,
        bonus_amount: body.bonus_amount ?? null,
        housing_compensation: body.housing_compensation ?? null,
        effective_from: body.effective_from,
      },
    });

    res.json({ success: true, data: payload });
  } catch (err) {
    if (handleZodError(err, res)) return;
    console.error('payrollTerms.assignBulk error:', err);
    res.status(500).json({ success: false, error: 'Ошибка массового назначения условий' });
  }
};

export const payrollTermsController = { list, columnValues, getByEmployee, assign, assignBulk };
