import { createServer } from 'http';
import { Server } from 'socket.io';
import app from './app.js';
import { env } from './config/env.js';
// import { startPresencePolling } from './services/presence-polling.service.js';
import { setupChatSocket } from './socket/chatHandler.js';

const PORT = parseInt(env.PORT);

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: env.CORS_ORIGIN,
    credentials: true,
  },
});

setupChatSocket(io);

httpServer.listen(PORT, () => {
  console.log(`🚀 FOT Server running on port ${PORT}`);
  console.log(`📍 Environment: ${env.NODE_ENV}`);
  console.log(`🔒 CORS Origin: ${env.CORS_ORIGIN}`);
  console.log(`💬 Socket.IO enabled`);
  // startPresencePolling(); // временно отключено для ручной синхронизации
});
