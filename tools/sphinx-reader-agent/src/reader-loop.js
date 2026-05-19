'use strict';

const EventEmitter = require('events');

/**
 * Цикл работы со считывателем «Сфинкс»:
 *   open → poll ReceiveW26T → decode 3 байта → debounce → emit('card')
 *   при ошибке связи — close + reopen с бэк-оффом.
 *
 * События:
 *   'status' { connected:boolean, message:string }  — для WS-статуса
 *   'card'   w26:string                              — "<facility>,<number>"
 *   'raw'    { rc:number, hex:string }               — диагностика калибровки
 */
class ReaderLoop extends EventEmitter {
  constructor(sdk, cfg) {
    super();
    this.sdk = sdk;
    this.cfg = cfg;
    this._handle = null;
    this._running = false;
    this._lastW26 = '';
    this._lastW26At = 0;
    this._backoffIdx = 0;
  }

  /** Декод 3-байтового W26 → "<facility>,<number>" (формат примера %03d,%05d). */
  _decode(buf) {
    if (buf.length < 3) return null;
    const facility = buf[0];
    const number = this.cfg.w26.endian === 'little'
      ? (buf[2] << 8) | buf[1]
      : (buf[1] << 8) | buf[2];
    const pad = (n, w) => String(n).padStart(w, '0');
    return `${pad(facility, 3)},${pad(number, 5)}`;
  }

  _emitStatus(connected, message) {
    this.emit('status', { connected, message });
  }

  async start() {
    if (this._running) return;
    this._running = true;
    this._emitStatus(false, 'Поиск считывателя «Сфинкс»…');
    this._loop();
  }

  stop() {
    this._running = false;
    if (this._handle) {
      this.sdk.close(this._handle);
      this._handle = null;
    }
  }

  _nextBackoff() {
    const arr = this.cfg.reopenBackoffMs;
    const ms = arr[Math.min(this._backoffIdx, arr.length - 1)];
    this._backoffIdx += 1;
    return ms;
  }

  _open() {
    this._handle = this.sdk.open();
    if (this._handle) {
      this._backoffIdx = 0;
      this._emitStatus(true, 'Считыватель «Сфинкс» подключён');
      return true;
    }
    this._emitStatus(false, 'Считыватель не найден. Проверьте USB-подключение и драйвер FTDI.');
    return false;
  }

  async _loop() {
    while (this._running) {
      if (!this._handle && !this._open()) {
        await this._sleep(this._nextBackoff());
        continue;
      }

      let res;
      try {
        res = this.sdk.receiveW26T(this._handle, this.cfg.poll.bufLen, this.cfg.poll.timeoutMs);
      } catch (e) {
        this._onCommError(`Ошибка обращения к считывателю: ${e && e.message}`);
        continue;
      }

      const { rc, buf } = res;
      if (this.cfg.logRawBytes) {
        this.emit('raw', { rc, hex: buf.toString('hex') });
      }

      if (rc < 0) {
        this._onCommError('Считыватель отключён. Переподключение…');
        continue;
      }

      const hasData = rc > 0 && buf.some((x) => x !== 0);
      if (!hasData) {
        // таймаут / карты нет — продолжаем опрос
        continue;
      }

      const w26 = this._decode(buf);
      if (w26 && this._accept(w26)) {
        this.emit('card', w26);
      }
    }
  }

  /** Дебаунс повторного чтения одной карты. */
  _accept(w26) {
    const now = Date.now();
    if (w26 === this._lastW26 && now - this._lastW26At < this.cfg.debounceMs) {
      this._lastW26At = now;
      return false;
    }
    this._lastW26 = w26;
    this._lastW26At = now;
    return true;
  }

  _onCommError(message) {
    this._emitStatus(false, message);
    if (this._handle) {
      this.sdk.close(this._handle);
      this._handle = null;
    }
  }

  _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
}

module.exports = { ReaderLoop };
