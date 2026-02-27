import { useState, useEffect, useCallback, useMemo } from 'react';
import { Settings, Wifi, WifiOff, RefreshCw, Eye, Download, Search, Save, Check, MapPin, Filter, Trash2 } from 'lucide-react';
import { SyncFilterTab } from '../../components/skud/SyncFilterTab';
import { sigurService } from '../../services/sigurService';
import { skudService } from '../../services/skudService';
import { useAuth } from '../../contexts/AuthContext';
import type { IAccessPointSetting } from '../../types';
import '../../styles/SigurSettingsPage.css';

interface ISyncResult {
  imported: number;
  skipped: number;
  matched: number;
  errors: string[];
  sigurTotal: number;
  droppedNoName?: number;
  droppedNoOrg?: number;
  filteredByDept?: number;
}

interface IPreviewData {
  data: Record<string, unknown>[];
  sampleFields: string[];
  totalFetched: number;
  mappedCount?: number;
}

interface ISyncAllStep {
  id: number;
  name: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'error';
  result?: Record<string, unknown>;
  error?: string;
}

const FIELD_LABELS: Record<string, string> = {
  physicalPerson: 'ФИО',
  eventDate: 'Дата',
  eventTime: 'Время',
  direction: 'Направление',
  accessPoint: 'Точка доступа',
  cardNumber: 'Карта',
  department: 'Отдел',
  blocked: 'Заблокирован',
};

const DIRECTION_LABELS: Record<string, string> = {
  entry: 'Вход',
  exit: 'Выход',
};

const INITIAL_STEPS: ISyncAllStep[] = [
  { id: 1, name: 'organizations', label: 'Организации', status: 'pending' },
  { id: 2, name: 'clean-duplicates', label: 'Очистка дублей', status: 'pending' },
  { id: 3, name: 'departments', label: 'Отделы (иерархия)', status: 'pending' },
  { id: 4, name: 'positions', label: 'Должности', status: 'pending' },
  { id: 5, name: 'employees', label: 'Сотрудники', status: 'pending' },
];

const renderStepResult = (name: string, result: Record<string, unknown>) => {
  let text = '';
  switch (name) {
    case 'organizations':
      text = `Импорт: ${result.imported}, пропущено: ${result.skipped}`;
      break;
    case 'clean-duplicates':
      text = `Удалено дублей: ${result.duplicatesRemoved}`;
      break;
    case 'departments':
      text = `Новых: ${result.imported}, обновлено: ${result.updated}, связей: ${result.parentLinksSet}`;
      if (result.filtered) text += `, отфильтровано: ${result.filtered}`;
      break;
    case 'positions':
      text = `Из Sigur: ${result.imported}, обновлено: ${result.updated}, seed: ${result.seeded ?? 0}`;
      break;
    case 'employees':
      text = `Импорт: ${result.imported}, обновлено: ${result.updated}, пропущено: ${result.skipped}`;
      break;
    default:
      text = JSON.stringify(result);
  }
  const errors = result.errors as string[] | undefined;
  if (errors && errors.length > 0) {
    text += ` | Ошибки: ${errors.length}`;
  }
  return text;
};

type SettingsTab = 'settings' | 'access-points' | 'sync-filter';

