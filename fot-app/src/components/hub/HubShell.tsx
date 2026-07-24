import { Suspense, useEffect, useMemo, useState, type FC, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import styles from './HubShell.module.css';

export interface IHubTab {
  key: string;
  label: string;
  /** Ключ доступа. Массив — вкладка видна при наличии ЛЮБОГО из ключей. */
  accessPath: string | string[];
  icon?: FC<{ size?: number }>;
  render: () => ReactNode;
}

interface IHubShellProps {
  tabs: IHubTab[];
  defaultTab?: string;
  /**
   * Хранить активную вкладку в URL (`?tab=`). По умолчанию `true`.
   * `false` — вкладка в локальном состоянии (в URL не пишется). Нужно для страниц,
   * чей контент сам перезаписывает query string и затирает `tab` (например
   * `/staff-control`), что иначе создаёт цикл навигации (Throttling navigation).
   */
  persistInUrl?: boolean;
}

export const HubShell: FC<IHubShellProps> = ({ tabs, defaultTab, persistInUrl = true }) => {
  const { canViewPage } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const visibleTabs = useMemo(
    () => tabs.filter(tab => (
      Array.isArray(tab.accessPath)
        ? tab.accessPath.some(path => canViewPage(path))
        : canViewPage(tab.accessPath)
    )),
    [tabs, canViewPage],
  );

  const fallbackTab = defaultTab ?? visibleTabs[0]?.key;

  // Локальное состояние вкладки (для persistInUrl=false). Seed из `?tab=` один
  // раз при маунте — только если запрошенная вкладка доступна по правам.
  const [localTab, setLocalTab] = useState<string | undefined>(() => {
    const req = searchParams.get('tab');
    return visibleTabs.some(tab => tab.key === req) ? (req as string) : fallbackTab;
  });

  const requestedTab = persistInUrl ? searchParams.get('tab') : (localTab ?? null);
  const activeTab = visibleTabs.some(tab => tab.key === requestedTab)
    ? (requestedTab as string)
    : fallbackTab;

  useEffect(() => {
    if (!persistInUrl) return;
    if (!activeTab) return;
    if (requestedTab === activeTab) return;
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set('tab', activeTab);
      return next;
    }, { replace: true });
  }, [persistInUrl, activeTab, requestedTab, setSearchParams]);

  const setActiveTab = (key: string) => {
    if (!persistInUrl) {
      setLocalTab(key);
      return;
    }
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set('tab', key);
      return next;
    }, { replace: false });
  };

  if (visibleTabs.length === 0) {
    return (
      <div className={styles.empty}>
        Нет доступных разделов
      </div>
    );
  }

  const current = visibleTabs.find(tab => tab.key === activeTab) ?? visibleTabs[0];

  return (
    <div className={styles.hub}>
      {visibleTabs.length > 1 && (
        <div className={styles.tabs}>
          {visibleTabs.map(tab => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.key}
                type="button"
                className={`${styles.tab} ${current.key === tab.key ? styles.tabActive : ''}`}
                onClick={() => setActiveTab(tab.key)}
              >
                {Icon && <Icon size={12} />}
                {tab.label}
              </button>
            );
          })}
        </div>
      )}

      <div className={styles.content}>
        <Suspense fallback={<div className={styles.loading}>Загрузка раздела…</div>}>
          {current.render()}
        </Suspense>
      </div>
    </div>
  );
};
