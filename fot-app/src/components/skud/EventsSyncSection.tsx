import { useState, useEffect } from 'react';
import type { FC } from 'react';
import { RefreshCw, Download, Trash2 } from 'lucide-react';
import { sigurService } from '../../services/sigurService';
import { buildApiUrl, buildAuthHeaders } from '../../api/client';
import type {
  ISyncResult,
  IEventsProgressState,
  IEmployeesProgressState,
  SettingsTab,
} from './sigur-settings.types';
import { readSseResponse } from './sigur-settings.utils';

interface IEventsSyncSectionProps {
  connected: boolean | null;
  setError: (error: string) => void;
  setActiveTab: (tab: SettingsTab) => void;
  syncFilterSummary: string;
  externalBusy: boolean;
}

export const EventsSyncSection: FC<IEventsSyncSectionProps> = ({
  connected,
  setError,
  setActiveTab,
  syncFilterSummary,
  externalBusy,
}) => {
  const [syncStartDate, setSyncStartDate] = useState('');
  const [syncEndDate, setSyncEndDate] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<ISyncResult | null>(null);
  const [eventsProgress, setEventsProgress] = useState<IEventsProgressState | null>(null);
  const [employeesProgress, setEmployeesProgress] = useState<IEmployeesProgressState | null>(null);
  const [preparingMessage, setPreparingMessage] = useState<string | null>(null);
  const [waitingMessage, setWaitingMessage] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [clearResult, setClearResult] = useState<{ deleted: number } | null>(null);

  const preparingLabelByPhase: Record<string, string> = {
    db_employees: 'Читаем сотрудников из БД…',
    whitelist_db_cache: 'Строим whitelist из БД…',
    sigur_employees: 'Готовим whitelist по Sigur…',
    sigur_employees_all: 'Загружаем список сотрудников из Sigur…',
    sigur_employees_fallback: 'Загрузка сотрудников по отделам (fallback)…',
    loading_hashes: 'Читаем уже загруженные события за период…',
  };

  const busy = syncing || clearing || externalBusy;

  useEffect(() => {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth() + 1;
    const mStr = String(m).padStart(2, '0');
    const dStr = String(now.getDate()).padStart(2, '0');
    setSyncStartDate(`${y}-${mStr}-01`);
    setSyncEndDate(`${y}-${mStr}-${dStr}`);
  }, []);

  const handleSync = async () => {
    if (!syncStartDate || !syncEndDate) return;
    setSyncing(true);
    setSyncResult(null);
    setEventsProgress(null);
    setClearResult(null);
    setError('');
    setEmployeesProgress(null);
    setPreparingMessage(null);
    setWaitingMessage(null);

    try {
      const response = await fetch(buildApiUrl('/sigur/sync'), {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...buildAuthHeaders(),
        },
        body: JSON.stringify({ startDate: syncStartDate, endDate: syncEndDate }),
      });
      await readSseResponse(response, data => {
        if (data.type === 'waiting') {
          setWaitingMessage(String(data.message || 'Ожидание завершения фоновой синхронизации…'));
          return;
        }

        if (data.type === 'events_preparing') {
          const phase = String(data.phase || '');
          setPreparingMessage(preparingLabelByPhase[phase] || `Подготовка: ${phase}…`);
          setWaitingMessage(null);
          return;
        }

        if (data.type === 'employees_progress') {
          setEmployeesProgress({
            percent: Number(data.percent || 0),
            current: Number(data.current || 0),
            total: Number(data.total || 0),
            phase: String(data.status || ''),
          });
          setWaitingMessage(null);
          return;
        }

        if (data.type === 'events_loading_hashes') {
          setPreparingMessage(preparingLabelByPhase.loading_hashes);
          setEmployeesProgress(null);
          return;
        }

        if (data.type === 'events_start') {
          setEventsProgress({
            percent: 0,
            day: '',
            dayIndex: 0,
            totalDays: Number(data.totalDays || 0),
          });
          return;
        }

        if (data.type === 'events_day') {
          setEventsProgress({
            percent: Number(data.percent || 0),
            day: String(data.day || ''),
            dayIndex: Number(data.dayIndex || 0),
            totalDays: Number(data.totalDays || 0),
          });
          setPreparingMessage(null);
          setEmployeesProgress(null);
          return;
        }

        if (data.type === 'events_summaries') {
          setEventsProgress(prev => prev
            ? { ...prev, percent: 100, day: 'Пересчёт сводок...' }
            : {
                percent: 100,
                day: 'Пересчёт сводок...',
                dayIndex: 0,
                totalDays: 0,
              });
          return;
        }

        if (data.type === 'done') {
          setSyncResult(data as unknown as ISyncResult);
          setEventsProgress(null);
          return;
        }

        if (data.type === 'error') {
          setError(String(data.message || 'Ошибка синхронизации'));
        }
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка синхронизации');
    } finally {
      setSyncing(false);
      setEventsProgress(null);
      setEmployeesProgress(null);
      setPreparingMessage(null);
      setWaitingMessage(null);
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

  return (
    <div className="sigur-section">
      <h2 className="sigur-section-title">
        <Download size={18} />
        Синхронизация событий в базу
      </h2>
      <div className="sigur-sync-summary-note" style={{ marginBottom: '0.75rem' }}>
        Этот блок загружает в портал только события за выбранный период и только для отделов, участвующих в портальной синхронизации.
      </div>
      <div className="sigur-sync-summary">
        <span className="sigur-sync-summary-pill">{syncFilterSummary}</span>
        <button
          type="button"
          className="sigur-sync-summary-link"
          onClick={() => setActiveTab('sync-filter')}
        >
          Настроить фильтр
        </button>
      </div>
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
          disabled={busy || !connected || !syncStartDate || !syncEndDate}
        >
          <RefreshCw size={14} className={syncing ? 'sigur-spin' : ''} />
          {syncing ? 'Синхронизация...' : 'Синхронизировать'}
        </button>
        <button
          className="sigur-btn sigur-btn-danger"
          onClick={handleClearEvents}
          disabled={busy || !connected || !syncStartDate || !syncEndDate}
        >
          <Trash2 size={14} />
          {clearing ? 'Удаление...' : 'Очистить события'}
        </button>
      </div>

      {syncing && (
        <div className="sigur-sync-result">
          <div className="sigur-step-status">Выполняется синхронизация событий...</div>
          {eventsProgress && eventsProgress.day ? (
            <div className="sigur-events-progress">
              <div className="sigur-events-progress-bar">
                <div className="sigur-events-progress-fill" style={{ width: `${eventsProgress.percent}%` }} />
              </div>
              <span className="sigur-events-progress-text">
                {eventsProgress.day === 'Пересчёт сводок...'
                  ? eventsProgress.day
                  : `${eventsProgress.day} - ${eventsProgress.percent}% (${Math.min(eventsProgress.dayIndex + 1, Math.max(eventsProgress.totalDays, 1))}/${Math.max(eventsProgress.totalDays, 1)})`}
              </span>
            </div>
          ) : employeesProgress ? (
            <div className="sigur-events-progress">
              <div className="sigur-events-progress-bar">
                <div className="sigur-events-progress-fill" style={{ width: `${employeesProgress.percent}%` }} />
              </div>
              <span className="sigur-events-progress-text">
                {preparingMessage || 'Загрузка сотрудников из Sigur…'}
                {employeesProgress.total > 0
                  ? ` — ${employeesProgress.current}/${employeesProgress.total} (${employeesProgress.percent}%)`
                  : ''}
              </span>
            </div>
          ) : preparingMessage ? (
            <div className="sigur-events-progress-text">{preparingMessage}</div>
          ) : waitingMessage ? (
            <div className="sigur-events-progress-text">{waitingMessage}</div>
          ) : (
            <div className="sigur-events-progress-text">Подготовка данных...</div>
          )}
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
            <span className="sigur-sync-stat">Сопоставлено: <strong>{syncResult.matched}</strong></span>
            <span className="sigur-sync-stat skipped">Отфильтровано (отдел): <strong>{syncResult.filteredByDept ?? 0}</strong></span>
            <span className="sigur-sync-stat">Ошибок: <strong>{syncResult.errors?.length ?? 0}</strong></span>
          </div>
          {syncResult.errors?.length > 0 && (
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
  );
};
