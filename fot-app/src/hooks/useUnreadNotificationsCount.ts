import { useEffect, useState } from 'react';
import { notificationApi } from '../services/notificationService';
import { wsService } from '../services/websocket';
import { useAuth } from '../contexts/AuthContext';

export const useUnreadNotificationsCount = () => {
  const { token, isAuthenticated, isApproved } = useAuth();
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    let active = true;

    notificationApi.getUnreadCount()
      .then(response => {
        if (active) {
          setUnreadCount(response.data.count);
        }
      })
      .catch(() => undefined);

    return () => {
      active = false;
    };
  }, []);

  // Держим соединение под отдельным owner'ом, чтобы бейдж в шапке
  // обновлялся вживую даже без открытого дропдауна.
  useEffect(() => {
    if (isAuthenticated && isApproved && token) {
      wsService.connect(token, 'notif-badge');
      return () => {
        wsService.disconnect('notif-badge');
      };
    }
    return undefined;
  }, [isApproved, isAuthenticated, token]);

  // notification_count — авторитетный счётчик с сервера (создание /
  // прочтение / прочтение переписки). notification_new — мгновенный +1
  // (затем корректируется авторитетным значением).
  useEffect(() => {
    const offCount = wsService.on('notification_count', (payload: unknown) => {
      const data = payload as { count?: number };
      if (typeof data?.count === 'number') {
        setUnreadCount(Math.max(0, data.count));
      }
    });
    const offNew = wsService.on('notification_new', () => {
      setUnreadCount(prev => prev + 1);
    });
    return () => {
      offCount();
      offNew();
    };
  }, []);

  return { unreadCount, setUnreadCount };
};
