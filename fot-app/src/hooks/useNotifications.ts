import { useState, useEffect, useCallback, useRef } from 'react';
import { notificationApi } from '../services/notificationService';
import type { INotification } from '../services/notificationService';
import { wsService } from '../services/websocket';
import { useAuth } from '../contexts/AuthContext';

export const useNotifications = (realtimeEnabled = true) => {
  const { token, isAuthenticated, isApproved } = useAuth();
  const [notifications, setNotifications] = useState<INotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const loadedRef = useRef(false);

  // Загрузить счётчик при маунте
  useEffect(() => {
    notificationApi.getUnreadCount()
      .then(res => setUnreadCount(res.data.count))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (realtimeEnabled && isAuthenticated && isApproved && token) {
      wsService.connect(token, 'notifications');
      return () => {
        wsService.disconnect('notifications');
      };
    }

    wsService.disconnect('notifications');
    return undefined;
  }, [isApproved, isAuthenticated, realtimeEnabled, token]);

  // Подписка на Socket.IO
  useEffect(() => {
    const offNew = wsService.on('notification_new', (payload: unknown) => {
      const n = payload as INotification;
      setUnreadCount(prev => prev + 1);
      setNotifications(prev => loadedRef.current ? [n, ...prev] : prev);
    });
    // Авторитетный счётчик с сервера (в т.ч. при прочтении переписки в
    // другой вкладке) — синхронизирует бейдж без перезагрузки.
    const offCount = wsService.on('notification_count', (payload: unknown) => {
      const data = payload as { count?: number };
      if (typeof data?.count === 'number') {
        setUnreadCount(Math.max(0, data.count));
      }
    });
    return () => {
      offNew();
      offCount();
    };
  }, []);

  // Ленивая загрузка списка (при открытии дропдауна)
  const loadNotifications = useCallback(async () => {
    if (loadedRef.current) return;
    setLoading(true);
    try {
      const res = await notificationApi.getAll(50, 0);
      setNotifications(res.data);
      loadedRef.current = true;
    } finally {
      setLoading(false);
    }
  }, []);

  const markRead = useCallback(async (id: string) => {
    await notificationApi.markRead(id);
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, is_read: true } : n));
    setUnreadCount(prev => Math.max(0, prev - 1));
  }, []);

  const markAllRead = useCallback(async () => {
    await notificationApi.markAllRead();
    setNotifications(prev => prev.map(n => ({ ...n, is_read: true })));
    setUnreadCount(0);
  }, []);

  return { notifications, unreadCount, loading, loadNotifications, markRead, markAllRead };
};
