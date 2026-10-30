/**
 * Условия оплаты сотрудников: чтение истории и назначение.
 *
 * Скоуп проверяется по каждому сотруднику отдельно (canEditPayrollEmployee):
 * ролевого права на страницу мало — бухгалтер подразделения не должен править
 * условия чужих людей.
 */
import type { Response } from 'express';
import { z } from 'zod';

import type { AuthenticatedRequest } from '../types/index.js';
import { query, queryOne, withTransaction } from '../config/postgres.js';
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
  type PayrollFilterColumn,
} from './payroll-terms-list.helpers.js';
import {
  canEditPayrollEmployee,
  canReadPayrollEmployee,
  resolvePayrollEditPredicate,
  resolvePayrollReadableDepartmentIds,
} from '../services/payroll/payroll-scope.service.js';
import { auditService } from '../services/audit.service.js';
import { resolveCurrentStaffCategories } from '../services/payroll/payroll-staff-category.js';
import {
  assignTerms,
  getSalaryChanges,
  getTermsChanges,
  getTermsHistory,
  getTermsOnDate,
  lockPayrollEmployee,
  PRORATION_ROUNDINGS,
  setPlannedSupplement,
  type ProrationRounding,
} from '../services/payroll/payroll-terms.service.js';
import { PAYROLL_PAID_ACCRUAL_CODES, PAYROLL_PAID_DEDUCTION_CODES } from '../services/payroll/payroll-paid.service.js';
import {
  CALC_COLUMNS_MAX_MONTHS,
  calcColumnsServerTiming,
  cardPayoutsJoinSql,
  emptyCalcColumnsTiming,
  type ICardPayoutByMethod,
  getCalcColumns,
} from '../services/payroll/payroll-calc-columns.service.js';
import {
  HOURLY_RATE_DECIMALS_MESSAGE,
  MONEY_DECIMALS_MESSAGE,
  PAYROLL_MAX_HOURLY_RATE,
  PAYROLL_MAX_MONEY,
  hasMaxDecimals,
  parsePayrollMonthsQuery,
  payrollMonthStarts,
} from './payroll-dictionary.helpers.js';
import { TRAVEL_RATE_CODE } from '../services/payroll/payroll-rates.service.js';
import {
  payrollContractorDeptsCte,
  payrollStaffWhereSql,
  payrollWorkedInMonthsSql,
  resolvePayrollArchiveDepartmentId,
  resolvePayrollStaffScope,
} from '../services/payroll/payroll-registry-scope.service.js';
import { moscowTodayIso } from '../utils/date.utils.js';
import {
  buildFioSearch,
  fioConditionSql,
  fioExactConditionSql,
  type FioSearchMode,
  type IFioSearch,
} from '../utils/fio-search.utils.js';

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ожидается YYYY-MM-DD');
/**
 * Суммы — до копеек, часовая ставка — до 4 знаков (NUMERIC(12,2) / NUMERIC(12,4)): лишний знак БД округлила бы
 * молча, а сверх верха столбца — переполнение и 500.
 */
const moneySchema = z.coerce.number().finite('Сумма должна быть числом').positive('Сумма должна быть больше нуля')
  .max(PAYROLL_MAX_MONEY, 'Слишком большая сумма')
  .refine(value => hasMaxDecimals(value, 2), MONEY_DECIMALS_MESSAGE);
const hourlyRateSchema = z.coerce.number().finite('Ставка должна быть числом').positive('Ставка должна быть больше нуля')
  .max(PAYROLL_MAX_HOURLY_RATE, 'Слишком большая ставка')
  .refine(value => hasMaxDecimals(value, 4), HOURLY_RATE_DECIMALS_MESSAGE);
/** Премия, компенсации и удержание могут быть нулевыми: 0 — «явно не положено», отсутствие — «не задано». */
const optionalMoneySchema = z.coerce.number().finite('Сумма должна быть числом').min(0, 'Сумма не может быть отрицательной')
  .max(PAYROLL_MAX_MONEY, 'Слишком большая сумма')
  .refine(value => hasMaxDecimals(value, 2), MONEY_DECIMALS_MESSAGE)
  .optional();

/**
 * Сумма привязана к виду оплаты: у оклада — monthly_salary, у почасовой — hourly_rate.
 * Тот же XOR стоит в БД (payroll_terms_amount_xor); дублируем здесь, чтобы вернуть
 * пользователю понятный текст, а не 500 от констрейнта.
 */
