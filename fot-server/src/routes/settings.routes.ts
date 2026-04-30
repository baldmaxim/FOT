import { Router } from 'express';
import { settingsController } from '../controllers/settings.controller.js';
import { authenticate, requirePageAccess } from '../middleware/auth.js';
import { registerCache, invalidateCaches } from '../middleware/cacheResponse.js';

const router = Router();

router.use(authenticate);

const settingsAllCache = registerCache('settings:all', () => 'settings:all', 15 * 60_000);
const sigurMonitorCache = registerCache('settings:sigur-monitor', () => 'settings:sigur-monitor', 15 * 60_000);
const tsRemindersCache = registerCache('settings:ts-reminders', () => 'settings:ts-reminders', 15 * 60_000);
const tsTeamMgmtCache = registerCache('settings:ts-team-mgmt', () => 'settings:ts-team-mgmt', 15 * 60_000);
const openRouterCache = registerCache('settings:openrouter', () => 'settings:openrouter', 15 * 60_000);

// Write-through invalidation: после любого PUT/POST сбрасываем все settings-кэши.
router.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        invalidateCaches(
          'settings:all',
          'settings:sigur-monitor',
          'settings:ts-reminders',
          'settings:ts-team-mgmt',
          'settings:openrouter',
        );
      }
    });
  }
  next();
});

// GET /api/settings — все настройки
router.get('/', requirePageAccess('/admin/settings', 'view'), settingsAllCache, settingsController.getAll);

// GET /api/settings/r2/status — статус R2 (не кэшируем: проверка соединения)
router.get('/r2/status', requirePageAccess('/admin/settings', 'view'), settingsController.getR2Status);

// GET /api/settings/sigur-monitor — настройки мониторинга Sigur
router.get('/sigur-monitor', requirePageAccess('/admin/settings', 'view'), sigurMonitorCache, settingsController.getSigurMonitorSettings);

// GET /api/settings/timesheet-reminders — настройки напоминаний табеля
router.get('/timesheet-reminders', requirePageAccess('/admin/settings', 'view'), tsRemindersCache, settingsController.getTimesheetReminderSettings);
// GET /api/settings/timesheet-team-management — настройки управления составом табеля
router.get('/timesheet-team-management', requirePageAccess('/admin/settings', 'view'), tsTeamMgmtCache, settingsController.getTimesheetTeamManagementSettings);

// PUT /api/settings/r2 — сохранить R2 настройки
router.put('/r2', requirePageAccess('/admin/settings', 'edit'), settingsController.saveR2);

// PUT /api/settings/sigur-monitor — сохранить настройки мониторинга Sigur
router.put('/sigur-monitor', requirePageAccess('/admin/settings', 'edit'), settingsController.saveSigurMonitorSettings);

// PUT /api/settings/timesheet-reminders — сохранить настройки напоминаний табеля
router.put('/timesheet-reminders', requirePageAccess('/admin/settings', 'edit'), settingsController.saveTimesheetReminderSettings);
// PUT /api/settings/timesheet-team-management — сохранить настройки управления составом табеля
router.put('/timesheet-team-management', requirePageAccess('/admin/settings', 'edit'), settingsController.saveTimesheetTeamManagementSettings);

// POST /api/settings/r2/test — тест подключения R2
router.post('/r2/test', requirePageAccess('/admin/settings', 'edit'), settingsController.testR2);

// GET /api/settings/openrouter — настройки распознавания чеков
router.get('/openrouter', requirePageAccess('/admin/settings', 'view'), openRouterCache, settingsController.getOpenRouterSettings);

// PUT /api/settings/openrouter — сохранить настройки OpenRouter
router.put('/openrouter', requirePageAccess('/admin/settings', 'edit'), settingsController.saveOpenRouterSettings);

// POST /api/settings/openrouter/test — тест подключения OpenRouter
router.post('/openrouter/test', requirePageAccess('/admin/settings', 'edit'), settingsController.testOpenRouter);

export default router;
