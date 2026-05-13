import { Router } from 'express';
import { timesheetController } from '../controllers/timesheet.controller.js';
import { timesheetTeamManagementController as tm } from '../controllers/timesheet-team-management.controller.js';
import { authenticate, requireAdmin, requireAnyPageAccess, requirePageAccess } from '../middleware/auth.js';
import { registerCache, invalidateCaches } from '../middleware/cacheResponse.js';
import { cacheWithShortTtlForToday } from '../middleware/skipCacheForToday.js';
import { serverTiming } from '../middleware/serverTiming.js';

const router = Router();

router.use(authenticate);

// Write-through invalidation: любой успешный POST/PUT/PATCH/DELETE на /api/timesheet/*
// сбрасывает серверные LRU-кэши табеля, чтобы корректировки появлялись сразу.
router.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        invalidateCaches('timesheet', 'timesheet:today', 'timesheet:overview', 'timesheet:overview:today', 'timesheet:search');
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
      req.query.include_objects ?? '',
      req.query.schedule_payload ?? '',
      req.user.id,
      req.user.show_actual_hours ? '1' : '0',
    ].join(':'),
  5 * 60_000,
  500,
);

const timesheetTodayCache = registerCache(
  'timesheet:today',
  (req) =>
    [
      'ts-today',
      req.query.month ?? '',
      req.query.department_id ?? 'all',
      req.query.employee_id ?? '',
      req.query.from ?? '',
      req.query.to ?? '',
      req.query.half ?? '',
      req.query.include_objects ?? '',
      req.query.schedule_payload ?? '',
      req.user.id,
      req.user.show_actual_hours ? '1' : '0',
    ].join(':'),
  8_000,
  300,
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

const timesheetOverviewTodayCache = registerCache(
  'timesheet:overview:today',
  (req) =>
    [
      'tso-today',
      req.query.month ?? '',
      req.query.department_id ?? 'all',
      req.query.from ?? '',
      req.query.to ?? '',
      req.query.half ?? '',
      req.user.id,
      req.user.show_actual_hours ? '1' : '0',
    ].join(':'),
  8_000,
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
  serverTiming('timesheet_overview'),
  cacheWithShortTtlForToday(timesheetOverviewCache, timesheetOverviewTodayCache),
  timesheetController.getOverview
);

router.get(
  '/',
  requireAnyPageAccess(['/employee', '/timesheet', '/timesheet-hr'], 'view'),
  serverTiming('timesheet'),
  cacheWithShortTtlForToday(timesheetCache, timesheetTodayCache),
  timesheetController.getAll
);

router.get(
  '/team-management-config',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr', 'timesheet-team-management'], 'view'),
  tm.getTeamManagementConfig
);

router.get(
  '/team-management/search-employees',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr', 'timesheet-team-management'], 'edit'),
  timesheetSearchCache,
  tm.searchTeamEmployees
);

router.post(
  '/team-management/add-employee',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr', 'timesheet-team-management'], 'edit'),
  tm.addEmployeeToDepartment
);

router.post(
  '/team-management/exclude-employee',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr', 'timesheet-team-management'], 'edit'),
  tm.excludeEmployeeFromDepartment
);

router.get(
  '/admin/transfers',
  requireAdmin,
  tm.listAdminTransfers
);

router.get(
  '/team-management/transfers',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr'], 'edit'),
  tm.listTransfers
);

router.patch(
  '/team-management/transfers/:assignmentId',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr'], 'edit'),
  tm.patchTransfer
);

router.delete(
  '/team-management/transfers/:assignmentId',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr'], 'edit'),
  tm.deleteTransferEntry
);

router.patch(
  '/team-management/exclusions/:employeeId',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr'], 'edit'),
  tm.patchExclusion
);

router.delete(
  '/team-management/exclusions/:employeeId',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr'], 'edit'),
  tm.deleteExclusionEntry
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

// GET /api/timesheet/weekend-memo/preview — превью списка сотрудников/дат для служебки
router.get(
  '/weekend-memo/preview',
  requirePageAccess('/timesheet', 'view'),
  timesheetController.getWeekendMemoPreview
);

// POST /api/timesheet/weekend-memo/generate — служебная записка о работе в выходные (manager_obj)
router.post(
  '/weekend-memo/generate',
  requirePageAccess('/timesheet', 'edit'),
  timesheetController.generateWeekendMemo
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
