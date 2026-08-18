import type { Response } from 'express';
import * as Sentry from '@sentry/node';
import { z } from 'zod';

import { query, queryOne } from '../config/postgres.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { extractObjectKpiError } from '../services/object-kpi-errors.js';
import { getFreezerConfig, resolveFixationDate } from '../services/object-kpi-plan-freezer.service.js';
import { fetchObjectKpiHeadcount } from '../services/object-kpi-headcount.service.js';
import { listMonthPlans, normalizeMonth } from '../services/object-kpi-plan.service.js';
import {
  fetchObjectKpiReport,
  resolveCalcWindow,
  summarizeCompletion,
  OBJECT_KPI_MAX_AUTO_MONTHS,
  type ObjectKpiReportParams,
} from '../services/object-kpi-report.service.js';
import { fetchManagerPremium, EMPTY_PREMIUM_TOTALS } from '../services/object-kpi-premium.service.js';
import { listObjectKpiHistory } from '../services/object-kpi-history.service.js';
import { loadAssignedObjectIds, resolveObjectKpiScope } from '../services/object-kpi-scope.service.js';
import { getContractByObject, listAddenda, listKs2Entries } from '../services/object-kpi.service.js';
import { listKs6Entries } from '../services/object-kpi-ks6.service.js';
import { isEconomicsHead } from '../services/object-kpi-roles-cache.service.js';
import { listAssignments, listGlobalRoles } from '../services/object-kpi-assignments.service.js';
import {
  canSeeManagerSalary,
  redactAssignmentSalary,
  redactHistorySalary,
} from '../services/object-kpi-salary-access.service.js';

/**
 * Чтение KPI-контура: отчёт, карточка объекта, планы, история, ЛК руководителя.
 * Запись живёт в object-kpi-entries.controller.ts.
 */

/** Период задаётся месяцами. 24 месяца — потолок: дальше отчёт теряет смысл, а решётка растёт. */
const periodSchema = z
  .object({
    from: z.string().regex(/^\d{4}-\d{2}$/, 'Ожидается YYYY-MM'),
    to: z.string().regex(/^\d{4}-\d{2}$/, 'Ожидается YYYY-MM'),
  })
  .refine((v) => v.from <= v.to, { message: 'Начало периода позже конца' })
  .refine((v) => monthsBetween(v.from, v.to) <= 24, { message: 'Период больше 24 месяцев' });

/**
 * Период, который можно не передавать вовсе — тогда окно считает сервер (resolveCalcWindow).
 *
 * Границы обязаны приходить ПАРОЙ: запрос с одним `from` иначе прошёл бы разбор и развалился
 * дальше, в periodBounds. Потолок здесь выше (10 лет) — это режим «весь расчёт по объекту».
 */
export const optionalPeriodSchema = z
  .object({
    from: z.string().regex(/^\d{4}-\d{2}$/, 'Ожидается YYYY-MM').optional(),
    to: z.string().regex(/^\d{4}-\d{2}$/, 'Ожидается YYYY-MM').optional(),
  })
  .refine((v) => (v.from === undefined) === (v.to === undefined), {
    message: 'Укажите обе границы периода',
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { message: 'Начало периода позже конца' })
  .refine(
    (v) => !v.from || !v.to || monthsBetween(v.from, v.to) <= OBJECT_KPI_MAX_AUTO_MONTHS,
    { message: `Период больше ${OBJECT_KPI_MAX_AUTO_MONTHS} месяцев` },
  );

function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  return (ty * 12 + tm) - (fy * 12 + fm) + 1;
}

/** Границы окна в виде первых чисел месяцев — формат, который ждёт отчётный SQL. */
function periodBounds(from: string, to: string): { monthFrom: string; monthTo: string } {
  return { monthFrom: `${from}-01`, monthTo: `${to}-01` };
}

/**
 * Тексты для констрейнтов модуля. Без них нарушение бизнес-проверки в БД доходит до
 * пользователя как «Внутренняя ошибка сервера» — он видит отказ и не понимает, что
 * исправить. Именно так выглядел 500 при создании договора с датой вместо месяца.
 */
