import { Suspense, lazy, useState, useEffect, useCallback } from 'react';
import { Settings, MapPin, Filter, Database } from 'lucide-react';
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
const TravelRoutesTab = lazy(() => import('../../components/skud/TravelRoutesTab').then(module => ({
  default: module.TravelRoutesTab,
})));

const SIGUR_CONNECTION_STORAGE_KEY = 'sigur_selected_connection';

export const SigurSettingsPage = () => {
  const { canEditPage } = useAuth();
  const canEdit = canEditPage('/skud-settings');

  const [activeTab, setActiveTab] = useState<SettingsTab>('settings');

  // Подключение
  const [connected, setConnected] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);
  const [selectedConnection, setSelectedConnection] = useState<'internal' | 'external'>(() => {
    const saved = localStorage.getItem(SIGUR_CONNECTION_STORAGE_KEY);
    return saved === 'internal' || saved === 'external' ? saved : 'external';
  });
  const [availableConnections, setAvailableConnections] = useState<{ internal: boolean; external: boolean }>({ internal: false, external: false });
  const [error, setError] = useState('');

  // Фильтр синхронизации
  const [syncFilterCount, setSyncFilterCount] = useState<number | null>(null);

  useEffect(() => {
    sigurService.getSyncFilter()
      .then(filter => setSyncFilterCount(filter.length))
      .catch(() => setSyncFilterCount(null));
  }, []);

  useEffect(() => {
    localStorage.setItem(SIGUR_CONNECTION_STORAGE_KEY, selectedConnection);
  }, [selectedConnection]);

  const checkConnection = useCallback(async (connType?: 'internal' | 'external') => {
    setChecking(true);
    setError('');
    try {
      const result = await sigurService.testConnection(connType ?? selectedConnection);
      setConnected(result.success);
      if (result.connections) {
        setAvailableConnections(result.connections);
      }
    } catch {
      setConnected(false);
      setError('Не удалось проверить подключение');
    } finally {
      setChecking(false);
    }
  }, [selectedConnection]);

  useEffect(() => {
    checkConnection();
  }, [checkConnection]);

  const syncFilterSummary = syncFilterCount === null
    ? 'Фильтр отделов не загружен'
    : syncFilterCount === 0
      ? 'Фильтр не задан: синхронизация затронет все отделы'
      : `Активен фильтр: ${syncFilterCount} отдел(ов)`;

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
          className={`sigur-tab ${activeTab === 'routes' ? 'active' : ''}`}
          onClick={() => setActiveTab('routes')}
        >
          <MapPin size={14} />
          Маршруты
        </button>
        <button
          className={`sigur-tab ${activeTab === 'sync-filter' ? 'active' : ''}`}
          onClick={() => setActiveTab('sync-filter')}
        >
          <Filter size={14} />
          Синхронизация
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
            selectedConnection={selectedConnection}
            availableConnections={availableConnections}
            canEdit={canEdit}
            error={error}
            setError={setError}
            setSelectedConnection={setSelectedConnection}
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
            selectedConnection={selectedConnection}
            setError={setError}
          />
        </Suspense>
      )}

      {activeTab === 'objects' && (
        <Suspense fallback={tabFallback}>
          <TravelObjectsTab
            canEdit={canEdit}
            selectedConnection={selectedConnection}
            setError={setError}
          />
        </Suspense>
      )}

      {activeTab === 'routes' && (
        <Suspense fallback={tabFallback}>
          <TravelRoutesTab
            canEdit={canEdit}
            setError={setError}
          />
        </Suspense>
      )}
    </div>
  );
};
