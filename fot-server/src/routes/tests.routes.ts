import { Router } from 'express';
import { testsController } from '../controllers/tests.controller.js';
import { authenticate, requirePageAccess } from '../middleware/auth.js';

const router = Router();

router.use(authenticate);

const EMPLOYEE = '/employee/feedback';
const ADMIN = '/feedback-review';

// ---- Сотрудник ----
router.get('/available', requirePageAccess(EMPLOYEE, 'view'), testsController.getAvailable);

// ---- Администратор (специфичные пути до /:id) ----
router.get('/stats', requirePageAccess(ADMIN, 'view'), testsController.getStats);
router.get('/', requirePageAccess(ADMIN, 'view'), testsController.listTests);
router.post('/', requirePageAccess(ADMIN, 'edit'), testsController.create);

// ---- Сотрудник: работа с конкретным тестом ----
router.get('/:id/take', requirePageAccess(EMPLOYEE, 'view'), testsController.takeTest);
router.get('/:id/my-response', requirePageAccess(EMPLOYEE, 'view'), testsController.getMyResponse);
router.post('/:id/response', requirePageAccess(EMPLOYEE, 'edit'), testsController.submitResponse);

// ---- Администратор: конкретный тест ----
router.get('/:id/responses', requirePageAccess(ADMIN, 'view'), testsController.listResponses);
router.put('/:id/assignments', requirePageAccess(ADMIN, 'edit'), testsController.setAssignments);
router.get('/:id', requirePageAccess(ADMIN, 'view'), testsController.getTestFull);
router.put('/:id', requirePageAccess(ADMIN, 'edit'), testsController.update);
router.delete('/:id', requirePageAccess(ADMIN, 'edit'), testsController.deactivate);

export default router;