const CHECK_MESSAGES: Record<string, string> = {
  object_contracts_plan_start_month_check:
    'Первый расчётный месяц задаётся месяцем — выберите месяц, а не конкретную дату',
  object_contracts_base_amount_check: 'Стоимость договора не может быть отрицательной',
  object_contract_addenda_amount_delta_check: 'Сумма допсоглашения не может быть нулевой',
  object_contract_addenda_addendum_number_check: 'Укажите номер допсоглашения',
  object_ks2_entries_check: 'Акт КС-2 должен быть положительным, уменьшение объёма — отрицательным',
  object_ks2_entries_act_number_check: 'Укажите номер акта',
  object_ks6_entries_amount_check: 'Сумма КС-6 должна быть больше нуля',
  object_ks6_entries_doc_number_check: 'Укажите номер записи КС-6',
  object_kpi_assignments_check: 'Дата «по» не может быть раньше даты «с»',
  object_kpi_assignments_salary_check:
    'Зарплата задаётся только руководителю строительства и не может быть отрицательной',
  object_kpi_global_roles_check: 'Дата «по» не может быть раньше даты «с»',
  object_kpi_month_plans_months_remaining_check: 'Число расчётных месяцев должно быть не меньше одного',
  // Второй безымянный CHECK таблицы планов: ручное значение требует основания.
  object_kpi_month_plans_check1: 'Ручное значение плана требует указания основания',
  object_kpi_month_plans_period_month_check: 'Период плана задаётся первым числом месяца',
};

/**
 * Ошибки PostgreSQL, которые являются нарушением ввода, а не сбоем сервера.
 * Экспортируется ради тестов: без живой БД это единственный способ проверить, что
 * коды разбираются, а не уходят в 500.
 */
export function mapDatabaseError(error: unknown): { http: number; code: string; message: string } | null {
  const pg = error as { code?: string; constraint?: string };
  switch (pg.code) {
    case '23514':  // check_violation
      return {
        http: 400,
        code: 'check_violation',
        message: (pg.constraint && CHECK_MESSAGES[pg.constraint]) ?? 'Данные не прошли проверку базы',
      };
    case '23503':  // foreign_key_violation
      return { http: 400, code: 'fk_violation', message: 'Связанная запись не найдена' };
    case '23502':  // not_null_violation
      return { http: 400, code: 'not_null', message: 'Не заполнено обязательное поле' };
    case '23P01':  // exclusion_violation
      return { http: 409, code: 'period_overlap', message: 'Период пересекается с уже существующим' };
    case '22P02':  // invalid_text_representation
    case '22003':  // numeric_value_out_of_range
    case '22008':  // datetime_field_overflow
      return { http: 400, code: 'bad_value', message: 'Некорректное значение даты или суммы' };
    default:
      return null;
  }
}

type ReportRequest =
  | { params: ObjectKpiReportParams; period: { from: string; to: string } }
  | { error: { http: number; message: string } };

/**
 * Общий разбор запроса отчёта для /report и /report/summary: период (передан или авто),
 * скоуп, фильтр по объекту.
 *
 * В авто-режиме скоуп резолвится на СЕГОДНЯ, а не на вычисленное окно: окно считается по
 * объектам скоупа, и обратная зависимость дала бы цикл. Для экономиста и админа скоуп от
 * периода не зависит вовсе, а раздел ЛК руководителя ходит в /my/objects со своим периодом.
 */
