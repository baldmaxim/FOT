'use strict';

/**
 * Контракт WebSocket-сообщений — побайтовый паритет с агентом Sigur Reader EH.
 * Потребитель на фронте: fot-app/src/hooks/useCardReader.ts
 *   - status: { type:'status', connected:boolean, message:string }
 *   - card:   { type:'card', w26, sigurCard, hexUid, decBe, decLe, rawHex }
 *
 * Ридер «Сфинкс» по SDK отдаёт только Wiegand-26 → шлём один w26,
 * остальные поля пустые (фронт подставляет '' по умолчанию).
 * Бэкенд (sigur-data.service.ts buildCardNumberVariants) разбирает строку
 * формата "<facility>,<number>" и сам строит hex/dec/combined-варианты.
 */

/** @returns {string} JSON статуса для отправки в браузер */
function statusMessage(connected, message) {
  return JSON.stringify({ type: 'status', connected: !!connected, message: String(message || '') });
}

/**
 * @param {string} w26 Строка вида "<facility>,<number>", напр. "012,03456"
 * @returns {string} JSON карты для отправки в браузер
 */
function cardMessage(w26) {
  return JSON.stringify({
    type: 'card',
    w26: String(w26 || ''),
    sigurCard: '',
    hexUid: '',
    decBe: '',
    decLe: '',
    rawHex: '',
  });
}

module.exports = { statusMessage, cardMessage };
