import { Router } from 'express';
import { timesheetController } from '../controllers/timesheet.controller.js';
import { authenticate, requirePosition } from '../middleware/auth.js';

const router = Router();

router.use(authenticate);

// GET /api/timesheet?month=YYYY-MM&department_id=...
router.get(
  '/',
  requirePosition('worker', 'header', 'hr', 'admin', 'super_admin'),
  timesheetController.getAll
);

// GET /api/timesheet/export?month=YYYY-MM&department_id=...
router.get(
  '/export',
  requirePosition('header', 'hr', 'admin', 'super_admin'),
  timesheetController.export
);

// POST /api/timesheet/export-mass
router.post(
  '/export-mass',
  requirePosition('header', 'hr', 'admin', 'super_admin'),
  timesheetController.exportMass
);

// POST /api/timesheet
router.post(
  '/',
  requirePosition('header', 'hr', 'admin', 'super_admin'),
  timesheetController.create
);

// PUT /api/timesheet/:id
router.put(
  '/:id',
  requirePosition('header', 'hr', 'admin', 'super_admin'),
  timesheetController.update
);

export default router;
