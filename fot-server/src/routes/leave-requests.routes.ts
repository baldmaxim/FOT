import { Router } from 'express';
import { leaveRequestsController } from '../controllers/leave-requests.controller.js';
import { authenticate, requireAnyPageAccess, requirePageAccess } from '../middleware/auth.js';
import { noStore } from '../middleware/noStore.js';

const router = Router();

router.use(authenticate);
router.use(noStore);

// POST /api/leave-requests — создание заявления (worker+)
router.post(
  '/',
  requirePageAccess('/employee/requests', 'edit'),
  leaveRequestsController.create
);

// GET /api/leave-requests/my — мои заявления (worker+)
router.get(
  '/my',
  requirePageAccess('/employee/requests', 'view'),
  leaveRequestsController.getMy
);

// GET /api/leave-requests/my-objects — объекты сотрудника для привязки корректировки (worker+)
router.get(
  '/my-objects',
  requirePageAccess('/employee/requests', 'view'),
  leaveRequestsController.getMyObjects
);

// GET /api/leave-requests/department — заявления отдела (header)
router.get(
  '/department',
  requirePageAccess('/leave-requests', 'view'),
  leaveRequestsController.getDepartment
);

// GET /api/leave-requests/pending-count — счётчик pending для бейджа в меню
router.get(
  '/pending-count',
  requirePageAccess('/leave-requests', 'view'),
  leaveRequestsController.pendingCount
);

// GET /api/leave-requests/vacations — отпуска всех сотрудников кроме рабочих (admin/hr)
// Должен идти ДО GET /:id, иначе '/vacations' матчится как id.
router.get(
  '/vacations',
  requirePageAccess('/leave-vacations', 'view'),
  leaveRequestsController.getVacations
);

// GET /api/leave-requests — все заявления организации (hr/admin)
router.get(
  '/',
  requirePageAccess('/leave-requests', 'view'),
  leaveRequestsController.getAll
);

// GET /api/leave-requests/:id — детали заявки (автор или ревьюер)
router.get(
  '/:id',
  requireAnyPageAccess(['/employee/requests', '/leave-requests'], 'view'),
  leaveRequestsController.getById
);

// PATCH /api/leave-requests/:id/approve — одобрение (header/hr/admin)
router.patch(
  '/:id/approve',
  requirePageAccess('/leave-requests', 'edit'),
  leaveRequestsController.approve
);

// PATCH /api/leave-requests/:id/reject — отклонение (header/hr/admin)
router.patch(
  '/:id/reject',
  requirePageAccess('/leave-requests', 'edit'),
  leaveRequestsController.reject
);

// PATCH /api/leave-requests/:id/cancel — отмена (worker+)
router.patch(
  '/:id/cancel',
  requirePageAccess('/employee/requests', 'edit'),
  leaveRequestsController.cancel
);

// PATCH /api/leave-requests/:id/revoke-approval — управленческая отмена согласованного
// отпуска. Гейт пускает руководителей/админа; точную проверку «согласовавший/админ»
// делает контроллер (page-access сам по себе недостаточен).
router.patch(
  '/:id/revoke-approval',
  requirePageAccess('/leave-requests', 'edit'),
  leaveRequestsController.revokeApproval
);

// PATCH /api/leave-requests/:id/hr-acknowledge — отметка «Отдел кадров ознакомлен» (admin/hr)
router.patch(
  '/:id/hr-acknowledge',
  requirePageAccess('/leave-vacations', 'edit'),
  leaveRequestsController.hrAcknowledge
);

export default router;
