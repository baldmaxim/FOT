/**
 * Подписанный previewToken для массового продления карт.
 *
 * Записывать разрешено только то, что пользователь видел в предпросмотре: между
 * предпросмотром и подтверждением у сотрудника могла появиться новая карта, и она
 * не должна попасть под общее «продлить и истёкшие». Токен фиксирует состав карт,
 * целевую дату, контур и состав сотрудников; параметры операции сервер берёт
 * из него, а не из тела запроса.
 */
import { createHmac, timingSafeEqual } from 'crypto';
import { env } from '../config/env.js';
import type { ConnectionType } from './sigur-base.service.js';
import type { IExpectedCard } from './sigur-bulk-cards.service.js';

/** Токен живёт 10 минут: дольше предпросмотр всё равно перестаёт отражать реальность. */
const TOKEN_TTL_MS = 10 * 60 * 1000;

export interface IBulkExtendTokenPayload {
  employeeIds: number[];
  connection?: ConnectionType;
  expirationDate: string;
  targetIso: string;
  cards: IExpectedCard[];
  exp: number;
}

export class BulkExtendTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BulkExtendTokenError';
  }
}

const sign = (payloadBase64: string): string =>
  createHmac('sha256', env.JWT_SECRET).update(payloadBase64).digest('base64url');

export function createBulkExtendToken(
  payload: Omit<IBulkExtendTokenPayload, 'exp'>,
  now: number = Date.now(),
): string {
  const full: IBulkExtendTokenPayload = { ...payload, exp: now + TOKEN_TTL_MS };
  const encoded = Buffer.from(JSON.stringify(full), 'utf8').toString('base64url');
  return `${encoded}.${sign(encoded)}`;
}

export function verifyBulkExtendToken(
  token: unknown,
  now: number = Date.now(),
): IBulkExtendTokenPayload {
  if (typeof token !== 'string' || !token.includes('.')) {
    throw new BulkExtendTokenError('Предпросмотр не найден — обновите его и повторите');
  }

  const separator = token.lastIndexOf('.');
  const encoded = token.slice(0, separator);
  const signature = token.slice(separator + 1);

  const expected = Buffer.from(sign(encoded), 'utf8');
  const actual = Buffer.from(signature, 'utf8');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new BulkExtendTokenError('Предпросмотр повреждён — обновите его и повторите');
  }

  let payload: IBulkExtendTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as IBulkExtendTokenPayload;
  } catch {
    throw new BulkExtendTokenError('Предпросмотр повреждён — обновите его и повторите');
  }

  if (!payload || typeof payload.exp !== 'number' || payload.exp < now) {
    throw new BulkExtendTokenError('Предпросмотр устарел — обновите его и повторите');
  }
  if (!Array.isArray(payload.employeeIds) || payload.employeeIds.length === 0) {
    throw new BulkExtendTokenError('Предпросмотр не содержит сотрудников');
  }
  if (!Array.isArray(payload.cards)) {
    throw new BulkExtendTokenError('Предпросмотр повреждён — обновите его и повторите');
  }

  return payload;
}
