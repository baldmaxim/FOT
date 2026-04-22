import { Suspense, lazy, useState, useEffect, useCallback } from 'react';
import { Settings, MapPin, Filter, Database } from 'lucide-react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { sigurService } from '../../services/sigurService';
import { useAuth } from '../../contexts/AuthContext';
import type { SettingsTab } from '../../components/skud/sigur-settings.types';
import '../../styles/SigurSettingsPage.css';

const ConnectionSettingsTab = lazy(() => import('../../components/skud/ConnectionSettingsTab').then(module => ({
  default: module.ConnectionSettingsTab,
})));
const AccessPointsTab = lazy(() => import('../../components/skud/AccessPointsTab').then(module => ({
  default: module.AccessPointsTab,
})));
const SyncFilterTab = lazy(() => import('../../components/skud/SyncFilterTab').then(module => ({
  default: module.SyncFilterTab,
})));
const TravelObjectsTab = lazy(() => import('../../components/skud/TravelObjectsTab').then(module => ({
  default: module.TravelObjectsTab,
})));
const TravelConfigTab = lazy(() => import('../../components/skud/TravelConfigTab').then(module => ({
  default: module.TravelConfigTab,
})));

const SETTINGS_TABS: SettingsTab[] = [
  'settings',
  'sync-filter',
  'access-points',
  'objects',
  'travel-config',
];

const resolveSettingsTab = (value: string | null): SettingsTab => (
  value && SETTINGS_TABS.includes(value as SettingsTab)
    ? value as SettingsTab
    : 'settings'
);

export const SigurSettingsPage = () => {
  const { canEditPage } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const canEdit = canEditPage('/skud-settings');

  const legacyTab = searchParams.get('tab');
  const legacyRedirect = legacyTab === 'employees'
    ? '/sigur'
    : legacyTab === 'sigur'
      ? `/sigur?view=settings${searchParams.get('sub') ? `&sub=${searchParams.get('sub')}` : ''}`
      : null;

  const [activeTab, setActiveTabState] = useState<SettingsTab>(() => resolveSettingsTab(searchParams.get('tab')));

  // Подключение
  const [connected, setConnected] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);
  const [availableConnections, setAvailableConnections] = useState<{ internal: boolean; external: boolean }>({ internal: false, external: false });
  const [error, setError] = useState('');

  // Фильтр синхронизации
  const [syncFilterCount, setSyncFilterCount] = useState<number | null>(null);

  useEffect(() => {
    sigurService.getSyncFilter()
      .then(filter => setSyncFilterCount(filter.length))
      .catch(() => setSyncFilterCount(null));
  }, []);

  const loadConnectionStatus = useCallback(async (): Promise<void> => {
    setChecking(true);
    try {
      const result = await sigurService.getConnectionStatus();
      setConnected(result.connected);
      if (result.connections) {
        setAvailableConnections(result.connections);
      }
    } catch {
      // Не показываем ложный "Нет связи" только потому, что стартовый status-fetch не удался.
    } finally {
      setChecking(false);
    }
  }, []);

  const checkConnection = useCallback(async (): Promise<boolean> => {
    setChecking(true);
    setError('');
    try {
      const result = await sigurService.testConnection('external');
      setConnected(result.success);
      if (result.connections) {
        setAvailableConnections(result.connections);
      }
      return result.success;
    } catch {
      setError('Не удалось проверить подключение');
      return false;
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void loadConnectionStatus();
  }, [loadConnectionStatus]);

  useEffect(() => {
    const tabFromQuery = resolveSettingsTab(searchParams.get('tab'));
    setActiveTabState(prev => (prev === tabFromQuery ? prev : tabFromQuery));
  }, [searchParams]);

  const setActiveTab = useCallback((tab: SettingsTab) => {
    setActiveTabState(tab);
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (tab === 'settings') next.delete('tab');
      else next.set('tab', tab);
      next.delete('sub');
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  if (legacyRedirect) {
    return <Navigate to={legacyRedirect} replace />;
  }

  const syncFilterSummary = syncFilterCount === null
    ? 'Фильтр отделов не загружен'
    : syncFilterCount === 0
      ? 'Фильтр синхронизации не задан: портальные sync-процессы работают со всеми отделами'
      : `Для портальных sync-процессов выбрано: ${syncFilterCount} отдел(ов)`;

  const tabFallback = (
    <div className="sigur-loading">
      Загрузка вкладки...
    </div>
  );

  return (
    <div className="sigur-page">
      <div className="sigur-header">
        <Settings size={24} />
        <h1>Настройки СКУД (Sigur)</h1>
      </div>

      <div className="sigur-tabs">
        <button
          className={`sigur-tab ${activeTab === 'settings' ? 'active' : ''}`}
          onClick={() => setActiveTab('settings')}
        >
          <Settings size={14} />
          Настройки
        </button>
        <button
          className={`sigur-tab ${activeTab === 'sync-filter' ? 'active' : ''}`}
          onClick={() => setActiveTab('sync-filter')}
        >
          <Filter size={14} />
          Синхронизация
        </button>
        <button
          className={`sigur-tab ${activeTab === 'access-points' ? 'active' : ''}`}
          onClick={() => setActiveTab('access-points')}
        >
          <MapPin size={14} />
          Точки доступа
        </button>
        <button
          className={`sigur-tab ${activeTab === 'objects' ? 'active' : ''}`}
          onClick={() => setActiveTab('objects')}
        >
          <Database size={14} />
          Объекты
        </button>
        <button
          className={`sigur-tab ${activeTab === 'travel-config' ? 'active' : ''}`}
          onClick={() => setActiveTab('travel-config')}
        >
          <MapPin size={14} />
          Лимит передвижения
        </button>
      </div>

      {error && (
        <div className="sigur-error">
          {error}
          <button onClick={() => setError('')}>×</button>
        </div>
      )}

      {activeTab === 'settings' && (
        <Suspense fallback={tabFallback}>
          <ConnectionSettingsTab
            connected={connected}
            checking={checking}
            availableConnections={availableConnections}
            canEdit={canEdit}
            error={error}
            setError={setError}
            checkConnection={checkConnection}
            setActiveTab={setActiveTab}
            syncFilterSummary={syncFilterSummary}
          />
        </Suspense>
      )}

      {activeTab === 'sync-filter' && (
        <Suspense fallback={tabFallback}>
          <SyncFilterTab
            connected={connected}
            canEdit={canEdit}
            onFilterCountChange={setSyncFilterCount}
          />
        </Suspense>
      )}

      {activeTab === 'access-points' && (
        <Suspense fallback={tabFallback}>
          <AccessPointsTab
            connected={connected}
            canEdit={canEdit}
            selectedConnection="external"
            setError={setError}
          />
        </Suspense>
      )}

      {activeTab === 'objects' && (
        <Suspense fallback={tabFallback}>
          <TravelObjectsTab
            canEdit={canEdit}
            selectedConnection="external"
            setError={setError}
          />
        </Suspense>
      )}

      {activeTab === 'travel-config' && (
        <Suspense fallback={tabFallback}>
          <TravelConfigTab
            canEdit={canEdit}
            setError={setError}
          />
        </Suspense>
      )}
    </div>
  );
};
