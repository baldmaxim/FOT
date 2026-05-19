'use strict';

const path = require('path');
const fs = require('fs');

/**
 * FFI-обёртка над spnxreader.dll (Sphinx Reader SDK Rev20).
 *
 * Сигнатуры восстановлены реверсом экспортов и call-site дизассемблером
 * cpp_example.exe (см. SIGNATURES.md). Заголовков SDK в архиве нет.
 *
 *   int  SpnxReaderOpen(void **pHandle);                 // __cdecl, 1 = успех, *pHandle = объект
 *   void SpnxReaderClose(void **pHandle);                // __cdecl, обнуляет *pHandle
 *   int  SpnxReaderReceiveW26 (void *h, uint8_t *buf, int len);             // пример: len=3
 *   int  SpnxReaderReceiveW26T(void *h, uint8_t *buf, int len, int toMs);   // + таймаут
 *
 * КРИТИЧНО: DLL 32-битная (PE32 x86) → процесс Node ОБЯЗАН быть 32-бит.
 * На x64-Node koffi.load бросит ошибку — это ожидаемо (см. README).
 */
class SphinxSdk {
  constructor(vendorDir) {
    this.vendorDir = vendorDir;
    this.available = false;
    this.loadError = null;
    this._koffi = null;
    this._lib = null;
    this._fn = {};
  }

  /** Загрузить koffi и DLL. Не бросает — выставляет available/loadError. */
  load() {
    try {
      const dll = path.join(this.vendorDir, 'spnxreader.dll');
      const ftd = path.join(this.vendorDir, 'FTD2XX.dll');
      if (!fs.existsSync(dll)) throw new Error(`не найден ${dll}`);

      // spnxreader.dll неявно импортирует FTD2XX.dll — кладём vendor в путь
      // поиска и подгружаем FTDI заранее, чтобы загрузчик нашёл её по имени.
      process.env.PATH = `${this.vendorDir};${process.env.PATH || ''}`;

      // eslint-disable-next-line global-require
      const koffi = require('koffi');
      this._koffi = koffi;

      if (fs.existsSync(ftd)) {
        try { koffi.load(ftd); } catch (_e) { /* FTDI может тянуться системно */ }
      }

      const lib = koffi.load(dll);
      this._lib = lib;

      // Все 4 экспорта — __cdecl (на x86 это дефолт koffi).
      this._fn.open = lib.func('int SpnxReaderOpen(_Out_ void **pHandle)');
      this._fn.close = lib.func('void SpnxReaderClose(void **pHandle)');
      this._fn.recv = lib.func('int SpnxReaderReceiveW26(void *h, _Inout_ uint8_t *buf, int len)');
      this._fn.recvT = lib.func('int SpnxReaderReceiveW26T(void *h, _Inout_ uint8_t *buf, int len, int toMs)');

      this.available = true;
    } catch (e) {
      this.available = false;
      this.loadError = e;
    }
    return this.available;
  }

  /**
   * Открыть считыватель.
   * @returns {*} непрозрачный handle (void*) или null при неудаче
   */
  open() {
    if (!this.available) return null;
    const box = [null];
    const rc = this._fn.open(box);
    if (rc === 1 && box[0]) return box[0];
    return null;
  }

  /** Закрыть считыватель (handle далее использовать нельзя). */
  close(handle) {
    if (!this.available || !handle) return;
    try { this._fn.close([handle]); } catch (_e) { /* noop */ }
  }

  /**
   * Прочитать W26 с таймаутом.
   * @param {*} handle
   * @param {number} bufLen   длина буфера (пример SDK: 3 байта)
   * @param {number} timeoutMs
   * @returns {{ rc:number, buf:Buffer }}
   */
  receiveW26T(handle, bufLen, timeoutMs) {
    const buf = Buffer.alloc(bufLen);
    const rc = this._fn.recvT(handle, buf, bufLen, timeoutMs);
    return { rc, buf };
  }

  /** Вариант без таймаута (блокирующий) — на случай если *T нестабилен. */
  receiveW26(handle, bufLen) {
    const buf = Buffer.alloc(bufLen);
    const rc = this._fn.recv(handle, buf, bufLen);
    return { rc, buf };
  }
}

module.exports = { SphinxSdk };
