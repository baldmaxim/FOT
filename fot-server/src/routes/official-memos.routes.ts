import { Router } from 'express';
import { officialMemosController } from '../controllers/official-memos.controller.js';
import { authenticate, requirePageAccess } from '../middleware/auth.js';

const router = Router();

router.use(authenticate);

router.post(
  '/',
  requirePageAccess('/employee/requests', 'edit'),
  officialMemosController.create
);

router.get(
  '/my',
  requirePageAccess('/employee/requests', 'view'),
  officialMemosController.getMy
);

router.get(
  '/',
  requirePageAccess('/leave-requests', 'view'),
  officialMemosController.getAll
);

router.patch(
  '/:id/approve',
  requirePageAccess('/leave-requests', 'edit'),
  officialMemosController.approve
);

router.patch(
  '/:id/reject',
  requirePageAccess('/leave-requests', 'edit'),
  officialMemosController.reject
);

router.patch(
  '/:id/cancel',
  requirePageAccess('/employee/requests', 'edit'),
  officialMemosController.cancel
);

export default router;
