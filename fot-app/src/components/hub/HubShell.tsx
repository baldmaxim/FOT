import { Suspense, useEffect, useMemo, type CSSProperties, type FC, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import styles from './HubShell.module.css';

export interface IHubTab {
  key: string;
  label: string;
  accessPath: string;
  icon?: FC<{ size?: number }>;
  render: () => ReactNode;
}

interface IHubShellProps {
  tabs: IHubTab[];
  defaultTab?: string;
}

export const HubShell: FC<IHubShellProps> = ({ tabs, defaultTab }) => {
  const { canViewPage } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const visibleTabs = useMemo(
    () => tabs.filter(tab => canViewPage(tab.accessPath)),
    [tabs, canViewPage],
  );

  const fallbackTab = defaultTab ?? visibleTabs[0]?.key;
  const requestedTab = searchParams.get('tab');
  const activeTab = visibleTabs.some(tab => tab.key === requestedTab)
    ? (requestedTab as string)
    : fallbackTab;

  useEffect(() => {
    if (!activeTab) return;
    if (requestedTab === activeTab) return;
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set('tab', activeTab);
      return next;
    }, { replace: true });
  }, [activeTab, requestedTab, setSearchParams]);

  const setActiveTab = (key: string) => {
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

  const tabsStyle = { '--hub-tabs-count': visibleTabs.length } as CSSProperties;

  return (
    <div className={styles.hub}>
      <div className={styles.tabs} style={tabsStyle}>
        {visibleTabs.map(tab => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.key}
              type="button"
              className={`${styles.tab} ${current.key === tab.key ? styles.tabActive : ''}`}
              onClick={() => setActiveTab(tab.key)}
            >
              {Icon && <Icon size={14} />}
              {tab.label}
            </button>
          );
        })}
      </div>

      <div className={styles.content}>
        <Suspense fallback={<div className={styles.loading}>Загрузка раздела…</div>}>
          {current.render()}
        </Suspense>
      </div>
    </div>
  );
};
