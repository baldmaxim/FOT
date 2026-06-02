import { Router, type Response } from 'express';
import { query as dbQuery } from '../config/postgres.js';
import { timesheetController } from '../controllers/timesheet.controller.js';
import { timesheetTeamManagementController as tm } from '../controllers/timesheet-team-management.controller.js';
import { exportTimesheetObjectsUnified } from '../controllers/timesheet-mass-export.controller.js';
import { authenticate, requireAdmin, requireAnyPageAccess, requirePageAccess } from '../middleware/auth.js';
import { registerCache, invalidateCaches } from '../middleware/cacheResponse.js';
import { cacheWithShortTtlForToday } from '../middleware/skipCacheForToday.js';
import { serverTiming } from '../middleware/serverTiming.js';
import type { AuthenticatedRequest } from '../types/index.js';
import correctionAttachmentsRouter from './correction-attachments.routes.js';

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

// GET /api/timesheet/employees/:employeeId/objects — объекты сотрудника для привязки корректировки
router.get(
  '/employees/:employeeId/objects',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr', 'timesheet-team-management'], 'edit'),
  timesheetController.listEmployeeObjects
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

// POST /api/timesheet/export-mass-unified — единый Excel-файл для 1С по выбранным отделам.
router.post(
  '/export-mass-unified',
  requirePageAccess('/timesheet-hr', 'view'),
  timesheetController.exportMassUnified
);

// GET /api/timesheet/objects — список объектов для выгрузки табелей
router.get(
  '/objects',
  requirePageAccess('/timesheet-hr', 'view'),
  async (_req: AuthenticatedRequest, res: Response) => {
    try {
      const rows = await dbQuery<{ id: string; name: string; alt_name: string | null }>(
        `SELECT id, name, alt_name FROM skud_objects WHERE is_active = true
          ORDER BY COALESCE(NULLIF(btrim(alt_name), ''), name), name`,
      );
      res.json({ success: true, data: rows });
    } catch (error) {
      console.error('List timesheet objects error:', error);
      res.status(500).json({ success: false, error: 'Не удалось загрузить объекты' });
    }
  }
);

// POST /api/timesheet/export-objects-unified — единый файл для 1С по выбранным объектам.
router.post(
  '/export-objects-unified',
  requirePageAccess('/timesheet-hr', 'view'),
  exportTimesheetObjectsUnified
);

// POST /api/timesheet/export-assigned
router.post(
  '/export-assigned',
  requirePageAccess('/timesheet-hr', 'view'),
  timesheetController.exportAssigned
);

// GET /api/timesheet/assigned-employees
// Список начальников участка для assigned-режима. Доступен и табельщице (/timesheet):
// collectAssignedEmployees ограничивает выборку её accessible-бригадами (объекты ∩ папки).
router.get(
  '/assigned-employees',
  requireAnyPageAccess(['/timesheet-hr', '/timesheet'], 'view'),
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

// /api/timesheet/corrections/:id/attachments
router.use('/corrections', correctionAttachmentsRouter);

// POST /api/timesheet/refresh
router.post(
  '/refresh',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr'], 'view'),
  timesheetController.refresh
);

// GET /api/timesheet/correction-eligibility?employee_ids=...&start=...&end=...
// Доступность корректировок для ролей с включёнными «Ограничениями корректировок»
// (см. миграцию 132, сервис correction-restrictions.service).
router.get(
  '/correction-eligibility',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr'], 'edit'),
  timesheetController.getCorrectionEligibility
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
