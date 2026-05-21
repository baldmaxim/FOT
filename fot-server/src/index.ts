import './instrument.js';
import * as Sentry from '@sentry/node';
import { createServer } from 'http';
import { Server } from 'socket.io';
import app from './app.js';
import { corsAllowedOrigins, env } from './config/env.js';
import { IS_PRODUCTION } from './config/features.js';
import { startPresencePolling } from './services/presence-polling.service.js';
import { startSigurMonitor } from './services/sigur-monitor.service.js';
import { startStructureSyncScheduler } from './services/sigur-structure-scheduler.service.js';
import { startSigurEventsDailyScheduler } from './services/sigur-events-daily-scheduler.service.js';
import { startSkudSummaryReconcileScheduler } from './services/skud-summary-reconcile.service.js';
import { startTimesheetReminderScheduler } from './services/timesheet-reminder.service.js';
import { startPatentExpiryReminderScheduler } from './services/patent-expiry-reminder.service.js';
import { startDailyTasksReminderScheduler } from './services/daily-tasks-reminder.service.js';
import { startDismissalScheduler } from './services/dismissal-scheduler.service.js';
import { startMtsLocationPoller } from './services/mts-location-poller.service.js';
import { startMtsGeofenceMonitor } from './services/mts-geofence-monitor.service.js';
import { aiReceiptRecognitionService } from './services/ai-receipt-recognition.service.js';
import { prewarmSigurPresenceResolver } from './services/sigur-presence-resolver.service.js';
import { getPresenceByObject } from './services/skud-presence-by-object.service.js';
import { sigurService } from './services/sigur.service.js';
import { setupChatSocket } from './socket/chatHandler.js';
import { setIo } from './socket/io-instance.js';

const PORT = parseInt(env.PORT, 10);
const HOST = env.HOST;

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: corsAllowedOrigins,
    credentials: true,
  },
});

setIo(io);
setupChatSocket(io);

httpServer.listen(PORT, HOST, () => {
  console.log(`FOT Server running on ${HOST}:${PORT}`);
  console.log(`Environment: ${env.NODE_ENV} (IS_PRODUCTION=${IS_PRODUCTION})`);
  console.log(`CORS Origin: ${corsAllowedOrigins.join(', ')}`);
  console.log('Socket.IO enabled');
  if (!IS_PRODUCTION && env.NODE_ENV !== 'test') {
    console.warn('[WARN] IS_PRODUCTION=false — rate limits отключены через skipInDev. Если это прод, проверьте NODE_ENV в PM2 ecosystem.');
  }
  void sigurService.loadEventTypes().catch(err => {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[sigur] не удалось загрузить справочник типов при старте: ${message} — использую fallback`);
    Sentry.captureException(err);
  });
  void startPresencePolling();
  void startSigurMonitor();
  void startStructureSyncScheduler();
  void startSigurEventsDailyScheduler();
  startSkudSummaryReconcileScheduler();
  // Прогрев тяжёлых кэшей, чтобы первое открытие «Сотрудники на объектах»
  // не ждало холодного ре-фетча справочника Sigur и полного пересчёта.
  prewarmSigurPresenceResolver();
  void getPresenceByObject({ allowedObjectIds: 'all' }).catch(() => { /* noop */ });
  startTimesheetReminderScheduler();
  startPatentExpiryReminderScheduler();
  startDailyTasksReminderScheduler();
  startDismissalScheduler();
  startMtsLocationPoller();
  startMtsGeofenceMonitor();
  void aiReceiptRecognitionService.resumePendingRecognitions().then(count => {
    if (count > 0) console.log(`[ai-receipt-recognition] возобновлено задач: ${count}`);
  });
});

// Глобальные ловушки — без них необработанные rejection/exception теряются.
// Не выходим из процесса: PM2 решит, перезапускать ли.
process.on('unhandledRejection', (reason) => {
  Sentry.captureException(reason);
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  Sentry.captureException(err);
  console.error('[uncaughtException]', err);
});
