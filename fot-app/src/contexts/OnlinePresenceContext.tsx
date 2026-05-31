/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef, type FC, type ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { wsService } from '../services/websocket';
import { presenceService } from '../services/presenceService';

interface IOnlinePresenceContextType {
  isUserOnline: (userId: string | null | undefined) => boolean;
  isEmployeeOnline: (employeeId: number | null | undefined) => boolean;
}

const OnlinePresenceContext = createContext<IOnlinePresenceContextType | null>(null);

interface IPresenceEvent {
  userId?: string;
  employeeId?: number | null;
}

// Единый источник правды «онлайн на портале». Один начальный snapshot + дельты
// через Socket.IO (user_online/user_offline). Сокет уже поднят ChatProvider'ом;
// здесь подписываемся со своим owner, чтобы провайдер был самодостаточным.
export const OnlinePresenceProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const { token, isAuthenticated, isApproved } = useAuth();
  const enabled = isAuthenticated && isApproved && !!token;

  const [onlineUsers, setOnlineUsers] = useState<Set<string>>(() => new Set());
  const [onlineEmployees, setOnlineEmployees] = useState<Set<number>>(() => new Set());
  const ownerRef = useRef('online-presence');

  // Подключение сокета + начальный snapshot.
  useEffect(() => {
    if (!enabled) {
      wsService.disconnect(ownerRef.current);
      setOnlineUsers(new Set());
      setOnlineEmployees(new Set());
      return undefined;
    }

    wsService.connect(token, ownerRef.current);

    let cancelled = false;
    void presenceService.getOnlinePortal()
      .then(snapshot => {
        if (cancelled) return;
        setOnlineUsers(new Set(snapshot.userIds));
        setOnlineEmployees(new Set(snapshot.employeeIds));
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      wsService.disconnect(ownerRef.current);
    };
  }, [enabled, token]);

  // Инкрементальные дельты.
  useEffect(() => {
    if (!enabled) return undefined;

    const applyDelta = (payload: unknown, online: boolean) => {
      const { userId, employeeId } = (payload ?? {}) as IPresenceEvent;
      if (userId) {
        setOnlineUsers(prev => {
          if (online === prev.has(userId)) return prev;
          const next = new Set(prev);
          if (online) next.add(userId); else next.delete(userId);
          return next;
        });
      }
      if (employeeId != null) {
        setOnlineEmployees(prev => {
          if (online === prev.has(employeeId)) return prev;
          const next = new Set(prev);
          if (online) next.add(employeeId); else next.delete(employeeId);
          return next;
        });
      }
    };

    const unsubOnline = wsService.on('user_online', payload => applyDelta(payload, true));
    const unsubOffline = wsService.on('user_offline', payload => applyDelta(payload, false));

    return () => {
      unsubOnline();
      unsubOffline();
    };
  }, [enabled]);

  const isUserOnline = useCallback(
    (userId: string | null | undefined) => (userId ? onlineUsers.has(userId) : false),
    [onlineUsers],
  );
  const isEmployeeOnline = useCallback(
    (employeeId: number | null | undefined) => (employeeId != null ? onlineEmployees.has(employeeId) : false),
    [onlineEmployees],
  );

  const value = useMemo<IOnlinePresenceContextType>(
    () => ({ isUserOnline, isEmployeeOnline }),
    [isUserOnline, isEmployeeOnline],
  );

  return <OnlinePresenceContext.Provider value={value}>{children}</OnlinePresenceContext.Provider>;
};

export const useOnlinePresence = (): IOnlinePresenceContextType => {
  const ctx = useContext(OnlinePresenceContext);
  if (!ctx) {
    throw new Error('useOnlinePresence must be used within an OnlinePresenceProvider');
  }
  return ctx;
};
