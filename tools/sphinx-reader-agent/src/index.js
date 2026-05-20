'use strict';

const path = require('path');
const fs = require('fs');

const { SphinxSdk } = require('./sphinx-sdk');
const { ReaderLoop } = require('./reader-loop');
const { AgentServer } = require('./server');
const { statusMessage, cardMessage } = require('./contract');

// При сборке pkg DLL/конфиг лежат рядом с .exe (snapshot не умеет грузить
// нативные DLL), иначе — в корне проекта агента.
const baseDir = process.pkg ? path.dirname(process.execPath) : path.join(__dirname, '..');
const vendorDir = path.join(baseDir, 'vendor');

function loadConfig() {
  const defaults = {
    // Пустая строка → агент слушает оба loopback-стека (127.0.0.1 и ::1).
    // См. server.js: AgentServer._resolveHosts.
    host: '',
    port: 8765,
    poll: { bufLen: 3, timeoutMs: 500 },
    w26: { endian: 'big' },
    debounceMs: 1500,
    reopenBackoffMs: [1000, 2000, 5000],
    logRawBytes: true,
  };
  try {
    const p = path.join(baseDir, 'config.json');
    if (fs.existsSync(p)) {
      return Object.assign(defaults, JSON.parse(fs.readFileSync(p, 'utf8')));
    }
  } catch (e) {
    log(`config.json не прочитан, дефолты: ${e && e.message}`);
  }
  return defaults;
}

function ts() {
  return new Date().toLocaleTimeString('ru-RU');
}
function log(msg) {
  console.log(`[${ts()}] ${msg}`);
}

function main() {
  const cfg = loadConfig();

  log('Sphinx Reader Agent — настольный ридер выдачи карт «Сфинкс»');
  log(`Архитектура процесса: ${process.arch} (требуется ia32 для 32-битной spnxreader.dll)`);

  const server = new AgentServer(cfg.host, cfg.port);
  server.start();
  for (const host of server.listeningHosts()) {
    const url = host.includes(':') ? `ws://[${host}]:${cfg.port}` : `ws://${host}:${cfg.port}`;
    log(`WS-сервер: ${url}`);
  }

  const sdk = new SphinxSdk(vendorDir);
  sdk.load();
  if (!sdk.available) {
    const why = sdk.loadError && sdk.loadError.message;
    const hint = process.arch !== 'ia32'
      ? 'Запущен не 32-битный Node. Используйте node-win-x86 / pkg node18-win-x86.'
      : 'Проверьте vendor/spnxreader.dll и FTD2XX.dll.';
    log(`SDK не загружен: ${why}. ${hint}`);
    server.broadcastStatus(statusMessage(false, 'Драйвер считывателя не загружен (см. окно агента)'));
  }

  const loop = new ReaderLoop(sdk, cfg);

  loop.on('status', ({ connected, message }) => {
    log(`Статус: ${message}`);
    server.broadcastStatus(statusMessage(connected, message));
  });
  loop.on('card', (w26) => {
    log(`Карта: ${w26}`);
    server.broadcastCard(cardMessage(w26));
  });
  loop.on('raw', ({ rc, hex }) => {
    if (cfg.logRawBytes) log(`raw rc=${rc} buf=${hex}`);
  });

  if (sdk.available) {
    loop.start();
  }

  const shutdown = () => {
    log('Остановка…');
    try { loop.stop(); } catch (_e) { /* noop */ }
    try { server.stop(); } catch (_e) { /* noop */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('uncaughtException', (e) => log(`uncaught: ${e && e.stack}`));
}

main();