const termsBodySchema = z.object({
  // Категории в теле нет: её решает табель (payroll-staff-category.ts); присланную прежним клиентом zod отбросит.
  calc_type: z.enum(['salary', 'hourly']),
  monthly_salary: moneySchema.optional(),
  hourly_rate: hourlyRateSchema.optional(),
  bonus_amount: optionalMoneySchema,
  // Прежний клиент ещё присылает — принимаем и не пишем: проживание с миграции 320 — квартиры «Проживания».
  housing_compensation: optionalMoneySchema,
  travel_compensation: optionalMoneySchema,
  communication_compensation: optionalMoneySchema,
  // Прежний клиент ещё присылает — пустое и 0 принимаем и не пишем, сумму больше нуля отклоняем (409): удержания
  // с миграции 321 — staff_deductions, вносятся в «Справочник» → «Удержания» и во вкладке кадров.
  deduction_amount: optionalMoneySchema,
  staff_units: z.coerce.number().positive().max(2).optional(),
  proration_rounding: z.enum(PRORATION_ROUNDINGS as [ProrationRounding, ...ProrationRounding[]]).optional(),
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

/** Календарная дата: «2026-02-31» по форме верна, но PostgreSQL отверг бы её ошибкой 500. */
const calendarDateSchema = dateSchema.refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, 'Некорректная дата');

/** Плановая доплата: сумма ₽/мес на период «с — по» включительно; «по» пусто — бессрочно. */
const plannedSupplementSchema = z.object({
  amount: moneySchema,
  date_from: calendarDateSchema,
  date_to: calendarDateSchema.nullable().optional(),
}).refine(value => !value.date_to || value.date_to >= value.date_from, 'Дата окончания доплаты раньше даты начала');

/**
 * Назначение сотруднику — с плановой доплатой: не передана — доплату не трогать
 * (старый фронт или поля не меняли), null — снять.
 */
const assignBodySchema = termsBodySchema.and(z.object({
  planned_supplement: plannedSupplementSchema.nullable().optional(),
}));

/** Прежний клиент прислал «Сумма, ₽/мес» удержания: тихо не записываем — просим обновить страницу. */
const DEDUCTION_MOVED = {
  success: false,
  error: 'Удержания теперь вносятся в «Справочник» → «Удержания» — обновите страницу',
  code: 'DEDUCTION_MOVED',
};

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
    if (!Number.isInteger(employeeId) || !(await canReadPayrollEmployee(req, employeeId))) {
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

/**
 * GET /api/payroll/terms/employee/:empId/changes — история условий для карточки:
 * изменения оклада / ставки и плановой доплаты одним журналом.
 */
const getChanges = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = Number(req.params.empId);
    if (!Number.isInteger(employeeId) || !(await canReadPayrollEmployee(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }
    const data = await getTermsChanges(employeeId);
    res.json({ success: true, data });
  } catch (err) {
    console.error('payrollTerms.getChanges error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения истории условий оплаты' });
  }
};

/**
 * GET /api/payroll/terms/employee/:empId/salary-history — изменения оклада / ставки.
 * Оставлен для закэшированных клиентов: записи доплаты отдаёт только /changes.
 */
const getSalaryHistory = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = Number(req.params.empId);
    if (!Number.isInteger(employeeId) || !(await canReadPayrollEmployee(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }
    const data = await getSalaryChanges(employeeId);
    res.json({ success: true, data });
  } catch (err) {
    console.error('payrollTerms.getSalaryHistory error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения истории зарплаты' });
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
 * $1 дата, $2 подразделение, $3 — всегда NULL (был фильтр категории по сохранённым условиям; категорию
 * решает табель уже после выборки, а слот оставлен, чтобы не перенумеровывать $4–$12), $4 вид оплаты,
 * $5 «только без условий», $6 корень подрядчиков, $7 доступные отделы, $8 поиск.
 *
 * scoped   — свой штат в скоупе пользователя (без фильтров по условиям оплаты);
 * filtered — scoped + фильтры по виду оплаты / «только без условий» + фильтры столбцов.
 *
 * «Без условий» считается по scoped, а не по filtered: при фильтре «Вид оплаты: оклад»
 * сотрудники без условий в выборку не попадают по определению, и счётчик показал бы 0,
 * хотя люди, которые не попадут в расчёт, есть.
 *
 * Штат (работает, не в архиве, без подрядчиков, в охвате) — общие фрагменты payroll-registry-scope:
 * те же, что у таблиц окна «Справочник» и проверки перед записью в них.
 *
 * График — имя графика на дату выборки, как у «Текущих сотрудников»: последнее действующее
 * назначение по дате начала, иначе график по умолчанию. Считается в SQL, чтобы ячейка,
 * сортировка и фильтр по графику совпадали.
 */
export const buildBaseCtes = (columnFilterSql: string, fioSql = 'FALSE'): string => `
  WITH ${payrollContractorDeptsCte('$6')},
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
           -- Доплата за проживание — квартира «Проживания» на дату выборки (миграция 320), не условия оплаты.
           (SELECT s.amount
              FROM employee_dormitory_stays s
             WHERE s.employee_id = e.id
               AND s.kind = 'apartment'
               AND s.check_in <= $1::date
               AND (s.check_out IS NULL OR s.check_out > $1::date)
             LIMIT 1) AS housing_compensation,
           t.travel_compensation,
           t.communication_compensation,
           t.proration_rounding,
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
     WHERE ${payrollStaffWhereSql('e', '$7')}
       AND ($2::uuid IS NULL OR e.org_department_id IN (SELECT id FROM filter_depts))
       AND ($8::text IS NULL OR ${fioSql} OR e.tab_number ILIKE $8::text)
  ),
  filtered AS (
    SELECT * FROM scoped
     WHERE $3::text IS NULL
       AND ($4::text IS NULL OR calc_type = $4::text)
       AND ($5::boolean IS NOT TRUE OR terms_id IS NULL)${columnFilterSql ? `\n       AND ${columnFilterSql}` : ''}
  )`;

/** Коды статей «Начислено» и «Удержано» литералом SQL: константы из кода, не ввод пользователя. */
const ACCRUAL_CODES_SQL = PAYROLL_PAID_ACCRUAL_CODES.map(code => `'${code}'`).join(', ');
const DEDUCTION_CODES_SQL = PAYROLL_PAID_DEDUCTION_CODES.map(code => `'${code}'`).join(', ');

/**
 * «Выплачено» — «К выплате» из «Оплачено» по месяцам (начислено минус удержано, как paidPayout
 * на «Расчётах»): 6 закрытых месяцев перед датой выборки, как окно столбца на фронте
 * (payrollAccrualMonths). В месяце только удержание — сумма минусом; нет сумм — null («—»).
 * Суммы — NUMERIC строкой (::text): json_agg отдал бы их числом JSON.
 */
const PAYOUTS_SELECT_SQL = 'pay.payouts';
const PAYOUTS_JOIN_SQL = `
                LEFT JOIN LATERAL (
                  SELECT json_agg(json_build_object('month', to_char(a.month, 'YYYY-MM'), 'amount', a.amount::text)
                                  ORDER BY a.month) AS payouts
                    FROM (SELECT pa.month,
                                 SUM(CASE WHEN pa.item_code IN (${DEDUCTION_CODES_SQL}) THEN -pa.amount ELSE pa.amount END) AS amount
                            FROM payroll_paid_amounts pa
                           WHERE pa.employee_id = page.employee_id
                             AND pa.month >= (date_trunc('month', $1::date) - INTERVAL '6 months')::date
                             AND pa.month <  date_trunc('month', $1::date)::date
                             AND pa.item_code IN (${ACCRUAL_CODES_SQL}, ${DEDUCTION_CODES_SQL})
                           GROUP BY pa.month) a
                ) pay ON TRUE`;

const PAID_SELECT_SQL = `paid.paid_total, paid.paid_deductions_total, paid.paid_deductions,
                     paid.paid_vacation, paid.paid_sick_leave, paid.paid_recalc_prev, card.card_payouts_raw`;

/**
 * «Расчёты»: итоги «Начислено» и «Удержано» и статьи «Удержано» по месяцам для окна; «К выплате»
 * (начислено минус удержано) фронт считает в копейках. Отдельно — отпускные, больничные и перерасчёт (столбцы
 * из 1С, payroll-calc-columns.service) и ведомости в банк по способу выплаты. monthsParam — date[] первых чисел
 * месяцев, NULL — весь период. Нет сумм группы — null («—»). Суммы — NUMERIC строкой (::text).
 */
const paidJoinSql = (monthsParam: string): string => `
                LEFT JOIN LATERAL (
                  SELECT (SUM(pa.amount) FILTER (WHERE pa.item_code IN (${ACCRUAL_CODES_SQL})))::text AS paid_total,
                         (SUM(pa.amount) FILTER (WHERE pa.item_code IN (${DEDUCTION_CODES_SQL})))::text AS paid_deductions_total,
                         json_agg(json_build_object('month', to_char(pa.month, 'YYYY-MM'),
                                                    'item', pa.item_code,
                                                    'amount', pa.amount::text)
                                  ORDER BY pa.month, pa.item_code)
                           FILTER (WHERE pa.item_code IN (${DEDUCTION_CODES_SQL})) AS paid_deductions,
                         (SUM(pa.amount) FILTER (WHERE pa.item_code = 'vacation'))::text AS paid_vacation,
                         (SUM(pa.amount) FILTER (WHERE pa.item_code = 'sick_leave'))::text AS paid_sick_leave,
                         (SUM(pa.amount) FILTER (WHERE pa.item_code = 'recalc_prev'))::text AS paid_recalc_prev
                    FROM payroll_paid_amounts pa
                   WHERE pa.employee_id = page.employee_id
                     AND (${monthsParam}::date[] IS NULL OR pa.month = ANY(${monthsParam}::date[]))
                ) paid ON TRUE${cardPayoutsJoinSql(monthsParam)}`;

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
  /** Условие ФИО (fioConditionSql) — без него поиск только по табельному ($8). */
  fioSql?: string;
  sortKeySql: string;
  cursorSql: string;
  orderSql: string;
  /** Параметр месяцев «Расчётов» ($N): с ним вместо «Выплачено» — «К выплате» и «Удержания». */
  paidMonthsParam?: string;
}): string => `${buildBaseCtes(options.columnFilterSql, options.fioSql)},
  keyed AS (
    SELECT filtered.*, ${options.sortKeySql} AS sort_key FROM filtered
  )
  SELECT
    (SELECT count(*) FROM filtered)                          AS total,
    -- Счётчики условий — из scoped, до фильтров: у «Расчётов» за месяцы включают и не работавших в них
    -- (payrollWorkedInMonthsSql — в filtered); фронт «Расчётов» их не показывает.
    (SELECT count(*) FROM scoped WHERE terms_id IS NULL)     AS without_terms_total,
    (SELECT count(*) FROM scoped WHERE terms_id IS NOT NULL) AS with_terms_total,
    COALESCE((
      -- ORDER BY внутри json_agg: next_cursor берётся из последнего элемента массива,
      -- порядок подзапроса агрегат гарантированно не сохраняет.
      -- Плановая доплата, проезд и суммы «Оплачено» — только для строк порции: LATERAL после LIMIT.
      SELECT json_agg(p ORDER BY ${options.orderSql.replace(/\bk\./g, 'p.')})
        FROM (SELECT page.*,
                     ps.amount::text AS planned_supplement_amount,
                     ps.date_from AS planned_supplement_from,
                     ps.date_to   AS planned_supplement_to,
                     -- Проезд (миграция 324): ставка за месяц даты; положен ли — решает категория (на клиенте).
                     payroll_rate_value('${TRAVEL_RATE_CODE}', $1::date)::text AS travel_rate,
                     EXISTS (
                       SELECT 1 FROM payroll_compensation_stops cs
                        WHERE cs.employee_id = page.employee_id
                          AND cs.date_from <= (date_trunc('month', $1::date) + interval '1 month - 1 day')::date
                          AND (cs.date_to IS NULL OR cs.date_to >= date_trunc('month', $1::date)::date)
                     ) AS travel_stopped,
                     ${options.paidMonthsParam ? PAID_SELECT_SQL : PAYOUTS_SELECT_SQL}
                FROM (SELECT k.*, k.sort_key::text AS sort_key_text FROM keyed k
                       WHERE ${options.cursorSql}
                       ORDER BY ${options.orderSql}
                       LIMIT $9 OFFSET $10) page
                LEFT JOIN LATERAL (
                  SELECT s.amount, s.date_from, s.date_to
                    FROM payroll_planned_supplements s
                   WHERE s.employee_id = page.employee_id AND s.archived_at IS NULL
                   ORDER BY s.id DESC
                   LIMIT 1
                ) ps ON TRUE${options.paidMonthsParam ? paidJoinSql(options.paidMonthsParam) : PAYOUTS_JOIN_SQL}) p
    ), '[]'::json) AS rows`;

