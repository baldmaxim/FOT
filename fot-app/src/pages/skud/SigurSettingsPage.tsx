import { Suspense, lazy, useState, useEffect, useCallback, type ComponentType } from 'react';
import { Settings, MapPin, Filter, Database, AlertCircle, HardDrive } from 'lucide-react';
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
const SkudFailuresTab = lazy(() => import('../../components/skud/SkudFailuresTab').then(module => ({
  default: module.SkudFailuresTab,
})));
const SkudDbTab = lazy(() => import('../../components/skud/SkudDbTab').then(module => ({
  default: module.SkudDbTab,
})));

const SETTINGS_TABS: SettingsTab[] = [
  'settings',
  'sync-filter',
  'access-points',
  'objects',
  'travel-config',
  'failures',
  'skud-db',
];

// Ключ /skud-settings/directory: только эти вкладки и только на чтение. Подключение,
// синхронизация, лимит и ошибочные события остаются за полным ключом /skud-settings.
const DIRECTORY_TABS: SettingsTab[] = ['access-points', 'objects', 'skud-db'];

const TAB_BUTTONS: Array<{ tab: SettingsTab; label: string; Icon: ComponentType<{ size?: number }> }> = [
  { tab: 'settings', label: 'Настройки', Icon: Settings },
  { tab: 'sync-filter', label: 'Синхронизация', Icon: Filter },
  { tab: 'access-points', label: 'Точки доступа', Icon: MapPin },
  { tab: 'objects', label: 'Объекты', Icon: Database },
  { tab: 'travel-config', label: 'Лимит передвижения', Icon: MapPin },
  { tab: 'failures', label: 'Ошибочные события', Icon: AlertCircle },
  { tab: 'skud-db', label: 'База', Icon: HardDrive },
];

const resolveSettingsTab = (value: string | null, allowed: SettingsTab[]): SettingsTab => (
  value && allowed.includes(value as SettingsTab)
    ? value as SettingsTab
    : allowed[0]
);

export const SigurSettingsPage = () => {
  const { canEditPage, canViewPage } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const canEdit = canEditPage('/skud-settings');
  const hasFullSettings = canViewPage('/skud-settings');
  const visibleTabs = hasFullSettings ? SETTINGS_TABS : DIRECTORY_TABS;

  const legacyTab = searchParams.get('tab');
  const legacyRedirect = legacyTab === 'employees'
    ? '/sigur'
    : legacyTab === 'sigur'
      ? `/sigur?view=settings${searchParams.get('sub') ? `&sub=${searchParams.get('sub')}` : ''}`
      : null;

  const [activeTab, setActiveTabState] = useState<SettingsTab>(() => resolveSettingsTab(searchParams.get('tab'), visibleTabs));

  // Подключение
  const [connected, setConnected] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);
  const [availableConnections, setAvailableConnections] = useState<{ internal: boolean; external: boolean }>({ internal: false, external: false });
  const [error, setError] = useState('');

  // Фильтр синхронизации
  const [syncFilterCount, setSyncFilterCount] = useState<number | null>(null);

  // Фильтр и статус подключения нужны только вкладкам полного раздела.
  useEffect(() => {
    if (!hasFullSettings) return;
    sigurService.getSyncFilter()
      .then(filter => setSyncFilterCount(filter.length))
      .catch(() => setSyncFilterCount(null));
  }, [hasFullSettings]);

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
    if (!hasFullSettings) return;
    void loadConnectionStatus();
  }, [hasFullSettings, loadConnectionStatus]);

  useEffect(() => {
    const tabFromQuery = resolveSettingsTab(searchParams.get('tab'), visibleTabs);
    setActiveTabState(prev => (prev === tabFromQuery ? prev : tabFromQuery));
  }, [searchParams, visibleTabs]);

  const setActiveTab = useCallback((tab: SettingsTab) => {
    setActiveTabState(tab);
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (tab === visibleTabs[0]) next.delete('tab');
      else next.set('tab', tab);
      next.delete('sub');
      return next;
    }, { replace: true });
  }, [setSearchParams, visibleTabs]);

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
      <div className="sigur-tabs">
        {TAB_BUTTONS.filter(({ tab }) => visibleTabs.includes(tab)).map(({ tab, label, Icon }) => (
          <button
            key={tab}
            className={`sigur-tab ${activeTab === tab ? 'active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
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

      {activeTab === 'failures' && (
        <Suspense fallback={tabFallback}>
          <SkudFailuresTab />
        </Suspense>
      )}

      {activeTab === 'skud-db' && (
        <Suspense fallback={tabFallback}>
          <SkudDbTab />
        </Suspense>
      )}
    </div>
  );
};
