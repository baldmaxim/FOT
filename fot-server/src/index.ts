import './instrument.js';
import * as Sentry from '@sentry/node';
import { createServer } from 'http';
import { Server } from 'socket.io';
import app from './app.js';
import { corsAllowedOrigins, env } from './config/env.js';
import { IS_PRODUCTION } from './config/features.js';
import { startPoolTelemetry, closeDb, getPoolStats } from './config/postgres.js';
import { getDbInflight } from './config/db-instrumentation.js';
import { getHttpInflight } from './middleware/httpInflight.js';
import { startPresencePolling, stopPresencePolling } from './services/presence-polling.service.js';
import { initializeSKUDDailySummaryOnStartup } from './services/skud-dashboard.service.js';
import { startSigurMonitor, stopSigurMonitor } from './services/sigur-monitor.service.js';
import { startStructureSyncScheduler, stopStructureSyncScheduler } from './services/sigur-structure-scheduler.service.js';
import { startSigurEventsDailyScheduler, stopSigurEventsDailyScheduler } from './services/sigur-events-daily-scheduler.service.js';
import { startSkudSummaryReconcileScheduler, stopSkudSummaryReconcileScheduler } from './services/skud-summary-reconcile.service.js';
import { startTimesheetReminderScheduler, stopTimesheetReminderScheduler } from './services/timesheet-reminder.service.js';
import { startPatentExpiryReminderScheduler, stopPatentExpiryReminderScheduler } from './services/patent-expiry-reminder.service.js';
import { startObjectKpiPlanFreezer, stopObjectKpiPlanFreezer } from './services/object-kpi-plan-freezer.service.js';
import { startDailyTasksReminderScheduler, stopDailyTasksReminderScheduler } from './services/daily-tasks-reminder.service.js';
import { startTimesheetVersionRebuildScheduler, stopTimesheetVersionRebuildScheduler } from './services/timesheet-version-rebuild.service.js';
import { startDismissalScheduler, stopDismissalScheduler } from './services/dismissal-scheduler.service.js';
import { startContractorPassSyncScheduler, stopContractorPassSyncScheduler } from './services/contractor-pass-sync.scheduler.js';
import { startNewdbPendingPoller, stopNewdbPendingPoller } from './services/newdb-pending-poller.service.js';
import { startMtsLocationPoller, stopMtsLocationPoller } from './services/mts-location-poller.service.js';
import { startMtsGeofenceMonitor, stopMtsGeofenceMonitor } from './services/mts-geofence-monitor.service.js';
import { startMtsBusinessStatusPoller, stopMtsBusinessStatusPoller } from './services/mts-business-status-poller.service.js';
import { startMtsBusinessMailIngest, stopMtsBusinessMailIngest } from './services/mts-business-mail-ingest.service.js';
import { startMtsBusinessCdrDailyScheduler, stopMtsBusinessCdrDailyScheduler } from './services/mts-business-cdr-daily-scheduler.service.js';
import { startMtsBusinessMetricsDailyScheduler, stopMtsBusinessMetricsDailyScheduler } from './services/mts-business-metrics-daily-scheduler.service.js';
import { startMtsBusinessRefreshAllDailyScheduler, stopMtsBusinessRefreshAllDailyScheduler } from './services/mts-business-refresh-all-daily-scheduler.service.js';
import { reconcileInterruptedRefreshAll } from './services/mts-business-refresh-all.service.js';
import { mtsBusinessSyncLogService } from './services/mts-business-sync-log.service.js';
import { startMtsBusinessStatementRollingWorker, stopMtsBusinessStatementRollingWorker } from './services/mts-business-statement-rolling.service.js';
import { aiReceiptRecognitionService } from './services/ai-receipt-recognition.service.js';
import { adaptiveTestingService } from './services/adaptive-testing.service.js';
import { startHrOcrWorker, stopHrOcrWorker } from './services/hr-ocr/worker.js';
import { startHrMaintenance, stopHrMaintenance } from './services/hr-maintenance.service.js';
import { prewarmSigurPresenceResolver } from './services/sigur-presence-resolver.service.js';
import { getPresenceByObject } from './services/skud-presence-by-object.service.js';
import { sigurService } from './services/sigur.service.js';
import { setupChatSocket } from './socket/chatHandler.js';
import { setIo } from './socket/io-instance.js';

