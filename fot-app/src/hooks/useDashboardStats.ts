import { useState, useEffect, useCallback, useRef } from 'react';
import { skudService } from '../services/skudService';
import type { IDashboardStats, DashboardPeriod } from '../types';

const REFRESH_INTERVAL = 60_000;

interface IUseDashboardStatsReturn {
  stats: IDashboardStats | null;
  loading: boolean;
  error: string | null;
}

export const useDashboardStats = (departmentId: string | null, period: DashboardPeriod = 'today'): IUseDashboardStatsReturn => {
  const [stats, setStats] = useState<IDashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<number | null>(null);

  const fetchStats = useCallback(async (signal?: AbortSignal) => {
    if (!departmentId) {
      setStats(null);
      setLoading(false);
      return;
    }
    try {
      const data = await skudService.getDashboardStats(departmentId, period, signal);
      if (!signal?.aborted) {
        setStats(data);
        setError(null);
      }
    } catch {
      if (!signal?.aborted) {
        setError('Ошибка загрузки аналитики');
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [departmentId, period]);

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    fetchStats(ac.signal);
    return () => ac.abort();
  }, [fetchStats]);

  useEffect(() => {
    if (!departmentId) return;
    intervalRef.current = window.setInterval(() => fetchStats(), REFRESH_INTERVAL);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchStats, departmentId]);

  return { stats, loading, error };
};
