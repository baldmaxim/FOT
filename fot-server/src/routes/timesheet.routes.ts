import { Router } from 'express';
import { timesheetController } from '../controllers/timesheet.controller.js';
import { authenticate, requireAnyPageAccess } from '../middleware/auth.js';

const router = Router();

router.use(authenticate);

// GET /api/timesheet?month=YYYY-MM&department_id=...
router.get(
  '/',
  requireAnyPageAccess(['/employee/timesheet', '/timesheet', '/timesheet-hr'], 'view'),
  timesheetController.getAll
);

router.get(
  '/team-management-config',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr'], 'view'),
  timesheetController.getTeamManagementConfig
);

router.get(
  '/team-management/search-employees',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr'], 'edit'),
  timesheetController.searchTeamEmployees
);

router.post(
  '/team-management/add-employee',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr'], 'edit'),
  timesheetController.addEmployeeToDepartment
);

router.post(
  '/team-management/exclude-employee',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr'], 'edit'),
  timesheetController.excludeEmployeeFromDepartment
);

// GET /api/timesheet/export?month=YYYY-MM&department_id=...
router.get(
  '/export',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr'], 'view'),
  timesheetController.export
);

// POST /api/timesheet/export-mass
router.post(
  '/export-mass',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr'], 'edit'),
  timesheetController.exportMass
);

// POST /api/timesheet
router.post(
  '/',
  requireAnyPageAccess(['/employee/timesheet', '/timesheet', '/timesheet-hr'], 'edit'),
  timesheetController.create
);

// POST /api/timesheet/bulk
router.post(
  '/bulk',
  requireAnyPageAccess(['/employee/timesheet', '/timesheet', '/timesheet-hr'], 'edit'),
  timesheetController.bulkSave
);

// PUT /api/timesheet/object-entry
router.put(
  '/object-entry',
  requireAnyPageAccess(['/employee/timesheet', '/timesheet', '/timesheet-hr'], 'edit'),
  timesheetController.upsertObjectEntry
);

// DELETE /api/timesheet/object-entry
router.delete(
  '/object-entry',
  requireAnyPageAccess(['/employee/timesheet', '/timesheet', '/timesheet-hr'], 'edit'),
  timesheetController.deleteObjectEntry
);

// PUT /api/timesheet/:id
router.put(
  '/:id',
  requireAnyPageAccess(['/employee/timesheet', '/timesheet', '/timesheet-hr'], 'edit'),
  timesheetController.update
);

export default router;
