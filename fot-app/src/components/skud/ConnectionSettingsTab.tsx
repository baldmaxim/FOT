import { useState, useEffect } from 'react';
import type { FC } from 'react';
import { Wifi, WifiOff, RefreshCw, Eye, Search } from 'lucide-react';
import { sigurService } from '../../services/sigurService';
import type { IPreviewData, SettingsTab } from './sigur-settings.types';
import { FIELD_LABELS, DIRECTION_LABELS } from './sigur-settings.utils';
import { StructureSyncSection } from './StructureSyncSection';
import { EventsSyncSection } from './EventsSyncSection';

interface IConnectionSettingsTabProps {
  connected: boolean | null;
  checking: boolean;
  selectedConnection: 'internal' | 'external';
  availableConnections: { internal: boolean; external: boolean };
  canEdit: boolean;
  organizationId: string | undefined;
  error: string;
  setError: (error: string) => void;
  setSelectedConnection: (conn: 'internal' | 'external') => void;
  checkConnection: (connType?: 'internal' | 'external') => void;
  setActiveTab: (tab: SettingsTab) => void;
  syncFilterSummary: string;
}

export const ConnectionSettingsTab: FC<IConnectionSettingsTabProps> = ({
  connected,
  checking,
  selectedConnection,
  availableConnections,
  canEdit,
  organizationId,
  setError,
  setSelectedConnection,
  checkConnection,
  setActiveTab,
  syncFilterSummary,
}) => {
  // Предпросмотр
  const [previewData, setPreviewData] = useState<IPreviewData | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewStart, setPreviewStart] = useState('');
  const [previewEnd, setPreviewEnd] = useState('');
  const [previewDepartment, setPreviewDepartment] = useState('');
  const [departments, setDepartments] = useState<{ id: number; name: string }[]>([]);

  // Discover
  const [discovering, setDiscovering] = useState(false);
  const [discoverData, setDiscoverData] = useState<Record<string, unknown> | null>(null);

  // Инициализация дат текущим месяцем
  useEffect(() => {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth() + 1;
    const mStr = String(m).padStart(2, '0');
    const dStr = String(now.getDate()).padStart(2, '0');
    setPreviewStart(`${y}-${mStr}-01`);
    setPreviewEnd(`${y}-${mStr}-${dStr}`);
  }, []);

  // Загрузка отделов из whitelist синхронизации
  useEffect(() => {
    if (!connected) return;
    sigurService.getSyncFilter()
      .then(items => {
        const depts = items.map(d => ({
          id: d.sigur_department_id,
          name: d.sigur_department_name,
        })).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
        setDepartments(depts);
      })
      .catch(() => { /* ignore */ });
  }, [connected]);

  const handlePreview = async () => {
    if (!previewStart || !previewEnd) return;
    setPreviewLoading(true);
    setError('');
    try {
      const startTime = `${previewStart}T00:00:00`;
      const endTime = `${previewEnd}T23:59:59`;
      const data = await sigurService.preview(startTime, endTime, previewDepartment || undefined);
      setPreviewData(data);
    } catch {
      setError('Ошибка загрузки данных предпросмотра');
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleDiscover = async () => {
    setDiscovering(true);
    setDiscoverData(null);
    setError('');
    try {
      const result = await sigurService.discover();
      setDiscoverData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка диагностики API');
    } finally {
      setDiscovering(false);
    }
  };

  const statusBadge = () => {
    if (checking) {
      return <span className="sigur-status-badge checking"><span className="sigur-status-dot" />Проверка...</span>;
    }
    if (connected) {
      return <span className="sigur-status-badge connected"><span className="sigur-status-dot" />Подключено</span>;
    }
    if (connected === false) {
      return <span className="sigur-status-badge disconnected"><span className="sigur-status-dot" />Нет связи</span>;
    }
    return null;
  };

  return (
    <>
      {/* Секция 1: Подключение */}
      <div className="sigur-section">
        <h2 className="sigur-section-title">
          {connected ? <Wifi size={18} /> : <WifiOff size={18} />}
          Подключение к Sigur
        </h2>
        <div className="sigur-connection-row">
          {statusBadge()}
          <div className="sigur-conn-toggle">
            <button
              className={`sigur-conn-toggle-btn ${selectedConnection === 'internal' ? 'active' : ''}`}
              onClick={() => { setSelectedConnection('internal'); checkConnection('internal'); }}
              disabled={checking || !availableConnections.internal}
              title={availableConnections.internal ? 'Локальная сеть' : 'Не настроено в .env'}
            >
              Internal
            </button>
            <button
              className={`sigur-conn-toggle-btn ${selectedConnection === 'external' ? 'active' : ''}`}
              onClick={() => { setSelectedConnection('external'); checkConnection('external'); }}
              disabled={checking || !availableConnections.external}
              title={availableConnections.external ? 'Внешний доступ' : 'Не настроено в .env'}
            >
              External
            </button>
          </div>
          <button
            className="sigur-btn"
            onClick={() => checkConnection()}
            disabled={checking}
          >
            <RefreshCw size={14} />
            Проверить
          </button>
        </div>
      </div>

      {/* Секция 2: Полная синхронизация структуры */}
      <StructureSyncSection
        connected={connected}
        canEdit={canEdit}
        organizationId={organizationId}
        setError={setError}
        setActiveTab={setActiveTab}
        syncFilterSummary={syncFilterSummary}
        externalBusy={false}
      />

      {/* Секция 3: Discover API */}
      <div className="sigur-section">
        <h2 className="sigur-section-title">
          <Search size={18} />
          Диагностика Sigur API
        </h2>
        <div className="sigur-connection-row">
          <button
            className="sigur-btn"
            onClick={handleDiscover}
            disabled={discovering || !connected}
          >
            <Search size={14} />
            {discovering ? 'Анализ...' : 'Discover API'}
          </button>
        </div>
        {discoverData && (
          <div className="sigur-sync-result">
            <pre style={{ fontSize: '0.7rem', maxHeight: 400, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {JSON.stringify(discoverData, null, 2)}
            </pre>
          </div>
        )}
      </div>

      {/* Секция 4: Предпросмотр */}
      <div className="sigur-section">
        <h2 className="sigur-section-title">
          <Eye size={18} />
          Предпросмотр данных
        </h2>
        <div className="sigur-preview-controls">
          <label>
            С:
            <input
              type="date"
              value={previewStart}
              onChange={e => setPreviewStart(e.target.value)}
            />
          </label>
          <label>
            По:
            <input
              type="date"
              value={previewEnd}
              onChange={e => setPreviewEnd(e.target.value)}
            />
          </label>
          <label>
            Отдел:
            <select
              value={previewDepartment}
              onChange={e => setPreviewDepartment(e.target.value)}
            >
              <option value="">Все отделы</option>
              {departments.map(d => (
                <option key={d.id} value={String(d.id)}>{d.name}</option>
              ))}
            </select>
          </label>
          <button
            className="sigur-btn"
            onClick={handlePreview}
            disabled={previewLoading || !connected || !previewStart || !previewEnd}
          >
            <Eye size={14} />
            {previewLoading ? 'Загрузка...' : 'Загрузить'}
          </button>
        </div>

        {previewData && (
          <>
            <div className="sigur-preview-info">
              Всего событий: {previewData.totalFetched} | Проходы (PASS): {previewData.mappedCount ?? previewData.data.length} | Показано: {previewData.data.length}
            </div>

            {previewData.data.length > 0 && (
              <div className="sigur-preview-table-wrap">
                <table className="sigur-preview-table">
                  <thead>
                    <tr>
                      {previewData.sampleFields.map(f => (
                        <th key={f}>{FIELD_LABELS[f] || f}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {previewData.data.map((row, i) => (
                      <tr key={i}>
                        {previewData.sampleFields.map(f => {
                          const val = row[f];
                          const display = f === 'direction' && typeof val === 'string'
                            ? (DIRECTION_LABELS[val] || val)
                            : f === 'eventDate' && typeof val === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(val)
                              ? val.split('-').reverse().join('.')
                              : f === 'blocked' && typeof val === 'boolean'
                                ? (val ? 'Да' : 'Нет')
                                : String(val ?? '—');
                          return (
                            <td key={f} title={display}>
                              {display}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>

      {/* Секция 5: Синхронизация событий */}
      <EventsSyncSection
        connected={connected}
        setError={setError}
        setActiveTab={setActiveTab}
        syncFilterSummary={syncFilterSummary}
        externalBusy={false}
      />
    </>
  );
};
