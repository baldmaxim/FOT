import { useState, useEffect, useCallback } from 'react';
import { Settings, Wifi, WifiOff, RefreshCw, Eye, Download, Building2, Users, Trash2 } from 'lucide-react';
import { sigurService } from '../../services/sigurService';
import '../../styles/SigurSettingsPage.css';

interface ISyncResult {
  imported: number;
  skipped: number;
  matched: number;
  errors: string[];
  sigurTotal: number;
}

interface IPreviewData {
  data: Record<string, unknown>[];
  sampleFields: string[];
  totalFetched: number;
  mappedCount?: number;
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

export const SigurSettingsPage = () => {
  // Подключение
  const [connected, setConnected] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);
  const [connectionType, setConnectionType] = useState('');
  const [error, setError] = useState('');

  // Предпросмотр
  const [previewData, setPreviewData] = useState<IPreviewData | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewStart, setPreviewStart] = useState('');
  const [previewEnd, setPreviewEnd] = useState('');

  // Организации
  const [syncingOrgs, setSyncingOrgs] = useState(false);
  const [orgResult, setOrgResult] = useState<{ imported: number; skipped: number; total: number } | null>(null);

  // Очистка дублей
  const [cleaningDups, setCleaningDups] = useState(false);
  const [dupResult, setDupResult] = useState<{ totalBefore: number; totalAfter: number; duplicatesRemoved: number } | null>(null);

  // Сотрудники
  const [syncingEmps, setSyncingEmps] = useState(false);
  const [empResult, setEmpResult] = useState<{ imported: number; skipped: number; total: number; errors: string[] } | null>(null);

  // Синхронизация
  const [syncStartDate, setSyncStartDate] = useState('');
  const [syncEndDate, setSyncEndDate] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<ISyncResult | null>(null);
  const [syncProgress, setSyncProgress] = useState<{ percent: number; day: string; message: string } | null>(null);

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

  // Проверяем подключение при загрузке
  useEffect(() => {
    checkConnection();
  }, [checkConnection]);

  const handlePreview = async () => {
    if (!previewStart || !previewEnd) return;
    setPreviewLoading(true);
    setError('');
    try {
      const startTime = `${previewStart}T00:00:00`;
      const endTime = `${previewEnd}T23:59:59`;
      console.log('[preview] calling with:', { startTime, endTime });
      const data = await sigurService.preview(startTime, endTime);
      console.log('[preview] result:', data);
      console.log('[preview] data.data:', data?.data);
      console.log('[preview] data.sampleFields:', data?.sampleFields);
      console.log('[preview] data.totalFetched:', data?.totalFetched);
      setPreviewData(data);
    } catch (err) {
      console.error('[preview] error:', err);
      setError('Ошибка загрузки данных предпросмотра');
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleSyncOrganizations = async () => {
    setSyncingOrgs(true);
    setOrgResult(null);
    setError('');
    try {
      const result = await sigurService.syncOrganizations();
      setOrgResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка импорта организаций');
    } finally {
      setSyncingOrgs(false);
    }
  };

  const handleCleanDuplicates = async () => {
    setCleaningDups(true);
    setDupResult(null);
    setError('');
    try {
      const result = await sigurService.cleanDuplicateOrganizations();
      setDupResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка очистки дублей');
    } finally {
      setCleaningDups(false);
    }
  };

  const handleSyncEmployees = async () => {
    setSyncingEmps(true);
    setEmpResult(null);
    setError('');
    try {
      const result = await sigurService.syncEmployees();
      setEmpResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка импорта сотрудников');
    } finally {
      setSyncingEmps(false);
    }
  };

  const handleSync = async () => {
    if (!syncStartDate || !syncEndDate) return;
    setSyncing(true);
    setSyncResult(null);
    setSyncProgress(null);
    setError('');
    try {
      const token = localStorage.getItem('token');
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

      {error && (
        <div className="sigur-error">
          {error}
          <button onClick={() => setError('')}>×</button>
        </div>
      )}

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

      {/* Секция 2: Организации */}
      <div className="sigur-section">
        <h2 className="sigur-section-title">
          <Building2 size={18} />
          Импорт организаций из Sigur
        </h2>
        <div className="sigur-connection-row">
          <button
            className="sigur-btn sigur-btn-primary"
            onClick={handleSyncOrganizations}
            disabled={syncingOrgs || !connected}
          >
            <Building2 size={14} />
            {syncingOrgs ? 'Импорт...' : 'Импортировать отделы как организации'}
          </button>
          <button
            className="sigur-btn"
            onClick={handleCleanDuplicates}
            disabled={cleaningDups}
          >
            <Trash2 size={14} />
            {cleaningDups ? 'Очистка...' : 'Удалить дубли организаций'}
          </button>
        </div>
        {orgResult && (
          <div className="sigur-sync-result">
            <div className="sigur-sync-stats">
              <span className="sigur-sync-stat">Всего отделов в Sigur: <strong>{orgResult.total}</strong></span>
              <span className="sigur-sync-stat success">Новых импортировано: <strong>{orgResult.imported}</strong></span>
              <span className="sigur-sync-stat skipped">Уже в базе: <strong>{orgResult.skipped}</strong></span>
            </div>
            {orgResult.imported === 0 && orgResult.skipped > 0 && (
              <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: '0.5rem' }}>
                Все отделы уже импортированы. Если видите дубли — нажмите «Удалить дубли организаций».
              </div>
            )}
          </div>
        )}
        {dupResult && (
          <div className="sigur-sync-result">
            <div className="sigur-sync-stats">
              <span className="sigur-sync-stat">Было: <strong>{dupResult.totalBefore}</strong></span>
              <span className="sigur-sync-stat success">Удалено дублей: <strong>{dupResult.duplicatesRemoved}</strong></span>
              <span className="sigur-sync-stat">Осталось: <strong>{dupResult.totalAfter}</strong></span>
            </div>
          </div>
        )}
      </div>

      {/* Секция 3: Сотрудники */}
      <div className="sigur-section">
        <h2 className="sigur-section-title">
          <Users size={18} />
          Импорт сотрудников из Sigur
        </h2>
        <div className="sigur-connection-row">
          <button
            className="sigur-btn sigur-btn-primary"
            onClick={handleSyncEmployees}
            disabled={syncingEmps || !connected}
          >
            <Users size={14} />
            {syncingEmps ? 'Импорт...' : 'Импортировать сотрудников'}
          </button>
        </div>
        {empResult && (
          <div className="sigur-sync-result">
            <div className="sigur-sync-stats">
              <span className="sigur-sync-stat">Всего в Sigur: <strong>{empResult.total}</strong></span>
              <span className="sigur-sync-stat success">Импортировано: <strong>{empResult.imported}</strong></span>
              <span className="sigur-sync-stat skipped">Пропущено: <strong>{empResult.skipped}</strong></span>
            </div>
            {empResult.errors.length > 0 && (
              <details className="sigur-sync-errors">
                <summary>Ошибки ({empResult.errors.length})</summary>
                <ul>
                  {empResult.errors.slice(0, 20).map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              </details>
            )}
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

      {/* Секция 4: Синхронизация */}
      <div className="sigur-section">
        <h2 className="sigur-section-title">
          <Download size={18} />
          Синхронизация в базу
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
            disabled={syncing || !connected || !syncStartDate || !syncEndDate}
          >
            <Download size={14} />
            {syncing ? 'Синхронизация...' : 'Синхронизировать'}
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
      </div>
    </div>
  );
};
