import { query } from '../config/postgres.js';
import { moscowTodayIso } from '../utils/date.utils.js';
import { resolveEffectivePageAccess } from './access-control.service.js';
import { isEconomicsHead } from './object-kpi-roles-cache.service.js';
import { getRoleByCode } from './roles-cache.service.js';
import { failWith } from './object-kpi-errors.js';
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

export type AssignmentScopeRoleKind = 'construction_manager' | 'object_economist';

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
 * Объекты, закреплённые за сотрудником в заданной роли закрепления.
 *
 * @param onDate      срез на дату (по умолчанию сегодня, МСК)
 * @param periodRange для отчёта за период — пересечение периода закрепления с окном,
 *                    иначе руководитель не увидит месяцы, за которые он отвечал,
 *                    но уже не отвечает сегодня.
 * @param roleKind    'construction_manager' (ЛК руководителя, премия — по умолчанию,
 *                    поведение не менялось) либо 'object_economist' (скоуп экономиста,
 *                    миграция 262).
 */
export async function loadAssignedObjectIds(
  employeeId: number,
  onDate: string,
  periodRange: { from: string; to: string } | null,
  roleKind: AssignmentScopeRoleKind = 'construction_manager',
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
          AND role_kind = $4
          AND valid_from < ($3::date + INTERVAL '1 month')
          AND (valid_to IS NULL OR valid_to >= $2::date)`,
      [employeeId, periodRange.from, periodRange.to, roleKind],
    );
    return rows.map((row) => row.skud_object_id);
  }

  const rows = await query<{ skud_object_id: string }>(
    `SELECT DISTINCT skud_object_id
       FROM object_kpi_assignments
      WHERE employee_id = $1
        AND role_kind = $3
        AND valid_from <= $2::date
        AND (valid_to IS NULL OR valid_to >= $2::date)`,
    [employeeId, onDate, roleKind],
  );
  return rows.map((row) => row.skud_object_id);
}

/**
 * Флаг роли «KPI объектов: только закреплённые объекты» (system_roles.object_kpi_own_objects_only,
 * миграция 262). Для админа не действует — его скоуп всегда вся стройка.
 */
export async function hasOwnObjectsOnlyKpiScope(req: AuthenticatedRequest): Promise<boolean> {
  if (req.user.is_admin) return false;
  const role = await getRoleByCode(req.user.role_code);
  return role?.object_kpi_own_objects_only === true;
}

/**
 * Право управлять закреплениями (список, поиск сотрудников, создание/правка/удаление).
 * Только админ и руководитель экономического отдела — НЕ `is_unrestricted`: полный скоуп
 * получает и любая роль с правом на страницу без флага, а расширять себе доступ через
 * закрепления она не должна.
 */
export async function canManageObjectKpiAssignments(req: AuthenticatedRequest): Promise<boolean> {
  if (req.user.is_admin) return true;
  return isEconomicsHead(req.user.employee_id);
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

  // Экономист объекта (флаг роли, миграция 262): только объекты своих закреплений
  // object_economist. Проверяется ДО права на страницу — иначе право дало бы всю стройку.
  if (await hasOwnObjectsOnlyKpiScope(req)) {
    if (!req.user.employee_id) return EMPTY_SCOPE;
    const objectIds = await loadAssignedObjectIds(
      req.user.employee_id,
      options.onDate ?? moscowTodayIso(),
      options.periodRange ?? null,
      'object_economist',
    );
    return { is_unrestricted: false, object_ids: objectIds };
  }

  // Роль с правом на страницу без флага видит всю стройку (Этап 1 — как было).
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

export const OBJECT_OUT_OF_SCOPE_MESSAGE = 'Объект вне вашего доступа';
export const ASSIGNMENTS_MANAGE_DENIED_MESSAGE =
  'Управление закреплениями доступно администратору и руководителю экономического отдела';

/**
 * 403 до любой записи — для мутаций по прямому id (ДС, КС-2, КС-6): объект записи
 * резолвится lookup-ом, и вне скоупа сервис мутации и аудит не вызываются.
 * Бросает маркер-ошибку KPI (`failWith`), которую разбирает respondWithError.
 */
export async function assertObjectInScopeOr403(
  req: AuthenticatedRequest,
  objectId: string,
  options: { onDate?: string; periodRange?: { from: string; to: string } } = {},
): Promise<void> {
  if (!(await isObjectInScope(req, objectId, options))) {
    failWith({ http: 403, code: 'object_out_of_scope', message: OBJECT_OUT_OF_SCOPE_MESSAGE });
  }
}

/** 403 для операций с закреплениями у всех, кроме админа и руководителя эк. отдела. */
export async function assertCanManageAssignmentsOr403(req: AuthenticatedRequest): Promise<void> {
  if (!(await canManageObjectKpiAssignments(req))) {
    failWith({ http: 403, code: 'assignments_forbidden', message: ASSIGNMENTS_MANAGE_DENIED_MESSAGE });
  }
}
