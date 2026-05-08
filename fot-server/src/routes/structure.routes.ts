import { Router } from 'express';
import type { Request } from 'express';
import { structureController } from '../controllers/structure.controller.js';
import { authenticate, requireAdmin, requireAnyPageAccess, requireCritical2FA, requirePageAccess } from '../middleware/auth.js';
import { registerCache, invalidateCaches } from '../middleware/cacheResponse.js';
import { invalidateStructureCache } from '../services/employee-mapper.service.js';
import { invalidateAccessibleScopeCache } from '../services/data-scope.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

const router = Router();

// SWR-окно 60 мин при TTL 15 мин: при истечении TTL запрос отдаёт STALE мгновенно,
// в фоне дёргается loadTreeForCache. При сбое refresh окно продлевается на 5 мин.
// Это ключевое лечение «бэк не успевает обрабатывать»: пользователь не ждёт Supabase.
//
// Ключ кеша обязан включать user_id: loadTreeForCache фильтрует дерево по
// req.user.company_scope / __company_subtree_ids и для manager-пользователя без
// employee_department_access возвращает { departments: [] }. С общим ключом
// 'structure:tree' такой пустой ответ закэшировался бы для ВСЕХ пользователей
// на 15-60 мин — отсюда симптом «после рестарта показывается, потом со временем
// перестаёт». Per-user ключ изолирует эти кэши друг от друга.
const structureTreeCache = registerCache(
  'structure:tree',
  (req: Request) => `structure:tree:${(req as AuthenticatedRequest).user?.id ?? 'anon'}`,
  15 * 60_000,
  {
    staleMs: 60 * 60_000,
    refresh: (req: Request) => structureController.loadTreeForCache(req as AuthenticatedRequest),
  },
);
const structurePositionsCache = registerCache('structure:positions', () => 'structure:positions', 15 * 60_000);

// Все роуты требуют аутентификации
router.use(authenticate);

// Write-through invalidation: после любой правки структуры сбрасываем кэши
// (HTTP-ответы + in-memory кэш в employee-mapper.service).
router.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        invalidateCaches('structure:tree', 'structure:positions');
        invalidateStructureCache();
        invalidateAccessibleScopeCache();
      }
    });
  }
  next();
});

// GET /api/structure - получение дерева (worker+, кэш 15мин)
router.get(
  '/',
  requireAnyPageAccess(['/employee', '/dashboard', '/staff-control', '/admin/users', '/admin/payslips', '/skud-settings'], 'view'),
  structureTreeCache,
  structureController.getTree
);

// GET /api/structure/positions - список должностей (worker+, кэш 15мин)
router.get(
  '/positions',
  requireAnyPageAccess(['/employee', '/dashboard', '/staff-control', '/admin/users', '/admin/payslips', '/skud-settings'], 'view'),
  structurePositionsCache,
  structureController.getPositions
);

// === Отделы ===

// POST /api/structure/departments - создание отдела
router.post(
  '/departments',
  requireAdmin,
  requireCritical2FA,
  structureController.createDepartment
);

// PUT /api/structure/departments/:id - переименование/смена родителя
router.put(
  '/departments/:id',
  requireAdmin,
  requireCritical2FA,
  structureController.updateDepartment
);

// POST /api/structure/departments/batch-move - массовое перемещение отделов
router.post(
  '/departments/batch-move',
  requireAdmin,
  requireCritical2FA,
  structureController.batchMoveDepartments
);

// DELETE /api/structure/departments/:id - удаление отдела
router.delete(
  '/departments/:id',
  requireAdmin,
  requireCritical2FA,
  structureController.deleteDepartment
);

// DELETE /api/structure/departments/:id/recursive - рекурсивное удаление отдела
router.delete(
  '/departments/:id/recursive',
  requireAdmin,
  requireCritical2FA,
  structureController.deleteDepartmentRecursive
);

// DELETE /api/structure/clear - очистка структуры (отделы + сотрудники)
router.delete(
  '/clear',
  requirePageAccess('/skud-settings', 'edit'),
  requireCritical2FA,
  structureController.clearStructure
);

export default router;
