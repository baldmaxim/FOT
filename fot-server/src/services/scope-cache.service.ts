import { invalidateCaches } from '../middleware/cacheResponse.js';
import { invalidateStructureCache } from './employee-mapper.service.js';
import { invalidateAccessibleScopeCache } from './data-scope.service.js';

/**
 * Сбрасывает все кеши, зависящие от scope доступа (employee_department_access /
 * user_company_access). Используется после мутаций назначений отделов/компаний
 * руководителю в admin-users.controller. Без этого вызова /api/structure
 * продолжает отдавать stale-дерево (TTL 15 мин + SWR-окно 60 мин), а
 * resolveAccessibleDepartmentIds — закэшированный subtree.
 *
 * Зеркалит набор инвалидаций из structure.routes.ts write-through хука.
 */
export function invalidateDepartmentScopeCaches(): void {
  invalidateCaches('structure:tree', 'structure:positions');
  invalidateStructureCache();
  invalidateAccessibleScopeCache();
}

/**
 * Сбрасывает закешированные JSON-ответы, зависящие от глобального read-скоупа
 * роли (system_roles.view_all_departments). Вызывается при изменении флага у роли
 * (roles.controller) и при смене роли пользователя (admin-users.controller):
 * без этого после выключения флага пользователь дочитывал бы закешированные
 * данные всей организации до истечения TTL.
 */
export function invalidateGlobalReadScopeCaches(): void {
  invalidateCaches(
    'structure:tree',
    'timesheet',
    'timesheet:today',
    'timesheet:overview',
    'timesheet:overview:today',
    'timesheet:search',
  );
}
