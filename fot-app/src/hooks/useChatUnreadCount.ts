import { useEffect, useState } from 'react';
import { chatService } from '../services/chatService';

const REFRESH_INTERVAL_MS = 60_000;

export const useChatUnreadCount = (enabled = true) => {
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    if (!enabled) return;

    let active = true;

    const load = async () => {
      try {
        const count = await chatService.getUnreadCount();
        if (active) {
          setUnreadCount(count);
        }
      } catch {
        if (active) {
          setUnreadCount(0);
        }
      }
    };

    void load();
    const intervalId = window.setInterval(() => {
      void load();
    }, REFRESH_INTERVAL_MS);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [enabled]);

  return { unreadCount, setUnreadCount };
};