/** Прежний порядок и курсор (ФИО, id): без параметра sort — как до сортировки по столбцам. */
const LEGACY_SORT_KEY_SQL = `COALESCE(full_name, '')`;
const LEGACY_CURSOR_SQL = `($12::int IS NULL OR (k.sort_key, k.employee_id) > ($11::text, $12::int))`;
const LEGACY_ORDER_SQL = `k.sort_key, k.employee_id`;

/** Строка списка (json_agg отдаёт NUMERIC числами; суммы «Оплачено», доплата и sort_key_text — текстом). */
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
  travel_compensation: string | number | null;
  communication_compensation: string | number | null;
  /** Округление оклада за неполный месяц (миграция 331); без условий — null. */
  proration_rounding: ProrationRounding | null;
  staff_units: string | number | null;
  effective_from: string | null;
  effective_to: string | null;
  /** Последняя сохранённая плановая доплата (период может быть будущим или прошедшим). */
  planned_supplement_amount: string | null;
  planned_supplement_from: string | null;
  planned_supplement_to: string | null;
  /** Ставка «Проезд» за месяц даты выборки (NUMERIC текстом); не задана — null. */
  travel_rate: string | null;
  /** В месяце даты есть день «Без проезда» — проезда в этом месяце нет. */
  travel_stopped: boolean;
  /** «Выплачено» по месяцам окна (начислено минус удержано из «Оплачено»); null — сумм нет. Нет при paid_months. */
  payouts?: Array<{ month: string; amount: string }> | null;
  /** Только при paid_months («Расчёты»): итоги «Начислено» и «Удержано» за месяцы, статьи удержаний. */
  paid_total?: string | null;
  paid_deductions_total?: string | null;
  paid_deductions?: Array<{ month: string; item: string; amount: string }> | null;
  /** Только при paid_months: отпускные, больничные и перерасчёт из 1С за месяцы. */
  paid_vacation?: string | null;
  paid_sick_leave?: string | null;
  paid_recalc_prev?: string | null;
  /** Только при paid_months: ведомости выплаты по способу выплаты (наружу — card_payouts_by_method). */
  card_payouts_raw?: ICardPayoutByMethod[] | null;
  sort_key?: unknown;
  sort_key_text?: string | null;
}

