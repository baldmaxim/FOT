import { getIo } from '../socket/io-instance.js';

// Регистр «онлайн на портале»: кто прямо сейчас держит хотя бы один Socket.IO
// коннект (открыт веб-портал/PWA). Состояние in-memory — корректно для single
// PM2-процесса; при переходе на кластер понадобится @socket.io/redis-adapter.
//
// Ключ — user_id (UUID app_auth). employee_id (Sigur) храним рядом, т.к. знаем
// его из JWT при коннекте: чат и «Все пользователи» матчат по user_id,
// «Управление кадрами» — по employee_id.

interface IPresenceEntry {
  count: number;
  employeeId: number | null;
}

export interface IPortalPresenceSnapshot {
  userIds: string[];
  employeeIds: number[];
}

const registry = new Map<string, IPresenceEntry>();

// true, если пользователь стал онлайн (переход 0→1).
export function addConnection(userId: string, employeeId: number | null): boolean {
  const entry = registry.get(userId);
  if (entry) {
    entry.count += 1;
    // На случай, если employeeId стал известен позже (старый коннект без него).
    if (entry.employeeId == null && employeeId != null) entry.employeeId = employeeId;
    return false;
  }
  registry.set(userId, { count: 1, employeeId });
  return true;
}

// true, если пользователь стал офлайн (переход 1→0).
export function removeConnection(userId: string): boolean {
  const entry = registry.get(userId);
  if (!entry) return false;
  entry.count -= 1;
  if (entry.count <= 0) {
    registry.delete(userId);
    return true;
  }
  return false;
}

export function getCount(userId: string): number {
  return registry.get(userId)?.count ?? 0;
}

export function getSnapshot(): IPortalPresenceSnapshot {
  const userIds: string[] = [];
  const employeeIds: number[] = [];
  for (const [userId, entry] of registry.entries()) {
    userIds.push(userId);
    if (entry.employeeId != null) employeeIds.push(entry.employeeId);
  }
  return { userIds, employeeIds };
}

function emit(event: 'user_online' | 'user_offline', userId: string, employeeId: number | null): void {
  try {
    getIo()?.emit(event, { userId, employeeId, at: new Date().toISOString() });
  } catch (socketError) {
    console.error(`[portal-presence] socket emit error (${event}):`, (socketError as Error).message);
  }
}

export function emitOnline(userId: string, employeeId: number | null): void {
  emit('user_online', userId, employeeId);
}

export function emitOffline(userId: string, employeeId: number | null): void {
  emit('user_offline', userId, employeeId);
}

export const portalPresence = {
  addConnection,
  removeConnection,
  getCount,
  getSnapshot,
  emitOnline,
  emitOffline,
};
