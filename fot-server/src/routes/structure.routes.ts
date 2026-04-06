import { Router } from 'express';
import { structureController } from '../controllers/structure.controller.js';
import { authenticate, requirePosition, requireCritical2FA } from '../middleware/auth.js';
import { cacheResponse } from '../middleware/cacheResponse.js';

const router = Router();

const structureTreeCache = cacheResponse(() => 'structure:tree', 5 * 60_000);

// Все роуты требуют аутентификации
router.use(authenticate);

// GET /api/structure - получение дерева (worker+, кэш 5мин)
router.get(
  '/',
  requirePosition('worker', 'header', 'hr', 'admin', 'super_admin'),
  structureTreeCache,
  structureController.getTree
);

// GET /api/structure/positions - список должностей (worker+)
router.get(
  '/positions',
  requirePosition('worker', 'header', 'hr', 'admin', 'super_admin'),
  structureController.getPositions
);

// === Отделы (только super_admin) ===

// POST /api/structure/departments - создание отдела
router.post(
  '/departments',
  requirePosition('super_admin'),
  requireCritical2FA,
  structureController.createDepartment
);

// DELETE /api/structure/departments/:id - удаление отдела
router.delete(
  '/departments/:id',
  requirePosition('super_admin'),
  requireCritical2FA,
  structureController.deleteDepartment
);

// DELETE /api/structure/clear - очистка структуры (отделы + сотрудники)
router.delete(
  '/clear',
  requirePosition('super_admin'),
  requireCritical2FA,
  structureController.clearStructure
);

export default router;
