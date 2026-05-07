import { useEffect, useId, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import { wsService } from '../services/websocket';

interface IUseStructureRealtimeOptions {
  enabled?: boolean;
  debounceMs?: number;
}

const STRUCTURE_QUERY_KEYS: readonly (readonly string[])[] = [
  ['sigur-admin'],
  ['structure'],
];

export const useStructureRealtime = ({
  enabled = true,
  debounceMs = 250,
}: IUseStructureRealtimeOptions = {}): void => {
  const { token, isAuthenticated, isApproved } = useAuth();
  const instanceId = useId();
  const ownerId = `structure-realtime:${instanceId}`;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled || !isAuthenticated || !isApproved || !token) {
      wsService.disconnect(ownerId);
      return undefined;
    }

    wsService.connect(token, ownerId);
    return () => {
      wsService.disconnect(ownerId);
    };
  }, [enabled, isApproved, isAuthenticated, ownerId, token]);

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    const unsubscribe = wsService.on('structure_updated', () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }

      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        for (const queryKey of STRUCTURE_QUERY_KEYS) {
          void queryClient.invalidateQueries({ queryKey: [...queryKey] });
        }
      }, debounceMs);
    });

    return () => {
      unsubscribe();
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [debounceMs, enabled, queryClient]);
};
