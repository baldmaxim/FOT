'use strict';

const { WebSocketServer } = require('ws');

/**
 * Локальный WS-сервер для браузера (паритет с Sigur Reader EH).
 * Слушает только loopback — карта/статус не уходят за пределы машины.
 */
class AgentServer {
  constructor(host, port) {
    this.host = host;
    this.port = port;
    this.wss = null;
    this._lastStatus = null; // последний JSON статуса для новых клиентов
  }

  start() {
    this.wss = new WebSocketServer({ host: this.host, port: this.port });
    this.wss.on('connection', (ws) => {
      if (this._lastStatus) {
        try { ws.send(this._lastStatus); } catch (_e) { /* noop */ }
      }
    });
    this.wss.on('error', (e) => {
      // Порт занят — почти всегда конкурирующий агент (Sigur Reader EH).
      console.error(`[ws] ошибка: ${e && e.message}. Порт ${this.port} занят другим агентом?`);
    });
  }

  /** statusJson запоминается и переотдаётся новым подключениям. */
  broadcastStatus(statusJson) {
    this._lastStatus = statusJson;
    this._broadcast(statusJson);
  }

  broadcastCard(cardJson) {
    this._broadcast(cardJson);
  }

  _broadcast(payload) {
    if (!this.wss) return;
    for (const client of this.wss.clients) {
      if (client.readyState === 1) {
        try { client.send(payload); } catch (_e) { /* noop */ }
      }
    }
  }

  stop() {
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
  }
}

module.exports = { AgentServer };