const PORT = parseInt(env.PORT, 10);
const HOST = env.HOST;
const STARTUP_CACHE_WARMUP_DELAY_MS = 120_000;

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

// Телеметрия памяти: 1 строка/мин. Помогает отличить рестарт по memory
// threshold PM2 (max_memory_restart — PM2 шлёт SIGINT, в логе приложения это
// неотличимо от ручного `pm2 restart`) от внешней команды рестарта: сам по себе
// высокий RSS причину не доказывает, а низкий не исключает предыдущий пик.
// Порог предупреждения — от PM2_MAX_MEMORY_MB (см. ecosystem.config.cjs).
const MB = 1024 * 1024;
const pm2MaxMemoryMb = Number.parseInt(process.env.PM2_MAX_MEMORY_MB ?? '', 10);
const memoryWarnMb = Number.isFinite(pm2MaxMemoryMb) && pm2MaxMemoryMb > 0
  ? Math.round(pm2MaxMemoryMb * 0.7)
  : null;

// Что держит процесс: сокеты, HTTP-запросы, запросы к БД, состояние пула.
// getPoolStats() пул не создаёт — это важно во время shutdown, где closeDb()
// уже обнулил singleton (getPool() поднял бы новый Pool на закрытии).
const drainSnapshot = (): string => {
  const pool = getPoolStats();
  const poolPart = pool
    ? `pool=${pool.total}/${pool.max} idle=${pool.idle} waiting=${pool.waiting}`
    : 'pool=closed';
  return `sockets=${io.engine.clientsCount} http=${getHttpInflight()} db=${getDbInflight()} ${poolPart}`;
};

setInterval(() => {
  const m = process.memoryUsage();
  const rssMb = Math.round(m.rss / MB);
  const line = `[mem] rss=${rssMb}M heapUsed=${Math.round(m.heapUsed / MB)}M `
    + `heapTotal=${Math.round(m.heapTotal / MB)}M external=${Math.round(m.external / MB)}M `
    + `arrayBuffers=${Math.round(m.arrayBuffers / MB)}M uptime=${Math.round(process.uptime())}s `
    + drainSnapshot();
  if (memoryWarnMb !== null && rssMb >= memoryWarnMb) {
    console.warn(`${line} — RSS ≥ 70% лимита PM2 (${pm2MaxMemoryMb}M, memory threshold)`);
  } else {
    console.log(line);
  }
}, 60_000).unref();

