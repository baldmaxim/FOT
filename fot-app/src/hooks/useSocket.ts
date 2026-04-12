import { useEffect } from 'react';
import { wsService } from '../services/websocket';

export const useSocket = (token: string | null): typeof wsService | null => {
  useEffect(() => {
    if (!token) {
      wsService.disconnect('route-chat');
      return;
    }

    wsService.connect(token, 'route-chat');
    return () => {
      wsService.disconnect('route-chat');
    };
  }, [token]);

  return token ? wsService : null;
};