export const SigurSettingsPage = () => {
  const { hasPosition } = useAuth();
  const canEdit = hasPosition('manager') || hasPosition('owner') || hasPosition('super_admin');

  const [activeTab, setActiveTab] = useState<SettingsTab>('settings');

  // Подключение
  const [connected, setConnected] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);
  const [connectionType, setConnectionType] = useState('');
  const [error, setError] = useState('');

  // Полная синхронизация структуры
  const [syncAllRunning, setSyncAllRunning] = useState(false);
  const [syncAllSteps, setSyncAllSteps] = useState<ISyncAllStep[]>(INITIAL_STEPS);
  const [syncAllDone, setSyncAllDone] = useState(false);

  // Предпросмотр
  const [previewData, setPreviewData] = useState<IPreviewData | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewStart, setPreviewStart] = useState('');
  const [previewEnd, setPreviewEnd] = useState('');

  // Discover
  const [discovering, setDiscovering] = useState(false);
  const [discoverData, setDiscoverData] = useState<Record<string, unknown> | null>(null);

  // Синхронизация событий
  const [syncStartDate, setSyncStartDate] = useState('');
  const [syncEndDate, setSyncEndDate] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<ISyncResult | null>(null);
  const [syncProgress, setSyncProgress] = useState<{ percent: number; day: string; message: string } | null>(null);
  const [clearing, setClearing] = useState(false);
  const [clearResult, setClearResult] = useState<{ deleted: number } | null>(null);

  // Точки доступа
  const [accessPoints, setAccessPoints] = useState<string[]>([]);
  const [apLoading, setApLoading] = useState(false);
  const [apSettings, setApSettings] = useState<Map<string, boolean>>(new Map());
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [apSearch, setApSearch] = useState('');

  // Инициализация дат текущим месяцем
  useEffect(() => {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth() + 1;
    const mStr = String(m).padStart(2, '0');
    const dStr = String(now.getDate()).padStart(2, '0');
    const start = `${y}-${mStr}-01`;
    const end = `${y}-${mStr}-${dStr}`;
    setSyncStartDate(start);
    setSyncEndDate(end);
    setPreviewStart(start);
    setPreviewEnd(end);
  }, []);

  // Загрузка точек доступа и общих настроек (независимо)
  useEffect(() => {
    setApLoading(true);
    skudService.getAccessPoints()
      .then(setAccessPoints)
      .catch(() => {})
      .finally(() => setApLoading(false));

    skudService.getAccessPointSettings()
      .then(settings => {
        const map = new Map<string, boolean>();
        for (const s of settings) {
          map.set(s.access_point_name, s.is_internal);
        }
        setApSettings(map);
      })
      .catch(() => {});
  }, []);

  const filteredAccessPoints = useMemo(() => {
    if (!apSearch.trim()) return accessPoints;
    const q = apSearch.toLowerCase();
    return accessPoints.filter(ap => ap.toLowerCase().includes(q));
  }, [accessPoints, apSearch]);

  const toggleApInternal = (apName: string) => {
    setApSettings(prev => {
      const next = new Map(prev);
      next.set(apName, !next.get(apName));
      return next;
    });
    setSettingsSaved(false);
  };

  const handleSaveApSettings = async () => {
    setSavingSettings(true);
    try {
      const settings: IAccessPointSetting[] = accessPoints.map(ap => ({
        access_point_name: ap,
        is_internal: apSettings.get(ap) || false,
      }));
      await skudService.saveAccessPointSettings(settings);
      setSettingsSaved(true);
      setTimeout(() => setSettingsSaved(false), 3000);
    } catch {
      setError('Ошибка сохранения настроек');
    } finally {
      setSavingSettings(false);
    }
  };

  const checkConnection = useCallback(async () => {
    setChecking(true);
    setError('');
    try {
      const result = await sigurService.testConnection();
      setConnected(result.success);
      setConnectionType(result.connection || '');
    } catch {
      setConnected(false);
      setError('Не удалось проверить подключение');
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    checkConnection();
  }, [checkConnection]);

  const handleSyncAll = async () => {
    setSyncAllRunning(true);
    setSyncAllDone(false);
    setError('');
    setSyncAllSteps(INITIAL_STEPS.map(s => ({ ...s, status: 'pending', result: undefined, error: undefined })));

    try {
      const token = localStorage.getItem('access_token');
      const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';
      const response = await fetch(`${apiUrl}/sigur/sync-all`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({}),
      });

      if (!response.ok || !response.body) {
        throw new Error('Ошибка синхронизации');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'step') {
              setSyncAllSteps(prev => prev.map(s =>
                s.id === data.step
                  ? { ...s, status: data.status, result: data.result, error: data.error }
                  : s
              ));
            } else if (data.type === 'done') {
              setSyncAllDone(true);
            } else if (data.type === 'error') {
              setError(data.message);
            }
          } catch { /* skip parse errors */ }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка синхронизации');
    } finally {
      setSyncAllRunning(false);
    }
  };

  const handlePreview = async () => {
    if (!previewStart || !previewEnd) return;
    setPreviewLoading(true);
    setError('');
    try {
      const startTime = `${previewStart}T00:00:00`;
      const endTime = `${previewEnd}T23:59:59`;
      const data = await sigurService.preview(startTime, endTime);
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

  const handleSync = async () => {
    if (!syncStartDate || !syncEndDate) return;
    setSyncing(true);
    setSyncResult(null);
    setSyncProgress(null);
    setError('');
    try {
      const token = localStorage.getItem('access_token');
      const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';
      const response = await fetch(`${apiUrl}/sigur/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ startDate: syncStartDate, endDate: syncEndDate }),
      });

      if (!response.ok || !response.body) {
        throw new Error('Ошибка синхронизации');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'day_start' || data.type === 'day_done') {
              setSyncProgress({
                percent: data.percent || 0,
                day: data.day || '',
                message: data.type === 'day_start'
                  ? `Загрузка ${data.day}...`
                  : `${data.day}: +${data.inserted ?? 0}`,
              });
            } else if (data.type === 'status') {
              setSyncProgress(prev => ({ ...prev, percent: prev?.percent || 0, day: '', message: data.message }));
            } else if (data.type === 'done') {
              setSyncResult(data as ISyncResult);
              setSyncProgress(null);
            } else if (data.type === 'error') {
              setError(data.message);
            }
          } catch { /* skip parse errors */ }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка синхронизации');
    } finally {
      setSyncing(false);
      setSyncProgress(null);
    }
  };

  const handleClearEvents = async () => {
    if (!syncStartDate || !syncEndDate) return;
    if (!confirm(`Удалить все события с ${syncStartDate} по ${syncEndDate}?`)) return;
    setClearing(true);
    setClearResult(null);
    setSyncResult(null);
    setError('');
    try {
      const result = await sigurService.clearEvents(syncStartDate, syncEndDate);
      setClearResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка удаления событий');
    } finally {
      setClearing(false);
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

      {activeTab === 'settings' && <>
      {/* Секция 1: Подключение */}
      <div className="sigur-section">
        <h2 className="sigur-section-title">
          {connected ? <Wifi size={18} /> : <WifiOff size={18} />}
          Подключение к Sigur
        </h2>
        <div className="sigur-connection-row">
          {statusBadge()}
          {connectionType && (
            <span className="sigur-conn-type">{connectionType}</span>
          )}
          <button
            className="sigur-btn"
            onClick={checkConnection}
            disabled={checking}
          >
            <RefreshCw size={14} />
            Проверить
          </button>
        </div>
      </div>

      {/* Секция 2: Полная синхронизация структуры */}
      <div className="sigur-section">
        <h2 className="sigur-section-title">
          <RefreshCw size={18} />
          Полная синхронизация структуры
        </h2>
        <div className="sigur-connection-row">
          <button
            className="sigur-btn sigur-btn-primary"
            onClick={handleSyncAll}
            disabled={syncAllRunning || !connected}
          >
            <RefreshCw size={14} className={syncAllRunning ? 'sigur-spin' : ''} />
            {syncAllRunning ? 'Синхронизация...' : 'Полная синхронизация'}
          </button>
        </div>

        {(syncAllRunning || syncAllDone) && (
          <div className="sigur-stepper">
            {syncAllSteps.map(step => (
              <div key={step.id} className={`sigur-step sigur-step--${step.status}`}>
                <div className="sigur-step-indicator">
                  {step.status === 'done' && <span>&#10003;</span>}
                  {step.status === 'running' && <span className="sigur-step-spinner" />}
                  {step.status === 'error' && <span>&#10007;</span>}
                  {step.status === 'pending' && <span className="sigur-step-number">{step.id}</span>}
                </div>
                <div className="sigur-step-content">
                  <div className="sigur-step-label">{step.label}</div>
                  {step.status === 'running' && (
                    <div className="sigur-step-status">Выполняется...</div>
                  )}
                  {step.status === 'done' && step.result && (
                    <div className="sigur-step-result">
                      {renderStepResult(step.name, step.result)}
                      {(step.result.errors as string[] | undefined)?.length ? (
                        <details className="sigur-step-errors-detail">
                          <summary>Ошибки ({(step.result.errors as string[]).length})</summary>
                          <ul>
                            {(step.result.errors as string[]).slice(0, 20).map((e, i) => <li key={i}>{e}</li>)}
                            {(step.result.errors as string[]).length > 20 && <li>...и ещё {(step.result.errors as string[]).length - 20}</li>}
                          </ul>
                        </details>
                      ) : null}
                    </div>
                  )}
                  {step.status === 'error' && step.error && (
                    <div className="sigur-step-error">{step.error}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

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
      <div className="sigur-section">
        <h2 className="sigur-section-title">
          <Download size={18} />
          Синхронизация событий в базу
        </h2>
        <div className="sigur-sync-controls">
          <label>
            С:
            <input
              type="date"
              value={syncStartDate}
              onChange={e => setSyncStartDate(e.target.value)}
            />
          </label>
          <label>
            По:
            <input
              type="date"
              value={syncEndDate}
              onChange={e => setSyncEndDate(e.target.value)}
            />
          </label>
          <button
            className="sigur-btn sigur-btn-primary"
            onClick={handleSync}
            disabled={syncing || clearing || !connected || !syncStartDate || !syncEndDate}
          >
            <Download size={14} />
            {syncing ? 'Синхронизация...' : 'Синхронизировать'}
          </button>
          <button
            className="sigur-btn sigur-btn-danger"
            onClick={handleClearEvents}
            disabled={syncing || clearing || !syncStartDate || !syncEndDate}
          >
            <Trash2 size={14} />
            {clearing ? 'Удаление...' : 'Очистить события'}
          </button>
        </div>

        {syncProgress && (
          <div className="sigur-progress">
            <div className="sigur-progress-bar">
              <div className="sigur-progress-fill" style={{ width: `${syncProgress.percent}%` }} />
            </div>
            <div className="sigur-progress-text">
              {syncProgress.percent}% — {syncProgress.message}
            </div>
          </div>
        )}

        {syncResult && (
          <div className="sigur-sync-result">
            <div className="sigur-sync-stats">
              <span className="sigur-sync-stat">Всего в Sigur: <strong>{syncResult.sigurTotal}</strong></span>
              <span className="sigur-sync-stat success">Импортировано: <strong>{syncResult.imported}</strong></span>
              <span className="sigur-sync-stat skipped">Пропущено: <strong>{syncResult.skipped}</strong></span>
              {!!syncResult.droppedNoName && (
                <span className="sigur-sync-stat skipped">Без ФИО: <strong>{syncResult.droppedNoName}</strong></span>
              )}
              {!!syncResult.droppedNoOrg && (
                <span className="sigur-sync-stat skipped">Без организации: <strong>{syncResult.droppedNoOrg}</strong></span>
              )}
              {!!syncResult.filteredByDept && (
                <span className="sigur-sync-stat skipped">Отфильтровано (отдел): <strong>{syncResult.filteredByDept}</strong></span>
              )}
              <span className="sigur-sync-stat">Сопоставлено: <strong>{syncResult.matched}</strong></span>
            </div>
            {syncResult.errors.length > 0 && (
              <details className="sigur-sync-errors">
                <summary>Ошибки ({syncResult.errors.length})</summary>
                <ul>
                  {syncResult.errors.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              </details>
            )}
          </div>
        )}

        {clearResult && (
          <div className="sigur-sync-result">
            <div className="sigur-sync-stats">
              <span className="sigur-sync-stat success">Удалено событий: <strong>{clearResult.deleted}</strong></span>
            </div>
          </div>
        )}
      </div>
      </>}

      {activeTab === 'sync-filter' && (
        <SyncFilterTab connected={connected} canEdit={canEdit} />
      )}

      {activeTab === 'access-points' && (
      <div className="sigur-section sigur-section--full-height">
        <div className="sigur-ap-toolbar">
          <div className="sigur-ap-search-wrap">
            <Search size={14} />
            <input
              type="text"
              placeholder="Поиск точки доступа..."
              value={apSearch}
              onChange={e => setApSearch(e.target.value)}
            />
          </div>
          {canEdit && (
            <button
              className={`sigur-btn sigur-btn-primary ${settingsSaved ? 'sigur-btn-saved' : ''}`}
              onClick={handleSaveApSettings}
              disabled={savingSettings}
            >
              {settingsSaved ? <><Check size={14} /> Сохранено</> : <><Save size={14} /> Сохранить</>}
            </button>
          )}
        </div>

        {apLoading ? (
          <div style={{ textAlign: 'center', padding: '1rem', color: 'var(--text-tertiary)', fontSize: '0.8125rem' }}>
            Загрузка точек доступа...
          </div>
        ) : accessPoints.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '1rem', color: 'var(--text-tertiary)', fontSize: '0.8125rem' }}>
            Нет точек доступа
          </div>
        ) : (
          <div className="sigur-preview-table-wrap">
            <table className="sigur-preview-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Точка доступа</th>
                  <th>Тип зоны</th>
                </tr>
              </thead>
              <tbody>
                {filteredAccessPoints.map((ap, idx) => {
                  const isInternal = apSettings.get(ap) || false;
                  return (
                    <tr key={ap}>
                      <td style={{ width: 40, textAlign: 'center', color: 'var(--text-tertiary)' }}>{idx + 1}</td>
                      <td>{ap}</td>
                      <td>
                        {canEdit ? (
                          <button
                            className={`sigur-ap-type-btn ${isInternal ? 'internal' : 'external'}`}
                            onClick={() => toggleApInternal(ap)}
                          >
                            {isInternal ? 'Внутренняя' : 'Внешняя'}
                          </button>
                        ) : (
                          <span className={`sigur-ap-type-label ${isInternal ? 'internal' : 'external'}`}>
                            {isInternal ? 'Внутренняя' : 'Внешняя'}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      )}
    </div>
  );
};
