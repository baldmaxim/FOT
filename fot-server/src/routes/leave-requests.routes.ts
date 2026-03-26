import { Router } from 'express';
import { leaveRequestsController } from '../controllers/leave-requests.controller.js';
import { authenticate, requirePosition, requireOrganization, injectOrganizationFromQuery } from '../middleware/auth.js';

const router = Router();

router.use(authenticate);
router.use(injectOrganizationFromQuery);
router.use(requireOrganization);

// POST /api/leave-requests — создание заявления (worker+)
router.post(
  '/',
  requirePosition('worker', 'header', 'hr', 'admin', 'super_admin'),
  leaveRequestsController.create
);

// GET /api/leave-requests/my — мои заявления (worker+)
router.get(
  '/my',
  requirePosition('worker', 'header', 'hr', 'admin', 'super_admin'),
  leaveRequestsController.getMy
);

// GET /api/leave-requests/department — заявления отдела (header)
router.get(
  '/department',
  requirePosition('header', 'hr', 'admin', 'super_admin'),
  leaveRequestsController.getDepartment
);

// GET /api/leave-requests — все заявления организации (hr/admin)
router.get(
  '/',
  requirePosition('hr', 'admin', 'super_admin'),
  leaveRequestsController.getAll
);

// PATCH /api/leave-requests/:id/approve — одобрение (header/hr/admin)
router.patch(
  '/:id/approve',
  requirePosition('header', 'hr', 'admin', 'super_admin'),
  leaveRequestsController.approve
);

// PATCH /api/leave-requests/:id/reject — отклонение (header/hr/admin)
router.patch(
  '/:id/reject',
  requirePosition('header', 'hr', 'admin', 'super_admin'),
  leaveRequestsController.reject
);

// PATCH /api/leave-requests/:id/cancel — отмена (worker+)
router.patch(
  '/:id/cancel',
  requirePosition('worker', 'header', 'hr', 'admin', 'super_admin'),
  leaveRequestsController.cancel
);

export default router;
