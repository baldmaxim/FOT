// PM2 ecosystem для fot-server.
//
// Запуск из папки fot-server:        pm2 start ecosystem.config.cjs
// Перезапуск с обновлением env:       pm2 restart fot-server --update-env && pm2 save
//
// ВАЖНО — режим fork, ОДИН инстанс. НЕ переводить в cluster (instances > 1 / -i N)
// без выполнения предусловий, иначе архитектура молча сломается:
//   - Socket.IO использует in-memory adapter → emit не дойдёт между процессами
//     (нужен @socket.io/redis-adapter + Redis);
//   - реестр онлайн-присутствия (portal-presence.service) — per-process Map;
//   - все фоновые сервисы в index.ts стартуют безусловно → задублируются N×
//     (нужен гейт на process.env.NODE_APP_INSTANCE === '0');
//   - in-memory LRU/rate-limit рассинхронятся между воркерами;
//   - nginx понадобится sticky-sessions для polling-транспорта.
// Один fork-процесс рассчитан выдержать ~1500 пользователей.

const path = require('node:path');

module.exports = {
  apps: [
    {
      name: 'fot-server',
      script: path.join(__dirname, 'dist', 'index.js'),
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,

      // Авто-рестарт при тихом OOM/утечке единственного процесса.
      // ПЛЕЙСХОЛДЕР: подобрать под RAM VDS (~70% от доступной) ПОСЛЕ снятия
      // baseline heap (process.memoryUsage / SystemResources). 1536M — старт.
      max_memory_restart: '1536M',

      // Дать времени graceful shutdown (index.ts: SIGTERM/SIGINT → дренирование
      // сокетов/запросов + закрытие пула; внутренний форс-выход на 10с).
      // PM2 шлёт SIGINT и ждёт kill_timeout перед SIGKILL.
      kill_timeout: 12000,

      // NODE_ENV намеренно НЕ задаём здесь — берётся из .env (как сейчас).
      // Если решите фиксировать в PM2 — добавьте env: { NODE_ENV: 'production' }.
    },
  ],
};