httpServer.listen(PORT, HOST, () => {
  console.log(`FOT Server running on ${HOST}:${PORT}`);
  console.log(`Environment: ${env.NODE_ENV} (IS_PRODUCTION=${IS_PRODUCTION})`);
  console.log(`CORS Origin: ${corsAllowedOrigins.join(', ')}`);
  // Сигнал PM2 (wait_ready): апстрим начал слушать порт — можно слать трафик.
  // Вне PM2 process.send undefined → no-op.
  process.send?.('ready');
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
  // Прогрев тяжёлых кэшей откладываем: сразу после deploy/restart браузеры
  // массово переподключаются, и холодный полный обход Sigur конкурировал с ними.
  const warmupTimer = setTimeout(() => {
    console.log(`[startup] warming Sigur presence caches after ${Math.round(STARTUP_CACHE_WARMUP_DELAY_MS / 1000)}s`);
    prewarmSigurPresenceResolver();
    void getPresenceByObject({ allowedObjectIds: 'all' }).catch(() => { /* noop */ });
  }, STARTUP_CACHE_WARMUP_DELAY_MS);
  warmupTimer.unref();
  startTimesheetReminderScheduler();
  startPatentExpiryReminderScheduler();
  startDailyTasksReminderScheduler();
  // Пересборка версий табеля после правок админа в обход штатного close (миграция 257):
  // без неё такая правка не дошла бы до 1С.
  startTimesheetVersionRebuildScheduler();
  startDismissalScheduler();
  startContractorPassSyncScheduler();
  // Фиксация месячного плана KPI объектов. Сам по себе не работает: включается
  // в настройках (system_settings.object_kpi_freezer_enabled, по умолчанию false).
  startObjectKpiPlanFreezer();
  startNewdbPendingPoller();
  startMtsLocationPoller();
  startMtsGeofenceMonitor();
  startMtsBusinessStatusPoller();
  startMtsBusinessMailIngest();
  void startMtsBusinessCdrDailyScheduler();
  void startMtsBusinessMetricsDailyScheduler();
  void startMtsBusinessRefreshAllDailyScheduler();
  // Непрерывный конвейер свежести выписки. Сам по себе не работает: включается
  // в админке (system_settings.mts_business_rolling_enabled, по умолчанию false).
  startMtsBusinessStatementRollingWorker();
  // Прогон «Обновить всё», убитый рестартом/деплоем, сразу помечаем прерванным —
  // иначе кнопка блокируется до истечения lease (до 10 минут).
  void reconcileInterruptedRefreshAll();
  // Зависшие «running»-прогоны в «Логе синхронизации» (>2 ч) → interrupted.
  void mtsBusinessSyncLogService.reconcileInterruptedRuns();
  void aiReceiptRecognitionService.resumePendingRecognitions().then(count => {
    if (count > 0) console.log(`[ai-receipt-recognition] возобновлено задач: ${count}`);
  });
  // Адаптивное тестирование: подхват pending-работы и просроченных lease
  // (живые lease не трогаем — rolling deploy), затем периодический sweeper.
  void adaptiveTestingService.resumePendingAdaptiveTests();
  adaptiveTestingService.startSweeper();
  // Кадровый модуль: DB-очередь распознавания сканов и чистка просроченных черновиков.
  // Оба молчат, если ключи HR-шифрования не заданы (модуль выключен).
  startHrOcrWorker();
  startHrMaintenance();
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
  // Замеряем фазы дренирования: пока не известно, сколько реально занимает
  // закрытие сокетов и пула, трогать kill_timeout/форс-таймаут вслепую нельзя.
  const shutdownStartedAt = Date.now();
  const elapsed = (): string => `${Date.now() - shutdownStartedAt}ms`;
  const rssMb = Math.round(process.memoryUsage().rss / MB);
  console.log(`[shutdown] получен ${signal} — graceful shutdown rss=${rssMb}M ${drainSnapshot()}`);

  // Посекундный тик, пока идёт дренирование: показывает, какая фаза упирается —
  // сокеты, незавершённые HTTP-запросы или закрытие пула. Не больше ~10 строк
  // (дальше форс-выход), поэтому лог не флудится.
  const drainTicker = setInterval(() => {
    console.log(`[shutdown] дренирование ${elapsed()} ${drainSnapshot()}`);
  }, 1000);
  drainTicker.unref();

  const stoppers = [
    stopPresencePolling, stopSigurMonitor, stopStructureSyncScheduler,
    stopSigurEventsDailyScheduler, stopSkudSummaryReconcileScheduler,
    stopTimesheetReminderScheduler, stopPatentExpiryReminderScheduler,
    stopDailyTasksReminderScheduler, stopTimesheetVersionRebuildScheduler,
    stopDismissalScheduler,
    stopContractorPassSyncScheduler, stopObjectKpiPlanFreezer,
    stopNewdbPendingPoller, stopMtsLocationPoller, stopMtsGeofenceMonitor,
    stopMtsBusinessStatusPoller, stopMtsBusinessMailIngest, stopMtsBusinessCdrDailyScheduler,
    stopMtsBusinessMetricsDailyScheduler, stopMtsBusinessRefreshAllDailyScheduler,
    stopMtsBusinessStatementRollingWorker,
    stopHrOcrWorker, stopHrMaintenance,
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
    console.log(`[shutdown] Socket.IO/HTTP закрыты за ${elapsed()}`);
    void closeDb()
      .then(() => console.log(`[shutdown] пул БД закрыт, суммарно ${elapsed()}`))
      .catch(err => console.error('[shutdown] ошибка закрытия пула:', err))
      .finally(() => {
        clearInterval(drainTicker);
        console.log(`[shutdown] выход, всего ${elapsed()}`);
        process.exit(0);
      });
  });

  // Страховка: если дренирование зависло — форс-выход.
  setTimeout(() => {
    clearInterval(drainTicker);
    console.error(`[shutdown] таймаут дренирования (10с) — форс-выход, ${drainSnapshot()}`);
    process.exit(1);
  }, 10_000).unref();
};
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
