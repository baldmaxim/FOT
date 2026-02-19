import { Router } from 'express';
import { structureController } from '../controllers/structure.controller.js';
import { authenticate, requirePosition, requireOrganization, require2FA, injectOrganizationFromQuery } from '../middleware/auth.js';

const router = Router();

// Все роуты требуют аутентификации и организации
router.use(authenticate as any);
router.use(requireOrganization as any);
router.use(injectOrganizationFromQuery as any);

// GET /api/structure - получение дерева (worker+)
router.get(
  '/',
  requirePosition('worker', 'header', 'admin', 'super_admin') as any,
  structureController.getTree as any
);

// === Компании (только super_admin) ===

// POST /api/structure/companies - создание компании
router.post(
  '/companies',
  requirePosition('super_admin') as any,
  require2FA as any,
  structureController.createCompany as any
);

// DELETE /api/structure/companies/:id - удаление компании
router.delete(
  '/companies/:id',
  requirePosition('super_admin') as any,
  require2FA as any,
  structureController.deleteCompany as any
);

// === Отделы (только super_admin) ===

// POST /api/structure/departments - создание отдела
router.post(
  '/departments',
  requirePosition('super_admin') as any,
  require2FA as any,
  structureController.createDepartment as any
);

// DELETE /api/structure/departments/:id - удаление отдела
router.delete(
  '/departments/:id',
  requirePosition('super_admin') as any,
  require2FA as any,
  structureController.deleteDepartment as any
);

// === Подразделения (только super_admin) ===

// POST /api/structure/subdivisions - создание подразделения
router.post(
  '/subdivisions',
  requirePosition('super_admin') as any,
  require2FA as any,
  structureController.createSubdivision as any
);

// DELETE /api/structure/subdivisions/:id - удаление подразделения
router.delete(
  '/subdivisions/:id',
  requirePosition('super_admin') as any,
  require2FA as any,
  structureController.deleteSubdivision as any
);

export default router;
