import { query } from '../config/postgres.js';
import { moscowTodayIso } from '../utils/date.utils.js';
import { resolveEffectivePageAccess } from './access-control.service.js';
import { isEconomicsHead } from './object-kpi-roles-cache.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * Какие объекты строительства видит пользователь в KPI-контуре.
 *
 * Правило одно и жёсткое: источник закрепления — только object_kpi_assignments.
 * Fallback на employee_skud_object_access ЗАПРЕЩЁН. Та таблица означает «место
 * работы сотрудника» для СКУД-присутствия, не имеет периода и участвует в правах
 * на табель — по ней руководитель получил бы объект без официального закрепления
 * или с несовпадающим периодом, а KPI считает деньги.
 */

export interface ObjectKpiScope {
  /** true — видит всю стройку; object_ids при этом всё равно заполнен. */
  is_unrestricted: boolean;
  object_ids: string[];
}

const EMPTY_SCOPE: ObjectKpiScope = { is_unrestricted: false, object_ids: [] };

/**
 * Все объекты, участвующие в KPI: активные ЛИБО имеющие денежную историю.
 *
 * is_active НЕ фильтрует историю: после архивирования объекта его прошлые месяцы
 * обязаны остаться в отчёте, иначе сводный процент руководителя за закрытый период
 * изменится задним числом. Признак управляет только списками и формами ввода —
 * это решается на уровне UI и валидации записи, а не здесь.
 */
async function loadAllKpiObjectIds(): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `SELECT o.id
       FROM skud_objects o
      WHERE o.is_active = true
         OR EXISTS (SELECT 1 FROM object_contracts c WHERE c.skud_object_id = o.id)
         OR EXISTS (SELECT 1 FROM object_kpi_month_plans p WHERE p.skud_object_id = o.id)
      ORDER BY o.name`,
  );
  return rows.map((row) => row.id);
}

/**
 * Объекты, закреплённые за руководителем строительства.
 *
 * @param onDate      срез на дату (по умолчанию сегодня, МСК)
 * @param periodRange для отчёта за период — пересечение периода закрепления с окном,
 *                    иначе руководитель не увидит месяцы, за которые он отвечал,
 *                    но уже не отвечает сегодня.
 */
export async function loadAssignedObjectIds(
  employeeId: number,
  onDate: string,
  periodRange: { from: string; to: string } | null,
): Promise<string[]> {
  if (periodRange) {
    // Границы окна приходят ПЕРВЫМИ числами месяцев. Верхняя обязана раздвигаться до
    // конца месяца: закрепление, оформленное 14-го числа, иначе невидимо в собственном
    // месяце — сравнение `2026-08-14 <= 2026-08-01` даёт пустой скоуп, и руководитель
    // видит «за вами не закреплено объектов» при заведённом договоре.
    // Полуинтервал `< месяц + 1` вместо `<= последний день`: не зависит от длины месяца.
    const rows = await query<{ skud_object_id: string }>(
      `SELECT DISTINCT skud_object_id
         FROM object_kpi_assignments
        WHERE employee_id = $1
          AND role_kind = 'construction_manager'
          AND valid_from < ($3::date + INTERVAL '1 month')
          AND (valid_to IS NULL OR valid_to >= $2::date)`,
      [employeeId, periodRange.from, periodRange.to],
    );
    return rows.map((row) => row.skud_object_id);
  }

  const rows = await query<{ skud_object_id: string }>(
    `SELECT DISTINCT skud_object_id
       FROM object_kpi_assignments
      WHERE employee_id = $1
        AND role_kind = 'construction_manager'
        AND valid_from <= $2::date
        AND (valid_to IS NULL OR valid_to >= $2::date)`,
    [employeeId, onDate],
  );
  return rows.map((row) => row.skud_object_id);
}

export async function resolveObjectKpiScope(
  req: AuthenticatedRequest,
  options: { onDate?: string; periodRange?: { from: string; to: string } } = {},
): Promise<ObjectKpiScope> {
  // Мемоизация на HTTP-запрос — по образцу __skud_object_scope. Только для срезки
  // «сегодня»: запрос с явным периодом даёт другой набор и кэшироваться не должен.
  const cacheable = !options.onDate && !options.periodRange;
  if (cacheable && req.user.__object_kpi_scope) {
    return req.user.__object_kpi_scope;
  }

  const scope = await computeObjectKpiScope(req, options);
  if (cacheable) {
    req.user.__object_kpi_scope = scope;
  }
  return scope;
}

async function computeObjectKpiScope(
  req: AuthenticatedRequest,
  options: { onDate?: string; periodRange?: { from: string; to: string } },
): Promise<ObjectKpiScope> {
  if (req.user.is_admin) {
    return { is_unrestricted: true, object_ids: await loadAllKpiObjectIds() };
  }

  // Руководитель экономического отдела ведёт всю стройку.
  if (await isEconomicsHead(req.user.employee_id)) {
    return { is_unrestricted: true, object_ids: await loadAllKpiObjectIds() };
  }

  // Экономист тоже видит всю стройку (Этап 1). Сужение до «экономиста объекта»
  // по role_kind='object_economist' включается позже отдельным флагом роли.
  if (await resolveEffectivePageAccess(req, '/discipline/objects', 'view')) {
    return { is_unrestricted: true, object_ids: await loadAllKpiObjectIds() };
  }

  if (!req.user.employee_id) return EMPTY_SCOPE;

  const objectIds = await loadAssignedObjectIds(
    req.user.employee_id,
    options.onDate ?? moscowTodayIso(),
    options.periodRange ?? null,
  );
  return { is_unrestricted: false, object_ids: objectIds };
}

/**
 * Проверка явно запрошенного объекта. Пустой скоуп даёт false — это корректно:
 * «нет закреплений» означает «нет доступа», а не «доступ ко всему».
 *
 * options обязаны пробрасываться при открытии карточки за период: без них берётся срез
 * «сегодня», и руководитель, чьё закрепление кончилось в июле, получил бы 403 на тот самый
 * июльский объект, который видит строкой в сводном отчёте.
 */
export async function isObjectInScope(
  req: AuthenticatedRequest,
  objectId: string,
  options: { onDate?: string; periodRange?: { from: string; to: string } } = {},
): Promise<boolean> {
  const scope = await resolveObjectKpiScope(req, options);
  return scope.object_ids.includes(objectId);
}
