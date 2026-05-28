import { getIo } from '../socket/io-instance.js';
import type { DomainEvent, IDomainEventPayload } from '../socket/domain-events.js';

// Единый helper для эмита domain-событий Socket.IO. См. план realtime-обновлений и
// docs/socket-architecture. Старые эмиттеры (notifySigurStructureChanged,
// notifySkudRealtimeChanged, leave_request_pending_changed, official_memo_*) — НЕ ТРОГАЕМ.

export interface IDomainEmit {
  event: DomainEvent;
  targetUserIds?: string[];
  broadcast?: boolean;
  payload?: IDomainEventPayload;
}

// Микро-батч: накапливаем эмиты в одном тике event-loop и схлопываем дубли
// (event|uid|entityId) — bulk-approve 50 корректировок шлёт 1 пакет, не 50.
interface IBufferedItem {
  event: DomainEvent;
  uid: string | null;
  broadcast: boolean;
  payload: Record<string, unknown>;
  dedupKey: string;
}

let buffer: IBufferedItem[] = [];
let flushScheduled = false;

function dedupKeyOf(event: DomainEvent, uid: string | null, payload: IDomainEventPayload | undefined, broadcast: boolean): string {
  const entityId = payload?.entityId ?? '';
  const action = payload?.action ?? '';
  return `${event}|${broadcast ? '*' : (uid ?? '')}|${entityId}|${action}`;
}

function flush(): void {
  flushScheduled = false;
  const items = buffer;
  buffer = [];
  if (items.length === 0) return;

  const io = getIo();
  if (!io) return;

  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.dedupKey)) continue;
    seen.add(item.dedupKey);

    try {
      const data = { ...item.payload, at: item.payload.at ?? new Date().toISOString() };
      if (item.broadcast) {
        io.emit(item.event, data);
      } else if (item.uid) {
        io.to(`user:${item.uid}`).emit(item.event, data);
      }
    } catch (socketError) {
      console.error('[realtime-broadcast] emit error:', (socketError as Error).message, 'event:', item.event);
    }
  }
}

function schedule(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  setImmediate(flush);
}

/** Эмит domain-события Socket.IO. Безопасно вызывать при getIo()===null (тесты). */
export function emitDomainChange(input: IDomainEmit): void {
  const { event, targetUserIds, broadcast, payload } = input;

  if (broadcast) {
    buffer.push({
      event,
      uid: null,
      broadcast: true,
      payload: { ...(payload ?? {}) },
      dedupKey: dedupKeyOf(event, null, payload, true),
    });
    schedule();
    return;
  }

  if (!targetUserIds || targetUserIds.length === 0) return;

  const uniq = new Set(targetUserIds.filter((u): u is string => typeof u === 'string' && u.length > 0));
  for (const uid of uniq) {
    buffer.push({
      event,
      uid,
      broadcast: false,
      payload: { ...(payload ?? {}) },
      dedupKey: dedupKeyOf(event, uid, payload, false),
    });
  }
  schedule();
}

/** Для тестов: принудительный сброс буфера. */
export function __flushDomainBufferForTests(): void {
  flush();
}
