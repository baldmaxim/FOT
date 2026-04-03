import { createServer } from 'http';
import { Server } from 'socket.io';
import app from './app.js';
import { env } from './config/env.js';
import { startPresencePolling } from './services/presence-polling.service.js';
import { startStructureSyncScheduler } from './services/sigur-structure-scheduler.service.js';
import { setupChatSocket } from './socket/chatHandler.js';
import { setIo } from './socket/io-instance.js';

const PORT = parseInt(env.PORT, 10);

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: env.CORS_ORIGIN,
    credentials: true,
  },
});

setIo(io);
setupChatSocket(io);

httpServer.listen(PORT, () => {
  console.log(`FOT Server running on port ${PORT}`);
  console.log(`Environment: ${env.NODE_ENV}`);
  console.log(`CORS Origin: ${env.CORS_ORIGIN}`);
  console.log('Socket.IO enabled');
  startPresencePolling();
  startStructureSyncScheduler();
});