/** Параметры выборки, общие для списка, вариантов фильтра и «Расчётов». */
export const baseQuerySchema = z.object({
  date: dateSchema.optional(),
  department_id: z.string().uuid().optional(),
  calc_type: z.enum(['salary', 'hourly']).optional(),
  without_terms: z.enum(['true', 'false']).optional(),
  q: z.string().trim().max(100).optional(),
});

type BaseQuery = z.infer<typeof baseQuerySchema>;

/** $1–$8 для buildBaseCtes. */
export const buildBaseParams = async (req: AuthenticatedRequest, query: BaseQuery) => {
  // «Сегодня» по Москве, как на экране: toISOString() дал бы дату UTC.
  const onDate = query.date ?? moscowTodayIso();
  const accessible = await resolvePayrollReadableDepartmentIds(req);
  // Корень «Подрядные организации» не найден — подрядчиков не исключаем, но говорим
  // об этом экрану: молча показать лишних людей в зарплатном списке нельзя.
  const contractorRootId = await getContractorRootId();
  const params: unknown[] = [
    onDate,
    query.department_id ?? null,
    // $3 — резерв: фильтра категории больше нет (см. buildBaseCtes).
    null,
    query.calc_type ?? null,
    query.without_terms === 'true',
    contractorRootId,
    accessible === 'all' ? null : accessible,
    // Табельный — прежним ILIKE; ФИО — условием поиска ФИО (resolvePayrollFioMode + fioConditionSql).
    query.q ? toIlikePattern(query.q) : null,
  ];
  const fio = query.q ? buildFioSearch(query.q) : null;
  return { onDate, contractorRootId, params, fio };
};

