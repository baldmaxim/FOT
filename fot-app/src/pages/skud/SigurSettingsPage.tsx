import { useState, useEffect, useCallback } from 'react';
import { Settings, Wifi, WifiOff, RefreshCw, Eye, Download } from 'lucide-react';
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

  // Синхронизация
  const [syncStartDate, setSyncStartDate] = useState('');
  const [syncEndDate, setSyncEndDate] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<ISyncResult | null>(null);

  // Инициализация дат текущим месяцем
  useEffect(() => {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth() + 1;
    const mStr = String(m).padStart(2, '0');
    const lastDay = new Date(y, m, 0).getDate();
    const start = `${y}-${mStr}-01`;
    const end = `${y}-${mStr}-${lastDay}`;
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
      const data = await sigurService.preview(startTime, endTime);
      setPreviewData(data);
    } catch {
      setError('Ошибка загрузки данных предпросмотра');
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleSync = async () => {
    if (!syncStartDate || !syncEndDate) return;
    setSyncing(true);
    setSyncResult(null);
    setError('');
    try {
      const result = await sigurService.sync(syncStartDate, syncEndDate);
      setSyncResult(result);
    } catch {
      setError('Ошибка синхронизации');
    } finally {
      setSyncing(false);
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

      {/* Секция 2: Предпросмотр */}
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

      {/* Секция 3: Синхронизация */}
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
