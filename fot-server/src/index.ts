import './instrument.js';
import * as Sentry from '@sentry/node';
import { createServer } from 'http';
import { Server } from 'socket.io';
import app from './app.js';
import { corsAllowedOrigins, env } from './config/env.js';
import { IS_PRODUCTION } from './config/features.js';
import { startPoolTelemetry, closeDb } from './config/postgres.js';
import { startPresencePolling, stopPresencePolling } from './services/presence-polling.service.js';
import { initializeSKUDDailySummaryOnStartup } from './services/skud-dashboard.service.js';
import { startSigurMonitor, stopSigurMonitor } from './services/sigur-monitor.service.js';
import { startStructureSyncScheduler, stopStructureSyncScheduler } from './services/sigur-structure-scheduler.service.js';
import { startSigurEventsDailyScheduler, stopSigurEventsDailyScheduler } from './services/sigur-events-daily-scheduler.service.js';
import { startSkudSummaryReconcileScheduler, stopSkudSummaryReconcileScheduler } from './services/skud-summary-reconcile.service.js';
import { startTimesheetReminderScheduler, stopTimesheetReminderScheduler } from './services/timesheet-reminder.service.js';
import { startPatentExpiryReminderScheduler, stopPatentExpiryReminderScheduler } from './services/patent-expiry-reminder.service.js';
import { startDailyTasksReminderScheduler, stopDailyTasksReminderScheduler } from './services/daily-tasks-reminder.service.js';
import { startDismissalScheduler, stopDismissalScheduler } from './services/dismissal-scheduler.service.js';
import { startContractorPassSyncScheduler, stopContractorPassSyncScheduler } from './services/contractor-pass-sync.scheduler.js';
import { startMtsLocationPoller, stopMtsLocationPoller } from './services/mts-location-poller.service.js';
import { startMtsGeofenceMonitor, stopMtsGeofenceMonitor } from './services/mts-geofence-monitor.service.js';
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
  // websocket первым (nginx проксирует Upgrade), polling — fallback.
  transports: ['websocket', 'polling'],
});

setIo(io);
setupChatSocket(io);

// Телеметрия транспорта Socket.IO: доля websocket vs long-polling и число
// апгрейдов за минуту (см. roadmap-1500 — решение о websocket-first).
// Агрегируем и пишем 1 строку/мин, чтобы не флудить лог на 1500 коннектах.
let sioWs = 0;
let sioPolling = 0;
let sioUpgrades = 0;
io.on('connection', (socket) => {
  if (socket.conn.transport.name === 'websocket') sioWs += 1;
  else sioPolling += 1;
  socket.conn.once('upgrade', () => { sioUpgrades += 1; });
});
setInterval(() => {
  if (sioWs + sioPolling + sioUpgrades === 0) return;
  console.log(`[socket.io] connects/min ws=${sioWs} polling=${sioPolling} upgraded=${sioUpgrades} live=${io.engine.clientsCount}`);
  sioWs = 0;
  sioPolling = 0;
  sioUpgrades = 0;
}, 60_000).unref();

httpServer.listen(PORT, HOST, () => {
  console.log(`FOT Server running on ${HOST}:${PORT}`);
  console.log(`Environment: ${env.NODE_ENV} (IS_PRODUCTION=${IS_PRODUCTION})`);
  console.log(`CORS Origin: ${corsAllowedOrigins.join(', ')}`);
  console.log('Socket.IO enabled');
  startPoolTelemetry();
  if (!IS_PRODUCTION && env.NODE_ENV !== 'test') {
    console.warn('[WARN] IS_PRODUCTION=false — rate limits отключены через skipInDev. Если это прод, проверьте NODE_ENV в PM2 ecosystem.');
  }
  void sigurService.loadEventTypes().catch(err => {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[sigur] не удалось загрузить справочник типов при старте: ${message} — использую fallback`);
    Sentry.captureException(err);
  });
  void initializeSKUDDailySummaryOnStartup().then(() => {
    void startPresencePolling();
  });
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
  startContractorPassSyncScheduler();
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

// Graceful shutdown: гасим фоновые таймеры, закрываем Socket.IO/HTTP (с
// дренированием текущих запросов) и пул БД. Без этого pm2 restart жёстко рвёт
// сокеты и держит presence-lease до TTL — на 1500 юзерах это бьёт по многим.
let shuttingDown = false;
const gracefulShutdown = (signal: string): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] получен ${signal} — graceful shutdown`);

  const stoppers = [
    stopPresencePolling, stopSigurMonitor, stopStructureSyncScheduler,
    stopSigurEventsDailyScheduler, stopSkudSummaryReconcileScheduler,
    stopTimesheetReminderScheduler, stopPatentExpiryReminderScheduler,
    stopDailyTasksReminderScheduler, stopDismissalScheduler,
    stopContractorPassSyncScheduler, stopMtsLocationPoller, stopMtsGeofenceMonitor,
  ];
  for (const stop of stoppers) {
    try {
      stop();
    } catch (err) {
      console.error('[shutdown] ошибка остановки сервиса:', err);
    }
  }

  // io.close() отключает сокеты и закрывает привязанный HTTP-сервер: перестаёт
  // принимать новые соединения и дожидается завершения текущих запросов.
  io.close(() => {
    console.log('[shutdown] Socket.IO/HTTP закрыты');
    void closeDb()
      .then(() => console.log('[shutdown] пул БД закрыт'))
      .catch(err => console.error('[shutdown] ошибка закрытия пула:', err))
      .finally(() => process.exit(0));
  });

  // Страховка: если дренирование зависло — форс-выход.
  setTimeout(() => {
    console.error('[shutdown] таймаут дренирования (10с) — форс-выход');
    process.exit(1);
  }, 10_000).unref();
};
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
