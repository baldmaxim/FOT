import { Router } from 'express';
import { timesheetController } from '../controllers/timesheet.controller.js';
import { authenticate, requireAnyPageAccess, requirePageAccess } from '../middleware/auth.js';

const router = Router();

router.use(authenticate);

// GET /api/timesheet?month=YYYY-MM&department_id=...
router.get(
  '/overview',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr'], 'view'),
  timesheetController.getOverview
);

router.get(
  '/',
  requireAnyPageAccess(['/employee', '/timesheet', '/timesheet-hr'], 'view'),
  timesheetController.getAll
);

router.get(
  '/team-management-config',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr', '/timesheet/team-management'], 'view'),
  timesheetController.getTeamManagementConfig
);

router.get(
  '/team-management/search-employees',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr', '/timesheet/team-management'], 'edit'),
  timesheetController.searchTeamEmployees
);

router.post(
  '/team-management/add-employee',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr', '/timesheet/team-management'], 'edit'),
  timesheetController.addEmployeeToDepartment
);

router.post(
  '/team-management/exclude-employee',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr', '/timesheet/team-management'], 'edit'),
  timesheetController.excludeEmployeeFromDepartment
);

// GET /api/timesheet/export?month=YYYY-MM&department_id=...
router.get(
  '/export',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr'], 'view'),
  timesheetController.export
);

// POST /api/timesheet/export-mass — доступ к очереди табелей HR.
router.post(
  '/export-mass',
  requirePageAccess('/timesheet-hr', 'view'),
  timesheetController.exportMass
);

// POST /api/timesheet/export-assigned
router.post(
  '/export-assigned',
  requirePageAccess('/timesheet-hr', 'view'),
  timesheetController.exportAssigned
);

// GET /api/timesheet/assigned-employees
router.get(
  '/assigned-employees',
  requirePageAccess('/timesheet-hr', 'view'),
  timesheetController.listAssignedEmployees
);

// POST /api/timesheet/email-assigned
router.post(
  '/email-assigned',
  requirePageAccess('/timesheet-hr', 'view'),
  timesheetController.emailAssigned
);

// GET /api/timesheet/corrections
router.get(
  '/corrections',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr'], 'view'),
  timesheetController.listCorrections
);

// POST /api/timesheet/refresh
router.post(
  '/refresh',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr'], 'view'),
  timesheetController.refresh
);

// POST /api/timesheet
router.post(
  '/',
  requireAnyPageAccess(['/employee', '/timesheet', '/timesheet-hr'], 'edit'),
  timesheetController.create
);

// POST /api/timesheet/bulk
router.post(
  '/bulk',
  requireAnyPageAccess(['/employee', '/timesheet', '/timesheet-hr'], 'edit'),
  timesheetController.bulkSave
);

// PUT /api/timesheet/object-entry
router.put(
  '/object-entry',
  requireAnyPageAccess(['/employee', '/timesheet', '/timesheet-hr'], 'edit'),
  timesheetController.upsertObjectEntry
);

// DELETE /api/timesheet/object-entry
router.delete(
  '/object-entry',
  requireAnyPageAccess(['/employee', '/timesheet', '/timesheet-hr'], 'edit'),
  timesheetController.deleteObjectEntry
);

// PUT /api/timesheet/:id
router.put(
  '/:id',
  requireAnyPageAccess(['/employee', '/timesheet', '/timesheet-hr'], 'edit'),
  timesheetController.update
);

// DELETE /api/timesheet/:id
router.delete(
  '/:id',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr'], 'edit'),
  timesheetController.deleteEntry
);

export default router;
