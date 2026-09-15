// Точечные права на ЧТЕНИЕ двух экранов без расширения общего скоупа данных.
//
//  - /skud-presence/all-objects — «Сотрудники на объектах» и их выгрузка по всем объектам;
//  - /dashboard/all-departments — «Обзор» по любому отделу (присутствие и статистика).
//
// Намеренно НЕ встроено в resolveAccessibleObjectIdsForRequest / resolveAccessibleDepartmentIds /
// resolveScopedDepartmentId: те резолверы решают табель, заявления, документы, назначения и
// запись. Расширение применяется только в обработчиках этих двух экранов.
//
// Каждое право действует лишь вместе с базовым просмотром своей страницы. Администратор
// сюда не попадает: у него своя логика (company scope), поведение не меняется.

import { PAGE_PATHS } from '../config/access-control.js';
import { resolveEffectivePageAccess } from './access-control.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

const hasGrantWithBasePage = async (
  req: AuthenticatedRequest,
  basePage: string,
  grantPage: string,
): Promise<boolean> => {
  if (req.user.is_admin) return false;
  if (!(await resolveEffectivePageAccess(req, basePage, 'view'))) return false;
  return resolveEffectivePageAccess(req, grantPage, 'view');
};

/** «Сотрудники на объектах — все объекты». */
export const hasPresenceAllObjectsGrant = (req: AuthenticatedRequest): Promise<boolean> =>
  hasGrantWithBasePage(req, PAGE_PATHS.SKUD_PRESENCE, PAGE_PATHS.SKUD_PRESENCE_ALL_OBJECTS);

/** «Обзор — все отделы». */
export const hasDashboardAllDepartmentsGrant = (req: AuthenticatedRequest): Promise<boolean> =>
  hasGrantWithBasePage(req, PAGE_PATHS.DASHBOARD, PAGE_PATHS.DASHBOARD_ALL_DEPARTMENTS);
