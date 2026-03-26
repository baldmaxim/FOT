import { useState, useEffect, useCallback } from 'react';
import { Settings, MapPin, Filter, Database } from 'lucide-react';
import { ConnectionSettingsTab } from '../../components/skud/ConnectionSettingsTab';
import { AccessPointsTab } from '../../components/skud/AccessPointsTab';
import { SyncFilterTab } from '../../components/skud/SyncFilterTab';
import { sigurService } from '../../services/sigurService';
import { useAuth } from '../../contexts/AuthContext';
import type { SettingsTab } from '../../components/skud/sigur-settings.types';
import '../../styles/SigurSettingsPage.css';

export const SigurSettingsPage = () => {
  const { hasPosition, profile } = useAuth();
  const canEdit = hasPosition(['header', 'admin', 'super_admin']);

  const [activeTab, setActiveTab] = useState<SettingsTab>('settings');

  // Подключение
  const [connected, setConnected] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);
  const [selectedConnection, setSelectedConnection] = useState<'internal' | 'external'>('internal');
  const [availableConnections, setAvailableConnections] = useState<{ internal: boolean; external: boolean }>({ internal: false, external: false });
  const [error, setError] = useState('');

  // Фильтр синхронизации
  const [syncFilterCount, setSyncFilterCount] = useState<number | null>(null);

  useEffect(() => {
    sigurService.getSyncFilter()
      .then(filter => setSyncFilterCount(filter.length))
      .catch(() => setSyncFilterCount(null));
  }, []);

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

  return (
    <div className="sigur-page">
      <div className="sigur-header">
        <Settings size={24} />
        <h1>Настройки СКУД (Sigur)</h1>
        <a
          href={import.meta.env.VITE_SUPABASE_URL || '#'}
          target="_blank"
          rel="noopener noreferrer"
          className="sigur-btn sigur-btn-supabase"
        >
          <Database size={14} />
          Supabase
        </a>
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
        <ConnectionSettingsTab
          connected={connected}
          checking={checking}
          selectedConnection={selectedConnection}
          availableConnections={availableConnections}
          canEdit={canEdit}
          organizationId={profile?.organization_id || undefined}
          error={error}
          setError={setError}
          setSelectedConnection={setSelectedConnection}
          checkConnection={checkConnection}
          setActiveTab={setActiveTab}
          syncFilterSummary={syncFilterSummary}
        />
      )}

      {activeTab === 'sync-filter' && (
        <SyncFilterTab
          connected={connected}
          canEdit={canEdit}
          onFilterCountChange={setSyncFilterCount}
        />
      )}

      {activeTab === 'access-points' && (
        <AccessPointsTab
          connected={connected}
          canEdit={canEdit}
          setError={setError}
        />
      )}
    </div>
  );
};
