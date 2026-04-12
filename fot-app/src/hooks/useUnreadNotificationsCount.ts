import { useEffect, useState } from 'react';
import { notificationApi } from '../services/notificationService';

export const useUnreadNotificationsCount = () => {
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

  return { unreadCount, setUnreadCount };
};
