import { useMemo, useState } from 'react';
import { AlertTriangle, Copy, RefreshCw } from 'lucide-react';
import { type ISigurHealthCheck, type SigurHealthCheckFilter } from '../../services/sigurMonitorService';
import { useSkudMonitorLogs } from '../../hooks/useSkudOpsData';
import { useToast } from '../../contexts/ToastContext';
import '../../styles/SkudMonitorPage.css';

const formatDateTime = (value: string): string => new Date(value).toLocaleString('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const sourceLabel: Record<ISigurHealthCheck['source'], string> = {
  presence_polling: 'Polling',
  monitor_probe: 'Probe',
  silence_detector: 'Silence',
};

const checkStatusLabel: Record<ISigurHealthCheck['status'], string> = {
  success: 'Успех',
  failure: 'Ошибка',
  silence: 'Тишина',
};

const checkStatusDescription: Record<ISigurHealthCheck['status'], string> = {
  success: 'Проверка завершилась успешно',
  failure: 'Мониторинг поймал ошибку канала',
  silence: 'Поток событий пропал в рабочем окне',
};

const EMPTY_LOGS: ISigurHealthCheck[] = [];

const formatJson = (value: unknown): string => JSON.stringify(value, null, 2);

const copyTextToClipboard = async (value: string): Promise<void> => {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  if (typeof document === 'undefined') {
    throw new Error('Clipboard is not available');
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const copied = document.execCommand('copy');
  document.body.removeChild(textarea);

  if (!copied) {
    throw new Error('Copy failed');
  }
};

export const SkudMonitorPage = () => {
  const [refreshing, setRefreshing] = useState(false);
  const [copyingDiagnostics, setCopyingDiagnostics] = useState(false);
  const [checkFilter, setCheckFilter] = useState<SigurHealthCheckFilter>('all');
  const toast = useToast();
  const logsQuery = useSkudMonitorLogs(checkFilter);
  const logs = logsQuery.data?.data ?? EMPTY_LOGS;
  const logsTotal = logsQuery.data?.pagination.total ?? logs.length;
  const error = logsQuery.error instanceof Error ? logsQuery.error.message : null;

  const diagnosticPayload = useMemo(() => ({
    exportedAt: new Date().toISOString(),
    page: 'skud-monitor',
    filter: checkFilter,
    logsTotal,
    logs,
  }), [checkFilter, logs, logsTotal]);

  const diagnosticJson = useMemo(() => formatJson(diagnosticPayload), [diagnosticPayload]);

  const refresh = async () => {
    try {
      setRefreshing(true);
      await logsQuery.refetch();
    } finally {
      setRefreshing(false);
    }
  };

  const handleCopyDiagnostics = async () => {
    try {
      setCopyingDiagnostics(true);
      await copyTextToClipboard(diagnosticJson);
      toast.success('JSON логов скопирован');
    } catch {
      toast.error('Не удалось скопировать JSON логов');
    } finally {
      setCopyingDiagnostics(false);
    }
  };

  if (logsQuery.isLoading && !logsQuery.data) {
    return <div className="skud-monitor-loading">Загрузка логов Sigur...</div>;
  }

  return (
    <div className="skud-monitor">
      <div className="skud-monitor-header">
        <div>
          <h1>Монитор Sigur</h1>
          <p>Последние 20 логов мониторинга и экспорт JSON для отправки в чат.</p>
        </div>

        <div className="skud-monitor-actions">
          <button
            type="button"
            className="skud-monitor-action"
            onClick={() => void refresh()}
            disabled={refreshing}
          >
            <RefreshCw size={16} className={refreshing ? 'spinning' : ''} />
            Обновить
          </button>

          <button
            type="button"
            className="skud-monitor-action primary"
            onClick={() => void handleCopyDiagnostics()}
            disabled={copyingDiagnostics}
          >
            <Copy size={16} />
            {copyingDiagnostics ? 'Копируем...' : 'Копировать JSON'}
          </button>
        </div>
      </div>

      {error && (
        <div className="skud-monitor-error">
          <AlertTriangle size={16} />
          <span>{error}</span>
        </div>
      )}

      <section className="skud-monitor-panel">
        <div className="skud-monitor-panel-header">
          <div>
            <h2>Логи</h2>
            <p className="skud-monitor-panel-subtitle">
              Показаны последние 20 записей мониторинга по выбранному фильтру.
            </p>
          </div>

          <select value={checkFilter} onChange={e => setCheckFilter(e.target.value as SigurHealthCheckFilter)}>
            <option value="all">Все</option>
            <option value="success">Успех</option>
            <option value="failure">Ошибка</option>
            <option value="silence">Тишина</option>
          </select>
        </div>

        <div className="skud-monitor-log-list">
          {logs.length === 0 && <div className="skud-monitor-empty">Логов пока нет</div>}

          {logs.map(log => (
            <article key={log.id} className={`skud-monitor-log ${log.status}`}>
              <div className="skud-monitor-log-top">
                <div className="skud-monitor-log-heading">
                  <span className={`badge ${log.status}`}>{checkStatusLabel[log.status]}</span>
                  <strong>{sourceLabel[log.source]}</strong>
                </div>
                <time className="skud-monitor-log-time">{formatDateTime(log.checked_at)}</time>
              </div>

              <div className="skud-monitor-log-description">
                {checkStatusDescription[log.status]}
              </div>

              <div className="skud-monitor-log-metrics">
                <span>Подключение: <strong>{log.connection_type || '—'}</strong></span>
                <span>Ответ: <strong>{log.response_ms != null ? `${log.response_ms} мс` : '—'}</strong></span>
                <span>События: <strong>{log.events_last_window ?? '—'}</strong></span>
                <span>Baseline: <strong>{log.baseline_events ?? '—'}</strong></span>
                <span>Ошибки подряд: <strong>{log.consecutive_failures}</strong></span>
              </div>

              <div className={`skud-monitor-log-error ${log.error_message ? 'has-error' : ''}`}>
                {log.error_message || 'Ошибок нет'}
              </div>

              <details className="skud-monitor-log-json">
                <summary>Raw JSON лога</summary>
                <pre>{formatJson(log)}</pre>
              </details>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
};
