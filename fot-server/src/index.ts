import app from './app.js';
import { env } from './config/env.js';
// import { startPresencePolling } from './services/presence-polling.service.js';

const PORT = parseInt(env.PORT);

app.listen(PORT, () => {
  console.log(`🚀 FOT Server running on port ${PORT}`);
  console.log(`📍 Environment: ${env.NODE_ENV}`);
  console.log(`🔒 CORS Origin: ${env.CORS_ORIGIN}`);
  // startPresencePolling(); // временно отключён
});
