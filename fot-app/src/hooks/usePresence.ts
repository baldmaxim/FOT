import { useState, useEffect, useCallback, useRef } from 'react';
import { skudService } from '../services/skudService';
import type { IEmployeePresence } from '../types';

const REFRESH_INTERVAL = 30_000;

interface IUsePresenceReturn {
  employees: IEmployeePresence[];
  loading: boolean;
  error: string | null;
  lastUpdated: Date | null;
  refresh: () => void;
}

export const usePresence = (departmentId: string | null): IUsePresenceReturn => {
  const [employees, setEmployees] = useState<IEmployeePresence[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const intervalRef = useRef<number | null>(null);

  const fetchPresence = useCallback(async () => {
    try {
      const data = await skudService.getPresence(departmentId || undefined);
      setEmployees(data);
      setLastUpdated(new Date());
      setError(null);
    } catch {
      setError('Ошибка загрузки статусов');
    } finally {
      setLoading(false);
    }
  }, [departmentId]);

  useEffect(() => {
    setLoading(true);
    fetchPresence();
  }, [fetchPresence]);

  useEffect(() => {
    intervalRef.current = window.setInterval(fetchPresence, REFRESH_INTERVAL);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchPresence]);

  return { employees, loading, error, lastUpdated, refresh: fetchPresence };
};
