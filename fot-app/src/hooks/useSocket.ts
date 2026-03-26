import { useEffect, useRef, useSyncExternalStore } from 'react';
import { io, Socket } from 'socket.io-client';

const SOCKET_URL = import.meta.env.VITE_API_URL?.replace('/api', '') || 'http://localhost:3000';

export const useSocket = (token: string | null): Socket | null => {
  const socketRef = useRef<Socket | null>(null);
  const listenersRef = useRef(new Set<() => void>());

  const subscribe = (cb: () => void) => {
    listenersRef.current.add(cb);
    return () => { listenersRef.current.delete(cb); };
  };

  const getSnapshot = () => socketRef.current;

  useEffect(() => {
    if (!token) {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
        listenersRef.current.forEach(cb => cb());
      }
      return;
    }

    const s = io(SOCKET_URL, {
      auth: { token },
      transports: ['websocket', 'polling'],
    });

    socketRef.current = s;
    listenersRef.current.forEach(cb => cb());

    const listeners = listenersRef.current;
    return () => {
      s.disconnect();
      socketRef.current = null;
      listeners.forEach(cb => cb());
    };
  }, [token]);

  return useSyncExternalStore(subscribe, getSnapshot);
};