async function resolveReportRequest(
  req: AuthenticatedRequest,
  options: { requireObjectInAutoMode: boolean },
): Promise<ReportRequest> {
  const { from, to } = optionalPeriodSchema.parse(req.query);
  // Валидируем как uuid: иначе мусорная строка даёт пустой 200, неотличимый от «нет данных».
  const requestedId = z.string().uuid().optional().parse(req.query.object_id ?? undefined);
  const isAuto = from === undefined || to === undefined;

  if (isAuto && options.requireObjectInAutoMode && !requestedId) {
    // Без объекта авто-режим построил бы решётку «все объекты × 10 лет» — ровно то,
    // ради чего заведён отдельный /report/summary.
    return { error: { http: 400, message: 'Укажите объект или период' } };
  }

  const explicitBounds = isAuto ? null : periodBounds(from!, to!);
  const scope = await resolveObjectKpiScope(
    req,
    explicitBounds ? { periodRange: { from: explicitBounds.monthFrom, to: explicitBounds.monthTo } } : {},
  );

  // Явный фильтр по объекту сужает скоуп, но не расширяет его.
  if (requestedId && !scope.object_ids.includes(requestedId)) {
    return { error: { http: 403, message: 'Объект вне вашего доступа' } };
  }
  const objectIds = requestedId ? [requestedId] : scope.object_ids;

  const window = explicitBounds
    ? { from: from!, to: to! }
    : await resolveCalcWindow(objectIds);
  const bounds = explicitBounds ?? periodBounds(window.from, window.to);

  return {
    params: { monthFrom: bounds.monthFrom, monthTo: bounds.monthTo, objectIds },
    period: window,
  };
}

export function respondWithError(res: Response, error: unknown, logPrefix: string): void {
  const known = extractObjectKpiError(error);
  if (known) {
    res.status(known.http).json({ success: false, error: known.message, code: known.code });
    return;
  }
  if (error instanceof z.ZodError) {
    res.status(400).json({ success: false, error: error.issues[0]?.message ?? 'Некорректные данные' });
    return;
  }

  const dbError = mapDatabaseError(error);
  if (dbError) {
    // Логируем и известные нарушения: имя констрейнта нужно, чтобы завести текст,
    // если он ещё не заведён.
    const pg = error as { code?: string; constraint?: string };
    console.error(`${logPrefix}: ${pg.code} ${pg.constraint ?? ''}`);
    res.status(dbError.http).json({ success: false, error: dbError.message, code: dbError.code });
    return;
  }

  console.error(`${logPrefix}:`, error);
  Sentry.captureException(error);
  if (!res.headersSent) {
    res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера' });
  }
}

