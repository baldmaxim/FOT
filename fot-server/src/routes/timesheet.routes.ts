import { Router } from 'express';
import { timesheetController } from '../controllers/timesheet.controller.js';
import { authenticate, requireAdmin, requireAnyPageAccess, requirePageAccess } from '../middleware/auth.js';
import { registerCache, invalidateCaches } from '../middleware/cacheResponse.js';
import { cacheUnlessRangeIncludesToday } from '../middleware/skipCacheForToday.js';

const router = Router();

router.use(authenticate);

// Write-through invalidation: любой успешный POST/PUT/PATCH/DELETE на /api/timesheet/*
// сбрасывает серверные LRU-кэши табеля, чтобы корректировки появлялись сразу.
router.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        invalidateCaches('timesheet', 'timesheet:overview', 'timesheet:search');
      }
    });
  }
  next();
});

// req.user.show_actual_hours включён в ключ: переключение per-role флага меняет
// effectiveDisplayMode в timesheet.controller, поэтому два режима должны храниться
// в разных bucket'ах, иначе после refreshProfile старый ответ переживает TTL.
const timesheetCache = registerCache(
  'timesheet',
  (req) =>
    [
      'ts',
      req.query.month ?? '',
      req.query.department_id ?? 'all',
      req.query.employee_id ?? '',
      req.query.from ?? '',
      req.query.to ?? '',
      req.query.half ?? '',
      req.user.id,
      req.user.show_actual_hours ? '1' : '0',
    ].join(':'),
  5 * 60_000,
  500,
);

const timesheetOverviewCache = registerCache(
  'timesheet:overview',
  (req) =>
    [
      'tso',
      req.query.month ?? '',
      req.query.department_id ?? 'all',
      req.query.from ?? '',
      req.query.to ?? '',
      req.query.half ?? '',
      req.user.id,
      req.user.show_actual_hours ? '1' : '0',
    ].join(':'),
  5 * 60_000,
);

const timesheetSearchCache = registerCache(
  'timesheet:search',
  (req) =>
    `tss:${req.query.q ?? ''}:${req.query.department_id ?? 'all'}:${req.user.id}`,
  2 * 60_000,
);

// GET /api/timesheet?month=YYYY-MM&department_id=...
router.get(
  '/overview',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr'], 'view'),
  cacheUnlessRangeIncludesToday(timesheetOverviewCache),
  timesheetController.getOverview
);

router.get(
  '/',
  requireAnyPageAccess(['/employee', '/timesheet', '/timesheet-hr'], 'view'),
  cacheUnlessRangeIncludesToday(timesheetCache),
  timesheetController.getAll
);

router.get(
  '/team-management-config',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr', 'timesheet-team-management'], 'view'),
  timesheetController.getTeamManagementConfig
);

router.get(
  '/team-management/search-employees',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr', 'timesheet-team-management'], 'edit'),
  timesheetSearchCache,
  timesheetController.searchTeamEmployees
);

router.post(
  '/team-management/add-employee',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr', 'timesheet-team-management'], 'edit'),
  timesheetController.addEmployeeToDepartment
);

router.post(
  '/team-management/exclude-employee',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr', 'timesheet-team-management'], 'edit'),
  timesheetController.excludeEmployeeFromDepartment
);

router.get(
  '/admin/transfers',
  requireAdmin,
  timesheetController.listAdminTransfers
);

router.get(
  '/team-management/transfers',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr'], 'edit'),
  timesheetController.listTransfers
);

router.patch(
  '/team-management/transfers/:assignmentId',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr'], 'edit'),
  timesheetController.patchTransfer
);

router.delete(
  '/team-management/transfers/:assignmentId',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr'], 'edit'),
  timesheetController.deleteTransferEntry
);

router.patch(
  '/team-management/exclusions/:employeeId',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr'], 'edit'),
  timesheetController.patchExclusion
);

router.delete(
  '/team-management/exclusions/:employeeId',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr'], 'edit'),
  timesheetController.deleteExclusionEntry
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
  requireAnyPageAccess(['/employee/requests', '/timesheet', '/timesheet-hr'], 'edit'),
  timesheetController.create
);

// POST /api/timesheet/bulk
router.post(
  '/bulk',
  requireAnyPageAccess(['/employee/requests', '/timesheet', '/timesheet-hr'], 'edit'),
  timesheetController.bulkSave
);

// PUT /api/timesheet/object-entry
router.put(
  '/object-entry',
  requireAnyPageAccess(['/employee/requests', '/timesheet', '/timesheet-hr'], 'edit'),
  timesheetController.upsertObjectEntry
);

// DELETE /api/timesheet/object-entry
router.delete(
  '/object-entry',
  requireAnyPageAccess(['/employee/requests', '/timesheet', '/timesheet-hr'], 'edit'),
  timesheetController.deleteObjectEntry
);

// PUT /api/timesheet/:id
router.put(
  '/:id',
  requireAnyPageAccess(['/employee/requests', '/timesheet', '/timesheet-hr'], 'edit'),
  timesheetController.update
);

// DELETE /api/timesheet/:id
router.delete(
  '/:id',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr'], 'edit'),
  timesheetController.deleteEntry
);

export default router;
