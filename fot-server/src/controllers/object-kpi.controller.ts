import type { Response } from 'express';
import * as Sentry from '@sentry/node';
import { z } from 'zod';

import { query, queryOne } from '../config/postgres.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { extractObjectKpiError } from '../services/object-kpi-errors.js';
import { getFreezerConfig, resolveFixationDate } from '../services/object-kpi-plan-freezer.service.js';
import { fetchObjectKpiHeadcount } from '../services/object-kpi-headcount.service.js';
import { listMonthPlans, normalizeMonth } from '../services/object-kpi-plan.service.js';
import { fetchObjectKpiReport, summarizeCompletion } from '../services/object-kpi-report.service.js';
import { listObjectKpiHistory } from '../services/object-kpi-history.service.js';
import { loadAssignedObjectIds, resolveObjectKpiScope } from '../services/object-kpi-scope.service.js';
import { getContractByObject, listAddenda, listKs2Entries } from '../services/object-kpi.service.js';
import { listAssignments, listGlobalRoles } from '../services/object-kpi-assignments.service.js';

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

function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  return (ty * 12 + tm) - (fy * 12 + fm) + 1;
}

/** Границы окна в виде первых чисел месяцев — формат, который ждёт отчётный SQL. */
function periodBounds(from: string, to: string): { monthFrom: string; monthTo: string } {
  return { monthFrom: `${from}-01`, monthTo: `${to}-01` };
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
                to_char(c.planned_zos_date, 'YYYY-MM-DD') AS planned_zos_date,
                to_char(c.actual_zos_date,  'YYYY-MM-DD') AS actual_zos_date,
                c.version AS contract_version
           FROM skud_objects o
           LEFT JOIN object_contracts c ON c.skud_object_id = o.id AND c.is_active
          WHERE o.id = ANY($1::uuid[])
          ORDER BY o.name`,
        [scope.object_ids],
      );
      res.json({ success: true, data: rows, scope: { is_unrestricted: scope.is_unrestricted } });
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
      const { from, to } = periodSchema.parse(req.query);
      const { monthFrom, monthTo } = periodBounds(from, to);

      const scope = await resolveObjectKpiScope(req, {
        periodRange: { from: monthFrom, to: monthTo },
      });

      // Явный фильтр по объекту сужает скоуп, но не расширяет его.
      const requestedId = typeof req.query.object_id === 'string' ? req.query.object_id : null;
      const objectIds = requestedId
        ? scope.object_ids.filter((id) => id === requestedId)
        : scope.object_ids;

      const rows = await fetchObjectKpiReport({ monthFrom, monthTo, objectIds });
      res.json({ success: true, data: rows, summary: summarizeCompletion(rows) });
    } catch (error) {
      respondWithError(res, error, '[object-kpi] getReport');
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
      const { from, to } = periodSchema.parse(req.query);
      const { monthFrom, monthTo } = periodBounds(from, to);

      const scope = await resolveObjectKpiScope(req, {
        periodRange: { from: monthFrom, to: monthTo },
      });
      if (!scope.object_ids.includes(objectId)) {
        res.status(403).json({ success: false, error: 'Объект вне вашего доступа' });
        return;
      }

      const contract = await getContractByObject(objectId);
      const [report, plans, assignments, addenda, ks2] = await Promise.all([
        fetchObjectKpiReport({ monthFrom, monthTo, objectIds: [objectId] }),
        listMonthPlans(objectId, monthFrom, monthTo),
        listAssignments({ objectId }),
        contract ? listAddenda(contract.id) : Promise.resolve([]),
        contract ? listKs2Entries(contract.id) : Promise.resolve([]),
      ]);

      res.json({
        success: true,
        data: { object_id: objectId, contract, addenda, ks2, plans, assignments, report },
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
      res.json({ success: true, data: await listObjectKpiHistory(objectId) });
    } catch (error) {
      respondWithError(res, error, '[object-kpi] getHistory');
    }
  },

  /**
   * ЛК руководителя строительства: только свои объекты за период, без правки.
   * Отдельный эндпоинт от /report, потому что гард страницы другой (/employee/objects).
   */
  async getMyObjects(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { from, to } = periodSchema.parse(req.query);
      const { monthFrom, monthTo } = periodBounds(from, to);

      const employeeId = req.user.employee_id;
      if (!employeeId) {
        res.json({ success: true, data: [], summary: summarizeCompletion([]) });
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

      const rows = await fetchObjectKpiReport({ monthFrom, monthTo, objectIds });
      res.json({ success: true, data: rows, summary: summarizeCompletion(rows) });
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
      res.json({ success: true, data: rows.filter((row) => allowed.has(row.skud_object_id)) });
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