export const objectKpiController = {
  /** Список объектов скоупа с краткой сводкой договора — для таблицы и форм ввода. */
  async listObjects(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const scope = await resolveObjectKpiScope(req);
      const rows = await query(
        `SELECT o.id, o.name, o.is_active,
                c.id AS contract_id, c.contract_number, c.customer_name, c.base_amount,
                to_char(c.contract_date,    'YYYY-MM-DD') AS contract_date,
                to_char(c.planned_zos_date, 'YYYY-MM-DD') AS planned_zos_date,
                to_char(c.actual_zos_date,  'YYYY-MM-DD') AS actual_zos_date,
                -- Первый расчётный месяц нужен фронту, чтобы «Показать все месяцы»
                -- открывало историю с начала расчёта, а не с фиксированного окна.
                to_char(c.plan_start_month, 'YYYY-MM-DD') AS plan_start_month,
                c.version AS contract_version
           FROM skud_objects o
           LEFT JOIN object_contracts c ON c.skud_object_id = o.id AND c.is_active
          WHERE o.id = ANY($1::uuid[])
          ORDER BY o.name`,
        [scope.object_ids],
      );
      // can_revise_plan — подсказка UI (показывать ли правку плана). Берётся кэш-версия:
      // денежная операция всё равно перепроверяет право в БД внутри своей транзакции.
      const canRevisePlan = req.user.is_admin === true
        || await isEconomicsHead(req.user.employee_id);

      res.json({
        success: true,
        data: rows,
        scope: { is_unrestricted: scope.is_unrestricted, can_revise_plan: canRevisePlan },
      });
    } catch (error) {
      respondWithError(res, error, '[object-kpi] listObjects');
    }
  },

  /**
   * Сводный отчёт. Скоуп резолвится С УЧЁТОМ ПЕРИОДА: руководитель обязан видеть месяцы,
   * за которые он отвечал, даже если закрепление уже закрыто.
   */
  async getReport(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const resolved = await resolveReportRequest(req, { requireObjectInAutoMode: true });
      if ('error' in resolved) {
        res.status(resolved.error.http).json({ success: false, error: resolved.error.message });
        return;
      }

      const rows = await fetchObjectKpiReport(resolved.params);
      res.json({
        success: true,
        data: rows,
        summary: summarizeCompletion(rows),
        period: resolved.period,
      });
    } catch (error) {
      respondWithError(res, error, '[object-kpi] getReport');
    }
  },

  /**
   * Сводка без строк: виджеты вкладки показывают весь период по всем объектам, а решётка
   * «объекты × месяцы» на таком окне — десятки тысяч строк, которые фронту не нужны.
   *
   * Формулы не дублируются: тот же fetchObjectKpiReport и та же summarizeCompletion, что
   * у /report. По нагрузке на БД это ровно тот же запрос — экономится только трафик,
   * поэтому фронт при выбранном объекте берёт summary из ответа /report, а не зовёт сюда.
   */
  async getReportSummary(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const resolved = await resolveReportRequest(req, { requireObjectInAutoMode: false });
      if ('error' in resolved) {
        res.status(resolved.error.http).json({ success: false, error: resolved.error.message });
        return;
      }

      const rows = await fetchObjectKpiReport(resolved.params);
      res.json({ success: true, summary: summarizeCompletion(rows), period: resolved.period });
    } catch (error) {
      respondWithError(res, error, '[object-kpi] getReportSummary');
    }
  },

  /**
   * Премия руководителей по месяцам для сводного отчёта — ВТОРЫМ запросом: путь тяжёлый,
   * и таблица не должна его ждать.
   *
   * Считается СОВОКУПНО по всем объектам руководителя (п. 3.5), даже если отчёт сужен до
   * одного объекта: премия по приказу — величина по человеку, а не по объекту. Поэтому
   * набор объектов для премии берётся из его закреплений, а не из фильтра отчёта.
   */
  async getReportPremium(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const resolved = await resolveReportRequest(req, { requireObjectInAutoMode: false });
      if ('error' in resolved) {
        res.status(resolved.error.http).json({ success: false, error: resolved.error.message });
        return;
      }

      const rows = await fetchObjectKpiReport(resolved.params);
      const managerIds = [...new Set(
        rows.flatMap((row) => (row.managers ?? []).map((item) => Number(item.employee_id))),
      )].filter((id) => Number.isFinite(id) && id > 0);

      const { monthFrom, monthTo } = resolved.params;
      const data: Array<{
        employee_id: number;
        period_month: string;
        status: string;
        completion_pct: string | null;
        coefficient: string | null;
        premium_amount: string | null;
      }> = [];

      // Последовательно, а не Promise.all: каждый вызов открывает свою транзакцию
      // REPEATABLE READ и строит полный отчёт по объектам руководителя.
      for (const employeeId of managerIds) {
        const objectIds = await loadAssignedObjectIds(employeeId, monthFrom, {
          from: monthFrom,
          to: monthTo,
        });
        if (objectIds.length === 0) continue;

        const result = await fetchManagerPremium({ employeeId, objectIds, monthFrom, monthTo });
        for (const month of result.premium) {
          data.push({
            employee_id: employeeId,
            period_month: month.period_month,
            status: month.status,
            completion_pct: month.completion_pct,
            coefficient: month.coefficient,
            premium_amount: month.premium_amount,
          });
        }
      }

      res.json({ success: true, data, period: resolved.period });
    } catch (error) {
      respondWithError(res, error, '[object-kpi] getReportPremium');
    }
  },

  /** Численность — вторым запросом: путь тяжёлый (skud_events по всем сотрудникам объектов). */
  async getHeadcount(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { from, to } = periodSchema.parse(req.query);
      const { monthFrom, monthTo } = periodBounds(from, to);
      const scope = await resolveObjectKpiScope(req, {
        periodRange: { from: monthFrom, to: monthTo },
      });

      const rows = await fetchObjectKpiHeadcount({
        objectIds: scope.object_ids,
        monthFrom,
        monthTo,
      });
      res.json({ success: true, data: rows });
    } catch (error) {
      respondWithError(res, error, '[object-kpi] getHeadcount');
    }
  },

  /** Карточка объекта: договор, ДС, КС-2, планы, закрепления и строки отчёта за период. */
  async getObjectCard(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const objectId = z.string().uuid().parse(req.params.objectId);
      // Период необязателен: без него карточка показывает весь расчёт по объекту.
      const { from, to } = optionalPeriodSchema.parse(req.query);
      const explicit = from && to ? periodBounds(from, to) : null;

      const scope = await resolveObjectKpiScope(
        req,
        explicit ? { periodRange: { from: explicit.monthFrom, to: explicit.monthTo } } : {},
      );
      if (!scope.object_ids.includes(objectId)) {
        res.status(403).json({ success: false, error: 'Объект вне вашего доступа' });
        return;
      }

      const window = explicit ? { from: from!, to: to! } : await resolveCalcWindow([objectId]);
      const { monthFrom, monthTo } = explicit ?? periodBounds(window.from, window.to);

      const contract = await getContractByObject(objectId);
      const [report, plans, assignments, addenda, ks2, ks6, fixedFlag] = await Promise.all([
        fetchObjectKpiReport({ monthFrom, monthTo, objectIds: [objectId] }),
        listMonthPlans(objectId, monthFrom, monthTo),
        listAssignments({ objectId }),
        contract ? listAddenda(contract.id) : Promise.resolve([]),
        contract ? listKs2Entries(contract.id) : Promise.resolve([]),
        contract ? listKs6Entries(contract.id) : Promise.resolve([]),
        // Отдельный флаг, а не вывод из plans: карточка отдаёт планы только за окно, а
        // зафиксированный месяц может лежать вне него — тогда форма не спросила бы
        // основание правки, и сохранение упало бы 400-й на ровном месте.
        queryOne<{ exists: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM object_kpi_month_plans
              WHERE skud_object_id = $1 AND is_current AND status IN ('fixed','corrected')
           ) AS exists`,
          [objectId],
        ),
      ]);

      res.json({
        success: true,
        data: {
          object_id: objectId,
          contract,
          addenda,
          ks2,
          ks6,
          plans,
          assignments: redactAssignmentSalary(assignments, await canSeeManagerSalary(req.user)),
          report,
          has_fixed_months: fixedFlag?.exists === true,
          period: window,
        },
      });
    } catch (error) {
      respondWithError(res, error, '[object-kpi] getObjectCard');
    }
  },

  async listPlans(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const objectId = z.string().uuid().parse(req.params.objectId);
      const { from, to } = periodSchema.parse(req.query);
      const { monthFrom, monthTo } = periodBounds(from, to);

      const scope = await resolveObjectKpiScope(req, {
        periodRange: { from: monthFrom, to: monthTo },
      });
      if (!scope.object_ids.includes(objectId)) {
        res.status(403).json({ success: false, error: 'Объект вне вашего доступа' });
        return;
      }

      // Все ревизии, а не только текущая: пересмотренный план обязан быть проверяем.
      const rows = await listMonthPlans(objectId, monthFrom, monthTo);
      res.json({ success: true, data: rows });
    } catch (error) {
      respondWithError(res, error, '[object-kpi] listPlans');
    }
  },

  async getHistory(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const objectId = z.string().uuid().parse(req.params.objectId);
      const scope = await resolveObjectKpiScope(req);
      if (!scope.object_ids.includes(objectId)) {
        res.status(403).json({ success: false, error: 'Объект вне вашего доступа' });
        return;
      }
      // Снимки закреплений в журнале несут оклад — редактируем так же, как список.
      const history = await listObjectKpiHistory(objectId);
      res.json({
        success: true,
        data: redactHistorySalary(history, await canSeeManagerSalary(req.user)),
      });
    } catch (error) {
      respondWithError(res, error, '[object-kpi] getHistory');
    }
  },

  /**
   * ЛК руководителя строительства: свои объекты за период плюс предварительный расчёт
   * премии по месяцам. Отдельный эндпоинт от /report, потому что гард страницы другой
   * (/employee/objects).
   *
   * Итоги считаются ПО ДОЛЯМ руководителя, а не summarizeCompletion по всем строкам окна:
   * иначе закреплённый с 14 августа человек видел бы в шапке план и факт за январь–июль,
   * то есть за месяцы, за которые он не отвечал.
   */
  async getMyObjects(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { from, to } = periodSchema.parse(req.query);
      const { monthFrom, monthTo } = periodBounds(from, to);

      const employeeId = req.user.employee_id;
      if (!employeeId) {
        res.json({
          success: true,
          data: [],
          premium: [],
          period_totals: EMPTY_PREMIUM_TOTALS,
          scales: [],
        });
        return;
      }

      // Только личные закрепления: ветка «видит всю стройку» из resolveObjectKpiScope
      // здесь неуместна — это личный кабинет, а не отчёт по компании. Выборка берётся
      // из общей функции, а не дублируется запросом: копия уже разъезжалась с эталоном
      // по границе месяца и прятала объект от руководителя.
      const objectIds = await loadAssignedObjectIds(employeeId, monthFrom, {
        from: monthFrom,
        to: monthTo,
      });

      const result = await fetchManagerPremium({ employeeId, objectIds, monthFrom, monthTo });
      res.json({
        success: true,
        data: result.rows,
        premium: result.premium,
        period_totals: result.period_totals,
        scales: result.scales,
      });
    } catch (error) {
      respondWithError(res, error, '[object-kpi] getMyObjects');
    }
  },

  /** Закрепления объектов — список для модалки «Назначения». */
  async listAssignments(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const scope = await resolveObjectKpiScope(req);
      const objectId = typeof req.query.object_id === 'string' ? req.query.object_id : undefined;
      if (objectId && !scope.object_ids.includes(objectId)) {
        res.status(403).json({ success: false, error: 'Объект вне вашего доступа' });
        return;
      }

      const rows = await listAssignments({
        objectId,
        activeOnly: req.query.active === 'true',
      });
      // Скоуп фильтрует и общий список: руководителю чужие закрепления не показываем.
      const allowed = new Set(scope.object_ids);
      res.json({
        success: true,
        data: redactAssignmentSalary(
          rows.filter((row) => allowed.has(row.skud_object_id)),
          await canSeeManagerSalary(req.user),
        ),
      });
    } catch (error) {
      respondWithError(res, error, '[object-kpi] listAssignments');
    }
  },

  /**
   * Поиск сотрудника для модалки «Назначения».
   *
   * Свой эндпоинт, а не /admin/employees/search: тот закрыт правом на /admin/users,
   * которого у экономиста нет и быть не должно. Здесь отдаются только id и ФИО.
   */
  async searchEmployees(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const term = z.string().trim().min(2, 'Введите минимум 2 символа').parse(req.query.q);
      const rows = await query<{ id: number; full_name: string | null }>(
        `SELECT id, full_name
           FROM employees
          WHERE employment_status = 'active'
            AND full_name ILIKE '%' || $1 || '%'
          ORDER BY full_name
          LIMIT 20`,
        [term],
      );
      res.json({ success: true, data: rows });
    } catch (error) {
      respondWithError(res, error, '[object-kpi] searchEmployees');
    }
  },

  /** Глобальные роли KPI (руководитель эк. отдела). Выдаёт и снимает их только админ. */
  async listGlobalRoles(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      res.json({ success: true, data: await listGlobalRoles() });
    } catch (error) {
      respondWithError(res, error, '[object-kpi] listGlobalRoles');
    }
  },

  /**
   * Когда закроется текущий месяц. Показывается на вкладке заранее, чтобы расхождение
   * с производственным календарём заметил человек, а не бухгалтерия постфактум.
   */
  async getFixationInfo(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const monthRaw = typeof req.query.month === 'string' ? req.query.month : null;
      const periodMonth = normalizeMonth(monthRaw ?? new Date().toISOString().slice(0, 7));
      const config = await getFreezerConfig();

      res.json({
        success: true,
        data: {
          period_month: periodMonth,
          fixation_date: await resolveFixationDate(periodMonth, config),
          working_day: config.fixWorkingDay,
          freezer_enabled: config.enabled,
        },
      });
    } catch (error) {
      respondWithError(res, error, '[object-kpi] getFixationInfo');
    }
  },
};

/** Имя пользователя для журнала изменений — берётся один раз на пишущий запрос. */
export async function resolveActorName(userId: string): Promise<string | null> {
  const row = await queryOne<{ full_name: string | null }>(
    'SELECT full_name FROM user_profiles WHERE id = $1',
    [userId],
  );
  return row?.full_name ?? null;
}
