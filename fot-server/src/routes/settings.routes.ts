import { Router } from 'express';
import { settingsController } from '../controllers/settings.controller.js';
import { authenticate, requirePageAccess } from '../middleware/auth.js';

const router = Router();

router.use(authenticate);

// GET /api/settings — все настройки
router.get('/', requirePageAccess('/admin/settings', 'view'), settingsController.getAll);

// GET /api/settings/r2/status — статус R2
router.get('/r2/status', requirePageAccess('/admin/settings', 'view'), settingsController.getR2Status);

// GET /api/settings/sigur-monitor — настройки мониторинга Sigur
router.get('/sigur-monitor', requirePageAccess('/admin/settings', 'view'), settingsController.getSigurMonitorSettings);

// GET /api/settings/timesheet-reminders — настройки напоминаний табеля
router.get('/timesheet-reminders', requirePageAccess('/admin/settings', 'view'), settingsController.getTimesheetReminderSettings);

// PUT /api/settings/r2 — сохранить R2 настройки
router.put('/r2', requirePageAccess('/admin/settings', 'edit'), settingsController.saveR2);

// PUT /api/settings/sigur-monitor — сохранить настройки мониторинга Sigur
router.put('/sigur-monitor', requirePageAccess('/admin/settings', 'edit'), settingsController.saveSigurMonitorSettings);

// PUT /api/settings/timesheet-reminders — сохранить настройки напоминаний табеля
router.put('/timesheet-reminders', requirePageAccess('/admin/settings', 'edit'), settingsController.saveTimesheetReminderSettings);

// POST /api/settings/r2/test — тест подключения R2
router.post('/r2/test', requirePageAccess('/admin/settings', 'edit'), settingsController.testR2);

export default router;
