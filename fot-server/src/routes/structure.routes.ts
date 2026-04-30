import { Router } from 'express';
import { structureController } from '../controllers/structure.controller.js';
import { authenticate, requireAnyPageAccess, requireCritical2FA, requirePageAccess } from '../middleware/auth.js';
import { cacheResponse } from '../middleware/cacheResponse.js';

const router = Router();

const structureTreeCache = cacheResponse(() => 'structure:tree', 5 * 60_000);

// Все роуты требуют аутентификации
router.use(authenticate);

// GET /api/structure - получение дерева (worker+, кэш 5мин)
router.get(
  '/',
  requireAnyPageAccess(['/employee', '/dashboard', '/staff-control', '/admin/users', '/admin/payslips', '/skud-settings'], 'view'),
  structureTreeCache,
  structureController.getTree
);

// GET /api/structure/positions - список должностей (worker+)
router.get(
  '/positions',
  requireAnyPageAccess(['/employee', '/dashboard', '/staff-control', '/admin/users', '/admin/payslips', '/skud-settings'], 'view'),
  structureController.getPositions
);

// === Отделы ===

// POST /api/structure/departments - создание отдела
router.post(
  '/departments',
  requirePageAccess('/employees/structure-manage', 'edit'),
  requireCritical2FA,
  structureController.createDepartment
);

// PUT /api/structure/departments/:id - переименование/смена родителя
router.put(
  '/departments/:id',
  requirePageAccess('/employees/structure-manage', 'edit'),
  requireCritical2FA,
  structureController.updateDepartment
);

// POST /api/structure/departments/batch-move - массовое перемещение отделов
router.post(
  '/departments/batch-move',
  requirePageAccess('/employees/structure-manage', 'edit'),
  requireCritical2FA,
  structureController.batchMoveDepartments
);

// DELETE /api/structure/departments/:id - удаление отдела
router.delete(
  '/departments/:id',
  requirePageAccess('/employees/structure-manage', 'edit'),
  requireCritical2FA,
  structureController.deleteDepartment
);

// DELETE /api/structure/departments/:id/recursive - рекурсивное удаление отдела
router.delete(
  '/departments/:id/recursive',
  requirePageAccess('/employees/structure-manage', 'edit'),
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
