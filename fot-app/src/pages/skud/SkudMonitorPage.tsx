import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Activity, AlertTriangle, RefreshCw, ShieldAlert, Siren, Waves } from 'lucide-react';
import { type ISigurHealthCheck, type ISigurIncident } from '../../services/sigurMonitorService';
import { useSkudMonitorDashboard, useSkudMonitorIncident } from '../../hooks/useSkudOpsData';
import '../../styles/SkudMonitorPage.css';

const formatDateTime = (value: string | null): string => {
  if (!value) return '—';
  return new Date(value).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const formatDuration = (from: string | null, to: string | null): string => {
  if (!from) return '—';
  const start = new Date(from).getTime();
  const end = new Date(to || Date.now()).getTime();
  const diffMinutes = Math.max(0, Math.round((end - start) / 60_000));
  const hours = Math.floor(diffMinutes / 60);
  const minutes = diffMinutes % 60;

  if (hours === 0) return `${minutes} мин`;
  return `${hours} ч ${minutes} мин`;
};

const sourceLabel: Record<ISigurIncident['detected_by'], string> = {
  presence_polling: 'Polling',
  monitor_probe: 'Probe',
  silence_detector: 'Silence',
};

const checkStatusLabel: Record<ISigurHealthCheck['status'], string> = {
  success: 'Успех',
  failure: 'Ошибка',
  silence: 'Тишина',
};

const severityLabel: Record<ISigurIncident['severity'], string> = {
  critical: 'Критично',
  warning: 'Предупреждение',
};
const EMPTY_INCIDENTS: ISigurIncident[] = [];
const EMPTY_CHECKS: ISigurHealthCheck[] = [];

export const SkudMonitorPage = () => {
  const [refreshing, setRefreshing] = useState(false);
  const [selectedIncidentId, setSelectedIncidentId] = useState<number | null>(null);
  const [incidentFilter, setIncidentFilter] = useState<'all' | 'open' | 'resolved'>('all');
  const [checkFilter, setCheckFilter] = useState<'all' | 'success' | 'failure' | 'silence'>('all');
  const queryClient = useQueryClient();
  const dashboardQuery = useSkudMonitorDashboard(incidentFilter, checkFilter);
  const status = dashboardQuery.data?.status ?? null;
  const incidents = dashboardQuery.data?.incidents.data ?? EMPTY_INCIDENTS;
  const checks = dashboardQuery.data?.checks.data ?? EMPTY_CHECKS;
  const incidentDetailsQuery = useSkudMonitorIncident(selectedIncidentId);
  const incidentDetails = incidentDetailsQuery.data ?? null;
  const loading = dashboardQuery.isLoading;
  const error = dashboardQuery.error instanceof Error
    ? dashboardQuery.error.message
    : incidentDetailsQuery.error instanceof Error
      ? incidentDetailsQuery.error.message
      : null;

  useEffect(() => {
    if (!dashboardQuery.data) return;
    const nextSelected = incidents.some(incident => incident.id === selectedIncidentId)
      ? selectedIncidentId
      : (status?.activeIncident?.id ?? incidents[0]?.id ?? null);
    if (nextSelected !== selectedIncidentId) {
      setSelectedIncidentId(nextSelected);
    }
  }, [dashboardQuery.data, incidents, selectedIncidentId, status?.activeIncident?.id]);

  const refresh = async (withSpinner = false) => {
    try {
      if (withSpinner) setRefreshing(true);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['skud-monitor'] }),
        queryClient.invalidateQueries({ queryKey: ['skud-monitor', 'incident'] }),
      ]);
    } finally {
      setRefreshing(false);
    }
  };

  const summaryCards = useMemo(() => {
    return [
      {
        label: 'Текущий статус',
        value: status?.currentStatus === 'disabled'
          ? 'Выключен'
          : status?.currentStatus === 'incident_open'
            ? 'Инцидент'
            : 'Норма',
        tone: status?.currentStatus === 'incident_open' ? 'danger' : (status?.currentStatus === 'disabled' ? 'muted' : 'ok'),
        icon: status?.currentStatus === 'incident_open' ? <ShieldAlert size={18} /> : <Activity size={18} />,
      },
      {
        label: 'Последний сигнал',
        value: formatDateTime(status?.lastSignalAt || null),
        tone: 'default',
        icon: <Activity size={18} />,
      },
      {
        label: 'Последний поток событий',
        value: formatDateTime(status?.lastEventFlowAt || null),
        tone: 'default',
        icon: <Waves size={18} />,
      },
      {
        label: 'Ошибок подряд',
        value: String(status?.consecutiveFailures ?? 0),
        tone: (status?.consecutiveFailures || 0) > 0 ? 'danger' : 'ok',
        icon: <AlertTriangle size={18} />,
      },
    ];
  }, [status]);

  if (loading) {
    return <div className="skud-monitor-loading">Загрузка мониторинга Sigur...</div>;
  }

  return (
    <div className="skud-monitor">
      <div className="skud-monitor-header">
        <div>
          <h1>Монитор Sigur</h1>
          <p>Журнал инцидентов канала Sigur и проверок здоровья интеграции.</p>
        </div>
        <button
          className="skud-monitor-refresh"
          onClick={() => void refresh(true)}
          disabled={refreshing}
        >
          <RefreshCw size={16} className={refreshing ? 'spinning' : ''} />
          Обновить
        </button>
      </div>

      {error && (
        <div className="skud-monitor-error">
          <AlertTriangle size={16} />
          <span>{error}</span>
        </div>
      )}

      {status?.activeIncident && (
        <div className={`skud-monitor-banner ${status.activeIncident.severity}`}>
          <Siren size={18} />
          <div>
            <strong>Активный инцидент:</strong> {severityLabel[status.activeIncident.severity]} / {sourceLabel[status.activeIncident.detected_by]}
            <div>
              Открыт: {formatDateTime(status.activeIncident.started_at)}. Затронутое окно: {formatDateTime(status.activeIncident.affected_from)} - {formatDateTime(status.activeIncident.affected_to)}.
            </div>
          </div>
        </div>
      )}

      <div className="skud-monitor-summary">
        {summaryCards.map(card => (
          <div key={card.label} className={`skud-monitor-card ${card.tone}`}>
            <div className="skud-monitor-card-label">
              {card.icon}
              <span>{card.label}</span>
            </div>
            <div className="skud-monitor-card-value">{card.value}</div>
          </div>
        ))}
      </div>

      <div className="skud-monitor-grid">
        <section className="skud-monitor-panel">
          <div className="skud-monitor-panel-header">
            <h2>Инциденты</h2>
            <select value={incidentFilter} onChange={e => setIncidentFilter(e.target.value as 'all' | 'open' | 'resolved')}>
              <option value="all">Все</option>
              <option value="open">Только открытые</option>
              <option value="resolved">Только закрытые</option>
            </select>
          </div>

          <div className="skud-monitor-list">
            {incidents.length === 0 && <div className="skud-monitor-empty">Инцидентов пока нет</div>}
            {incidents.map(incident => (
              <button
                key={incident.id}
                className={`skud-monitor-incident ${selectedIncidentId === incident.id ? 'active' : ''} ${incident.severity}`}
                onClick={() => setSelectedIncidentId(incident.id)}
              >
                <div className="skud-monitor-incident-top">
                  <span className={`badge ${incident.status}`}>{incident.status === 'open' ? 'Открыт' : 'Закрыт'}</span>
                  <span className={`badge severity-${incident.severity}`}>{severityLabel[incident.severity]}</span>
                </div>
                <strong>{sourceLabel[incident.detected_by]}</strong>
                <div>{incident.error_message || 'Без текста ошибки'}</div>
                <div className="muted">Старт: {formatDateTime(incident.started_at)}</div>
              </button>
            ))}
          </div>
        </section>

        <section className="skud-monitor-panel details">
          <div className="skud-monitor-panel-header">
            <h2>Детали инцидента</h2>
          </div>

          {incidentDetailsQuery.isLoading && <div className="skud-monitor-empty">Загрузка деталей...</div>}
          {!incidentDetailsQuery.isLoading && !incidentDetails && <div className="skud-monitor-empty">Выберите инцидент слева</div>}

          {incidentDetails && (
            <div className="skud-monitor-details">
              <div className="skud-monitor-detail-grid">
                <div>
                  <span className="label">Статус</span>
                  <strong>{incidentDetails.incident.status === 'open' ? 'Открыт' : 'Закрыт'}</strong>
                </div>
                <div>
                  <span className="label">Источник</span>
                  <strong>{sourceLabel[incidentDetails.incident.detected_by]}</strong>
                </div>
                <div>
                  <span className="label">Длительность</span>
                  <strong>{formatDuration(incidentDetails.incident.started_at, incidentDetails.incident.resolved_at)}</strong>
                </div>
                <div>
                  <span className="label">Подключение</span>
                  <strong>{incidentDetails.incident.connection_type || '—'}</strong>
                </div>
                <div>
                  <span className="label">Затронуто с</span>
                  <strong>{formatDateTime(incidentDetails.incident.affected_from)}</strong>
                </div>
                <div>
                  <span className="label">Затронуто по</span>
                  <strong>{formatDateTime(incidentDetails.incident.affected_to)}</strong>
                </div>
              </div>

              <div className="skud-monitor-detail-block">
                <span className="label">Причина</span>
                <p>{incidentDetails.incident.error_message || 'Причина не указана'}</p>
              </div>

              <div className="skud-monitor-detail-block">
                <span className="label">Связанные проверки</span>
                <div className="skud-monitor-table-wrap">
                  <table className="skud-monitor-table">
                    <thead>
                      <tr>
                        <th>Время</th>
                        <th>Источник</th>
                        <th>Статус</th>
                        <th>Событий</th>
                        <th>Ошибка</th>
                      </tr>
                    </thead>
                    <tbody>
                      {incidentDetails.checks.map(check => (
                        <tr key={check.id}>
                          <td data-label="Время">{formatDateTime(check.checked_at)}</td>
                          <td data-label="Источник">{sourceLabel[check.source]}</td>
                          <td data-label="Статус">{checkStatusLabel[check.status]}</td>
                          <td data-label="Событий">{check.events_last_window ?? '—'}</td>
                          <td data-label="Ошибка">{check.error_message || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </section>
      </div>

      <section className="skud-monitor-panel">
        <div className="skud-monitor-panel-header">
          <h2>Журнал проверок</h2>
          <select value={checkFilter} onChange={e => setCheckFilter(e.target.value as 'all' | 'success' | 'failure' | 'silence')}>
            <option value="all">Все</option>
            <option value="success">Успех</option>
            <option value="failure">Ошибка</option>
            <option value="silence">Тишина</option>
          </select>
        </div>

        <div className="skud-monitor-table-wrap">
          <table className="skud-monitor-table">
            <thead>
              <tr>
                <th>Время</th>
                <th>Источник</th>
                <th>Статус</th>
                <th>События</th>
                <th>Baseline</th>
                <th>Ошибки подряд</th>
                <th>Ошибка</th>
              </tr>
            </thead>
            <tbody>
              {checks.length === 0 && (
                <tr>
                  <td colSpan={7} className="skud-monitor-empty">Проверок пока нет</td>
                </tr>
              )}
              {checks.map(check => (
                <tr key={check.id}>
                  <td data-label="Время">{formatDateTime(check.checked_at)}</td>
                  <td data-label="Источник">{sourceLabel[check.source]}</td>
                  <td data-label="Статус">{checkStatusLabel[check.status]}</td>
                  <td data-label="События">{check.events_last_window ?? '—'}</td>
                  <td data-label="Baseline">{check.baseline_events ?? '—'}</td>
                  <td data-label="Ошибки подряд">{check.consecutive_failures}</td>
                  <td data-label="Ошибка">{check.error_message || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};