/** «Расчёты» за месяцы: только работавшие в них (payrollWorkedInMonthsSql). */
interface IPayrollWorkedIn {
  /** Первые числа месяцев, YYYY-MM-DD. */
  months: string[];
  archiveId: string | null;
}

/**
 * Поиск ФИО «Условий оплаты»: точно; если точного (ФИО или табельный) нет во всём `filtered` — после скоупа,
 * подразделения и фильтров столбцов, до курсора и LIMIT — с одной ошибкой. Режим один на список,
 * итоги и счётчики. baseParams — $1–$8 от buildBaseParams. workedIn — то же условие месяцев, что у списка
 * «Расчётов»: иначе точное совпадение у скрытого включило бы точный режим и спрятало видимых с одной ошибкой.
 */
const resolvePayrollFioMode = async (
  fio: IFioSearch | null,
  baseParams: unknown[],
  filters: Parameters<typeof appendPayrollColumnFilters>[2],
  options: { exclude?: PayrollFilterColumn; workedIn?: IPayrollWorkedIn | null } = {},
): Promise<FioSearchMode> => {
  if (!fio || fio.fuzzy.length === 0) return 'exact';
  const params = baseParams.slice(0, 8);
  const whereParts: string[] = [];
  appendPayrollColumnFilters(whereParts, params, filters, { exclude: options.exclude });
  if (options.workedIn) {
    params.push(options.workedIn.months, options.workedIn.archiveId);
    whereParts.push(payrollWorkedInMonthsSql('scoped.employee_id', `$${params.length - 1}`, `$${params.length}`));
  }
  const fioSql = fioExactConditionSql('e', params, fio);
  const row = await queryOne<{ found: boolean }>(
    `${buildBaseCtes(whereParts.join('\n       AND '), fioSql)}
     SELECT EXISTS (SELECT 1 FROM filtered) AS found`,
    params,
  );
  return row?.found ? 'exact' : 'fuzzy';
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
 *
 * ?paid_months=2026-07,2026-08 | all («Расчёты») — вместо «Выплачено» строки несут paid_total,
 * paid_deductions_total и paid_deductions за эти месяцы, отпускные, больничные, перерасчёт и card_payouts_by_method
 * из 1С, а по списку месяцев (не all) — calc: столбцы расчёта ФОТ (payroll-calc-columns.service); без параметра
 * этих полей нет.
 *
 * ?employee_id=N — только этот сотрудник (карточка открыта в «Подробно» → «Расчёты»): по id, тёзки не попадают.
 */
const list = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const parsed = baseQuerySchema.extend({
      employee_id: z.coerce.number().int().positive().optional(),
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

    // «Расчёты»: месяцы «К выплате» и «Удержаний». Без параметра — прежний список с «Выплачено».
    const paidMonths = parsePayrollMonthsQuery(query.paid_months);
    // За месяцы списком — только работавшие в них; «весь период» и «Условия оплаты» — весь штат, как раньше.
    const workedIn: IPayrollWorkedIn | null = paidMonths !== null && paidMonths !== 'all'
      ? { months: payrollMonthStarts(paidMonths), archiveId: await resolvePayrollArchiveDepartmentId() }
      : null;

    const { onDate, contractorRootId, params, fio } = await buildBaseParams(req, parsed);
    const fioMode = await resolvePayrollFioMode(fio, params, filtersResult.filters, { workedIn });

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
    if (parsed.employee_id !== undefined) {
      params.push(parsed.employee_id);
      whereParts.push(`employee_id = $${params.length}::int`);
    }

    // $11/$12 при сортировке по столбцу всегда NULL, но упомянуты в SQL: неиспользованный
    // параметр PostgreSQL отвергает («could not determine data type of parameter»).
    // Курсор пушит свои параметры — строится до параметра месяцев, иначе номера разъедутся.
    const cursorSql = sort
      ? `$11::text IS NULL AND $12::int IS NULL AND ${sortedAfter ? buildPayrollCursorSql('k', sort, sortedAfter, params) : 'TRUE'}`
      : LEGACY_CURSOR_SQL;

    let paidMonthsParam: string | undefined;
    if (paidMonths !== null) {
      params.push(paidMonths === 'all' ? null : payrollMonthStarts(paidMonths));
      paidMonthsParam = `$${params.length}`;
    }
    if (workedIn && paidMonthsParam) {
      params.push(workedIn.archiveId);
      whereParts.push(payrollWorkedInMonthsSql('scoped.employee_id', paidMonthsParam, `$${params.length}`));
    }

    const fioSql = fio ? fioConditionSql('e', params, fio, fioMode) : undefined;
    const sql = buildListSql({
      columnFilterSql: whereParts.join('\n       AND '),
      fioSql,
      sortKeySql: sort ? payrollSortKeySql(sort.key).sql : LEGACY_SORT_KEY_SQL,
      cursorSql,
      orderSql: sort ? buildPayrollOrderSql('k', sort.dir) : LEGACY_ORDER_SQL,
      paidMonthsParam,
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

    // can_edit — скоуп правки конкретного сотрудника (то же, что проверит assign):
    // право на страницу есть, а отдел — только на просмотр → карточка без правки.
    const canEditRow = await resolvePayrollEditPredicate(req);
    // Категория — по табелю на сейчас (payroll-staff-category.ts): её карточка показывает, по ней «Проезд».
    const categories = await resolveCurrentStaffCategories(pageRows.map(row => row.employee_id));
    // «Расчёты»: столбцы по расчёту ФОТ закрытого табеля — для строк порции («весь период» не считается).
    // defer_calc=1 (новый фронт) — строки сразу, ФОТ — отдельным GET /terms/calc-columns; без параметра — как раньше,
    // чтобы старый открытый фронт не потерял столбцы.
    const deferCalc = query.defer_calc === '1';
    const calcColumns = paidMonths !== null && paidMonths !== 'all' && !deferCalc
      ? await getCalcColumns(pageRows.map(row => row.employee_id), paidMonths, req)
      : null;
    // Служебные поля ключа и снимок категории из условий наружу не отдаём.
    const data = pageRows.map(({
      sort_key: _sortKey, sort_key_text: _sortKeyText, staff_category: _stored, card_payouts_raw: cardPayoutsRaw, ...row
    }) => ({
      ...row,
      // Каждый способ выплаты 1С отдельно; новое имя поля — старый фронт покажет «—», а не три вида.
      ...(paidMonths !== null ? { card_payouts_by_method: cardPayoutsRaw ?? null } : {}),
      ...(calcColumns ? { calc: calcColumns.get(row.employee_id) ?? null } : {}),
      category: categories.get(row.employee_id) ?? 'office',
      can_edit: canEditRow(row.employee_id),
    }));

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
        // Сколько в выборке уже имеют условия.
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

    const { params, fio } = await buildBaseParams(req, parsed);
    // Режим поиска — по своему набору: без фильтра самого столбца, как и варианты.
    const fioMode = await resolvePayrollFioMode(fio, params, filtersResult.filters, { exclude: column });
    const whereParts: string[] = [];
    appendPayrollColumnFilters(whereParts, params, filtersResult.filters, { exclude: column });
    const fioSql = fio ? fioConditionSql('e', params, fio, fioMode) : undefined;

    params.push(parsed.value_q ? toIlikePattern(parsed.value_q) : null);
    const valueSearchIdx = params.length;
    params.push(COLUMN_VALUES_LIMIT + 1);
    const limitIdx = params.length;

    const sql = `${buildBaseCtes(whereParts.join('\n       AND '), fioSql)}
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
    if (!Number.isInteger(employeeId) || !(await canEditPayrollEmployee(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }

    const body = assignBodySchema.parse(req.body);
    if ((body.deduction_amount ?? 0) > 0) {
      res.status(409).json(DEDUCTION_MOVED);
      return;
    }
    const supplement = body.planned_supplement;

    // Условия и доплата — одной транзакцией под блокировкой сотрудника: параллельное
    // сохранение не прочтёт ту же прежнюю версию доплаты.
    const { termsId, previous, supplementChanged, staffCategory } = await withTransaction(async client => {
      await lockPayrollEmployee(client, employeeId);
      // Категория — снимок на дату сохранения: по табелю на сейчас; категорию и «Проезд» он не решает.
      const category = (await resolveCurrentStaffCategories([employeeId], client)).get(employeeId) ?? 'office';
      const previousTerms = await getTermsOnDate(employeeId, body.effective_from, client);
      const id = await assignTerms({
        employeeId,
        staffCategory: category,
        calcType: body.calc_type,
        monthlySalary: body.monthly_salary ?? null,
        hourlyRate: body.hourly_rate ?? null,
        bonusAmount: body.bonus_amount ?? null,
        // Доплата за проживание с миграции 320 — квартиры «Проживания»: окно её только показывает.
        housingCompensation: null,
        travelCompensation: body.travel_compensation ?? null,
        communicationCompensation: body.communication_compensation ?? null,
        // Удержания с миграции 321 — staff_deductions: окно сотрудника их только показывает.
        deductionAmount: null,
        staffUnits: body.staff_units,
        // Прежний клиент поля не знает — как у условий на дату: признак ставит скрипт по ЗУП, сохранение не сбрасывает.
        prorationRounding: body.proration_rounding ?? previousTerms?.proration_rounding,
        organizationId: body.organization_id ?? null,
        effectiveFrom: body.effective_from,
        changeReason: body.change_reason ?? null,
        orderNumber: body.order_number ?? null,
        orderDate: body.order_date ?? null,
        note: body.note ?? null,
        createdBy: req.user.id,
      }, client);
      const changed = supplement === undefined
        ? false
        : await setPlannedSupplement(client, {
          employeeId,
          value: supplement && {
            amount: supplement.amount,
            dateFrom: supplement.date_from,
            dateTo: supplement.date_to ?? null,
          },
          createdBy: req.user.id,
        });
      return { termsId: id, previous: previousTerms, supplementChanged: changed, staffCategory: category };
    });

    await auditService.logFromRequest(req, req.user.id, 'PAYROLL_TERMS_ASSIGNED', {
      entityType: 'payroll_compensation_terms',
      entityId: String(termsId),
      details: {
        employee_id: employeeId,
        effective_from: body.effective_from,
        staff_category: staffCategory,
        calc_type: body.calc_type,
        // Суммы в аудит пишем: это кадровое основание, а не секрет.
        monthly_salary: body.monthly_salary ?? null,
        hourly_rate: body.hourly_rate ?? null,
        bonus_amount: body.bonus_amount ?? null,
        travel_compensation: body.travel_compensation ?? null,
        communication_compensation: body.communication_compensation ?? null,
        proration_rounding: body.proration_rounding ?? null,
        // undefined — доплату не трогали (в аудите ключа нет), null — снята.
        planned_supplement: supplement,
        planned_supplement_changed: supplementChanged,
        previous_terms_id: previous?.id ?? null,
        previous_calc_type: previous?.calc_type ?? null,
      },
    });

    // Плановая доплата — тем же событием, что из таблицы «Доплата» «Справочника».
    if (supplementChanged) {
      await auditService.logFromRequest(req, req.user.id, 'PAYROLL_PLANNED_SUPPLEMENT_SET', {
        entityType: 'payroll_planned_supplements',
        entityId: String(employeeId),
        details: {
          source: 'employee_card',
          employee_id: employeeId,
          planned_supplement: supplement ?? null,
        },
      });
    }

    res.json({ success: true, data: { terms_id: termsId } });
  } catch (err) {
    if (handleZodError(err, res)) return;
    console.error('payrollTerms.assign error:', err);
    res.status(500).json({ success: false, error: 'Ошибка назначения условий оплаты' });
  }
};

/** Сколько сотрудников за раз — как порция списка. */
const CALC_COLUMNS_MAX_IDS = 500;

/**
 * GET /api/payroll/terms/calc-columns?employee_ids=1,2&paid_months=2026-08 — столбцы ФОТ «Расчётов» для порции списка
 * (список с defer_calc=1 отдаёт строки сразу, без расчёта). Считаются только сотрудники «штата зарплаты» в охвате
 * пользователя — те же правила, что у списка: работает, не в архиве, не подрядчик, отдел в охвате; остальные id
 * в расчёт не идут и в ответе их нет. Больше 12 месяцев или «весь период» — { available: false }: ФОТ не считается.
 * preliminary=1 — незакрытый месяц предварительно по живому табелю (calc.preliminary); без него — как раньше, чтобы
 * старый фронт не показал предварительные суммы без пометки.
 */
const calcColumns = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const params = req.query as Record<string, unknown>;
    const rawIds = typeof params.employee_ids === 'string'
      ? params.employee_ids.split(',').map(value => value.trim()).filter(Boolean)
      : [];
    // Лимит — до снятия повторов: 501 одинаковый id — тоже лишний.
    if (rawIds.length === 0 || rawIds.length > CALC_COLUMNS_MAX_IDS) {
      return badRequest(res, `Нужно от 1 до ${CALC_COLUMNS_MAX_IDS} сотрудников`, 'INVALID_EMPLOYEE_IDS');
    }
    const ids = rawIds.map(Number);
    if (!ids.every(id => Number.isInteger(id) && id > 0)) {
      return badRequest(res, 'Некорректный id сотрудника', 'INVALID_EMPLOYEE_IDS');
    }
    if (params.paid_months === undefined) return badRequest(res, 'Не выбраны месяцы', 'INVALID_MONTHS');
    const months = parsePayrollMonthsQuery(params.paid_months);
    if (months === null || months === 'all' || months.length > CALC_COLUMNS_MAX_MONTHS) {
      res.json({ success: true, data: { available: false, rows: [] } });
      return;
    }

    const scope = await resolvePayrollStaffScope(req);
    const uniqueIds = [...new Set(ids)];
    const allowedRows = scope.departmentIds?.length === 0 ? [] : await query<{ id: number }>(
      `WITH ${payrollContractorDeptsCte('$1')}
       SELECT e.id FROM employees e WHERE e.id = ANY($3::int[]) AND ${payrollStaffWhereSql('e', '$2')}`,
      [scope.contractorRootId, scope.departmentIds, uniqueIds],
    );
    const allowed = new Set(allowedRows.map(row => Number(row.id)));
    const allowedIds = uniqueIds.filter(id => allowed.has(id));

    const timing = emptyCalcColumnsTiming();
    const columns = await getCalcColumns(allowedIds, months, req, timing, { preliminary: params.preliminary === '1' });
    res.setHeader('Server-Timing', calcColumnsServerTiming(timing));
    res.json({
      success: true,
      data: { available: true, rows: allowedIds.map(id => ({ employee_id: id, calc: columns.get(id) ?? null })) },
    });
  } catch (err) {
    if (handleZodError(err, res)) return;
    console.error('payrollTerms.calcColumns error:', err);
    res.status(500).json({ success: false, error: 'Ошибка расчёта ФОТ' });
  }
};

export const payrollTermsController = {
  list, columnValues, getByEmployee, getChanges, getSalaryHistory, assign, calcColumns,
};
