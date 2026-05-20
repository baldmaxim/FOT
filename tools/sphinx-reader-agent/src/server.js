'use strict';

const { WebSocketServer } = require('ws');

/**
 * Локальный WS-сервер для браузера (паритет с Sigur Reader EH).
 * Слушает только loopback — карта/статус не уходят за пределы машины.
 *
 * По умолчанию поднимает ДВА сокета: IPv4 127.0.0.1 и IPv6 ::1.
 * Причина: на Windows 10/11 браузер обычно резолвит `localhost` сначала в `::1`,
 * а если listener только на 127.0.0.1 — получает ECONNREFUSED и считает агент
 * незапущенным. Биндинг на оба адреса делает агент видимым и через `localhost`,
 * и через `127.0.0.1`.
 *
 * Конфиг `host`:
 *   ""  / "*" / "all" / null — оба loopback-адреса (127.0.0.1 + ::1)
 *   "127.0.0.1"               — только IPv4 (легаси)
 *   "::1"                     — только IPv6
 *   "0.0.0.0" / "::"          — все интерфейсы (НЕ рекомендуется, открывает порт наружу)
 */
class AgentServer {
  constructor(host, port) {
    this.host = host;
    this.port = port;
    this.wssList = [];
    this._lastStatus = null; // последний JSON статуса для новых клиентов
  }

  _resolveHosts() {
    const h = this.host == null ? '' : String(this.host).trim();
    if (h === '' || h === '*' || h.toLowerCase() === 'all') {
      return ['127.0.0.1', '::1'];
    }
    return [h];
  }

  start() {
    const hosts = this._resolveHosts();
    for (const host of hosts) {
      const wss = new WebSocketServer({ host, port: this.port });
      wss.on('connection', (ws) => {
        if (this._lastStatus) {
          try { ws.send(this._lastStatus); } catch (_e) { /* noop */ }
        }
      });
      wss.on('error', (e) => {
        // Порт занят — почти всегда конкурирующий агент (Sigur Reader EH).
        console.error(`[ws ${host}] ошибка: ${e && e.message}. Порт ${this.port} занят другим агентом?`);
      });
      this.wssList.push(wss);
    }
  }

  /** Адреса, на которых реально слушает сервер — для лога в index.js. */
  listeningHosts() {
    return this._resolveHosts();
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
    for (const wss of this.wssList) {
      for (const client of wss.clients) {
        if (client.readyState === 1) {
          try { client.send(payload); } catch (_e) { /* noop */ }
        }
      }
    }
  }

  stop() {
    for (const wss of this.wssList) {
      try { wss.close(); } catch (_e) { /* noop */ }
    }
    this.wssList = [];
  }
}

module.exports = { AgentServer };
