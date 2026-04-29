import './instrument.js';
import * as Sentry from '@sentry/node';
import { createServer } from 'http';
import { Server } from 'socket.io';
import app from './app.js';
import { corsAllowedOrigins, env } from './config/env.js';
import { startPresencePolling } from './services/presence-polling.service.js';
import { startSigurMonitor } from './services/sigur-monitor.service.js';
import { startStructureSyncScheduler } from './services/sigur-structure-scheduler.service.js';
import { startSigurEventsDailyScheduler } from './services/sigur-events-daily-scheduler.service.js';
import { startTimesheetReminderScheduler } from './services/timesheet-reminder.service.js';
import { startPatentExpiryReminderScheduler } from './services/patent-expiry-reminder.service.js';
import { aiReceiptRecognitionService } from './services/ai-receipt-recognition.service.js';
import { setupChatSocket } from './socket/chatHandler.js';
import { setIo } from './socket/io-instance.js';

const PORT = parseInt(env.PORT, 10);

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: corsAllowedOrigins,
    credentials: true,
  },
});

setIo(io);
setupChatSocket(io);

httpServer.listen(PORT, () => {
  console.log(`FOT Server running on port ${PORT}`);
  console.log(`Environment: ${env.NODE_ENV}`);
  console.log(`CORS Origin: ${corsAllowedOrigins.join(', ')}`);
  console.log('Socket.IO enabled');
  void startPresencePolling();
  void startSigurMonitor();
  void startStructureSyncScheduler();
  void startSigurEventsDailyScheduler();
  startTimesheetReminderScheduler();
  startPatentExpiryReminderScheduler();
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
