/**
 * Единый lock на запись сроков действия карт Sigur.
 *
 * Один и тот же ключ берут: массовое продление (долгая операция с heartbeat),
 * поштучное сохранение срока в сайдбаре и CLI-откат. Без общего lock одиночное
 * «Сохранить» вклинивалось бы между перечитыванием карты и PATCH массовой операции,
 * и более ранняя дата затирала бы более позднюю.
 *
 * Что lock НЕ покрывает: правки, сделанные напрямую в Sigur Manager. Это осознанный
 * остаточный риск — поэтому запись всегда дополняется перечитыванием карты.
 */
import { randomUUID } from 'crypto';
import {
  tryAcquireSigurRuntimeLease,
  releaseSigurRuntimeLease,
  startSigurRuntimeLeaseHeartbeat,
} from './sigur-runtime-state.service.js';

/** Ключ lease. Общий для всех операций записи срока карты. */
export const SIGUR_CARD_WRITE_LEASE_KEY = 'sigur:card-write';

/** Короткий lease для одиночного сохранения: операция занимает секунды. */
const SINGLE_WRITE_TTL_SECONDS = 60;

/** Ошибка «lock занят» — контроллеры отдают по ней 409, а не 500. */
export class SigurCardLeaseBusyError extends Error {
  constructor(message = 'Идёт массовая операция с картами, повторите через минуту') {
    super(message);
    this.name = 'SigurCardLeaseBusyError';
  }
}

export interface ISigurCardLeaseHandle {
  owner: string;
  /**
   * true, если lease потерян: heartbeat вернул refreshed=false (перехвачен/истёк)
   * либо упал с ошибкой. После этого новые записи начинать нельзя.
   */
  isLost: () => boolean;
  /** Останавливает heartbeat и отпускает lease. Идемпотентна. */
  release: () => Promise<void>;
}

/**
 * Берёт lease с heartbeat. Возвращает handle или бросает SigurCardLeaseBusyError.
 *
 * Порядок в release() важен: сначала гасим таймер, потом отпускаем строку — иначе
 * тик heartbeat, начавшийся между этими шагами, продлил бы уже отпущенный lease.
 */
export async function acquireSigurCardLease(params: {
  owner: string;
  ttlSeconds: number;
  meta?: Record<string, unknown>;
  withHeartbeat?: boolean;
}): Promise<ISigurCardLeaseHandle> {
  const { owner, ttlSeconds, meta, withHeartbeat = true } = params;

  const acquired = await tryAcquireSigurRuntimeLease({
    key: SIGUR_CARD_WRITE_LEASE_KEY,
    owner,
    ttlSeconds,
    meta,
  });

  if (!acquired.acquired) {
    throw new SigurCardLeaseBusyError();
  }

  let lost = false;
  let released = false;
  let stopHeartbeat: (() => void) | null = null;

  if (withHeartbeat) {
    stopHeartbeat = startSigurRuntimeLeaseHeartbeat({
      key: SIGUR_CARD_WRITE_LEASE_KEY,
      owner,
      ttlSeconds,
      getMeta: () => meta || {},
      onLost: () => {
        lost = true;
        stopHeartbeat?.();
      },
      onError: error => {
        // Ошибку соединения тоже считаем потерей: продлить lease мы не смогли,
        // значит через TTL его законно заберёт другой процесс.
        lost = true;
        stopHeartbeat?.();
        console.error('[sigur-card-lease] heartbeat error:', error);
      },
    });
  }

  return {
    owner,
    isLost: () => lost,
    release: async () => {
      if (released) return;
      released = true;
      stopHeartbeat?.();
      try {
        await releaseSigurRuntimeLease({ key: SIGUR_CARD_WRITE_LEASE_KEY, owner });
      } catch (error) {
        // Не критично: lease истечёт по TTL. Ронять из-за этого уже выполненную
        // операцию (и её аудит) нельзя.
        console.error('[sigur-card-lease] release error:', error);
      }
    },
  };
}

/** Owner для поштучного сохранения срока: уникален на каждый запрос. */
export const buildSingleWriteOwner = (userId?: number | string | null): string =>
  `single:${userId ?? 'unknown'}:${randomUUID()}`;

/**
 * Обёртка для одиночных ручек: взять lease → выполнить → отпустить в finally.
 * Heartbeat не нужен — операция короче TTL.
 */
export async function withSigurCardWriteLease<T>(
  userId: number | string | null | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const lease = await acquireSigurCardLease({
    owner: buildSingleWriteOwner(userId),
    ttlSeconds: SINGLE_WRITE_TTL_SECONDS,
    meta: { kind: 'single_card_write' },
    withHeartbeat: false,
  });

  try {
    return await fn();
  } finally {
    await lease.release();
  }
}
