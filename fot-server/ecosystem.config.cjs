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

// Лимит памяти в одном месте: PM2 убивает процесс по нему, а приложение
// предупреждает в логе на подходе к порогу (index.ts, телеметрия памяти).
// Без общей константы приложению неоткуда узнать, при каком RSS его убьют.
const MAX_MEMORY_MB = 1536;

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
      max_memory_restart: `${MAX_MEMORY_MB}M`,

      // Дать времени graceful shutdown (index.ts: SIGTERM/SIGINT → дренирование
      // сокетов/запросов + закрытие пула; внутренний форс-выход на 10с).
      // PM2 шлёт SIGINT и ждёт kill_timeout перед SIGKILL.
      kill_timeout: 12000,

      // PM2 считает процесс готовым только после process.send('ready')
      // (см. index.ts после httpServer.listen), а не сразу при старте —
      // апстрим помечается online лишь когда реально слушает порт.
      wait_ready: true,
      listen_timeout: 10000,

      // NODE_ENV намеренно НЕ задаём здесь — берётся из .env (как сейчас).
      // Если решите фиксировать в PM2 — добавьте NODE_ENV: 'production' в env ниже.
      env: {
        // Порог для предупреждения в телеметрии памяти (index.ts). Не влияет
        // ни на что, кроме лога: убивает процесс сам PM2 по max_memory_restart.
        PM2_MAX_MEMORY_MB: String(MAX_MEMORY_MB),
      },
    },
  ],
};
