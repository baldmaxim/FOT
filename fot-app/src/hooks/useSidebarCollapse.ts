import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'fot:sidebar-collapsed';

const readInitial = (): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
};

export const useSidebarCollapse = () => {
  const [isCollapsed, setIsCollapsed] = useState<boolean>(readInitial);

  const toggle = useCallback(() => {
    setIsCollapsed(prev => {
      const next = !prev;
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
      } catch {
        // ignore storage errors (private mode, quota)
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      setIsCollapsed(e.newValue === '1');
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  return { isCollapsed, toggle };
};
