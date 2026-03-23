import { useState, useEffect, useCallback, useMemo } from 'react';
import { Settings, Wifi, WifiOff, RefreshCw, Eye, Download, Search, Save, Check, MapPin, Filter, Trash2, Database } from 'lucide-react';
import { SyncFilterTab } from '../../components/skud/SyncFilterTab';
import { sigurService } from '../../services/sigurService';
import { skudService } from '../../services/skudService';
import { structureApi } from '../../api/structure';
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

type SyncStepName = 'organizations' | 'clean-duplicates' | 'departments' | 'positions' | 'employees';

interface ISyncAllStep {
  id: number;
  name: SyncStepName;
  label: string;
  status: 'pending' | 'running' | 'done' | 'error';
  result?: Record<string, unknown>;
  error?: string;
}

interface IEventsProgressState {
  percent: number;
  day: string;
  dayIndex: number;
  totalDays: number;
}

interface IEmployeesProgressState {
  percent: number;
  current: number;
  total: number;
}

interface ISyncAllSummary {
  hasErrors: boolean;
  failedSteps: SyncStepName[];
  completedSteps: number;
}

interface ISseMessage extends Record<string, unknown> {
  type?: string;
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

const ALL_SYNC_STEPS: ISyncAllStep[] = [
  { id: 1, name: 'organizations', label: 'Организации', status: 'pending' },
  { id: 2, name: 'clean-duplicates', label: 'Очистка дублей', status: 'pending' },
  { id: 3, name: 'departments', label: 'Отделы (иерархия)', status: 'pending' },
  { id: 4, name: 'positions', label: 'Должности', status: 'pending' },
  { id: 5, name: 'employees', label: 'Сотрудники', status: 'pending' },
];

const DEFAULT_SYNC_ALL_STEPS: SyncStepName[] = ['departments', 'positions', 'employees'];

const STRUCTURE_SYNC_STEPS = ALL_SYNC_STEPS;

const buildStepState = (selectedSteps: SyncStepName[]): ISyncAllStep[] =>
  STRUCTURE_SYNC_STEPS
    .filter(step => selectedSteps.includes(step.name))
    .map(step => ({ ...step, status: 'pending', result: undefined, error: undefined }));

const getSyncStepLabel = (name: SyncStepName) =>
  STRUCTURE_SYNC_STEPS.find(step => step.name === name)?.label ?? name;

const formatDuration = (durationMs?: unknown) => {
  if (typeof durationMs !== 'number' || Number.isNaN(durationMs)) return '';
  return durationMs >= 10_000
    ? `${Math.round(durationMs / 1000)}с`
    : `${(durationMs / 1000).toFixed(1)}с`;
};

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
  const duration = formatDuration(result.durationMs);
  if (duration) {
    text += ` | ${duration}`;
  }
  return text;
};

const readResponseError = async (response: Response) => {
  try {
    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
      const payload = await response.json() as { error?: string; message?: string };
      if (payload.error) return payload.error;
      if (payload.message) return payload.message;
    }

    const text = (await response.text()).trim();
    if (text) return text;
  } catch {
    // ignore body parsing issues and fall back to a generic message
  }

  return 'Ошибка синхронизации';
};

const readSseResponse = async (
  response: Response,
  onData: (data: ISseMessage) => void,
) => {
  /*
      await readSseResponse(response, data => {
        if (data.type === 'step' && typeof data.step === 'number') {
          setSyncAllSteps(prev => prev.map(step =>
            step.id === data.step
              ? {
                  ...step,
                  status: (data.status as ISyncAllStep['status']) || step.status,
                  result: (data.result as Record<string, unknown> | undefined) ?? step.result,
                  error: (data.error as string | undefined) ?? undefined,
                }
              : step,
          ));

          if (data.status === 'done' || data.status === 'error') {
            setEventsProgress(null);
            setEmployeesProgress(null);
          }
          return;
        }

        if (data.type === 'employees_progress') {
          setEmployeesProgress({
            percent: Number(data.percent || 0),
            current: Number(data.current || 0),
            total: Number(data.total || 0),
          });
          return;
        }

        if (data.type === 'done') {
          const failedSteps = Array.isArray(data.failedSteps)
            ? data.failedSteps.filter((step): step is SyncStepName =>
                typeof step === 'string' && STRUCTURE_SYNC_STEPS.some(candidate => candidate.name === step),
              )
            : [];

          setSyncAllSummary({
            hasErrors: Boolean(data.hasErrors),
            failedSteps,
            completedSteps: typeof data.completedSteps === 'number'
              ? data.completedSteps
              : Math.max(selectedSyncAllSteps.length - failedSteps.length, 0),
          });
          setSyncAllDone(true);
          setEventsProgress(null);
          setEmployeesProgress(null);
          return;
        }

        if (data.type === 'error') {
          setError(String(data.message || 'РћС€РёР±РєР° СЃРёРЅС…СЂРѕРЅРёР·Р°С†РёРё'));
        }
      });
      return;

      await readSseResponse(response, data => {
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
          return;
        }

        if (data.type === 'events_summaries') {
          setEventsProgress(prev => prev
            ? { ...prev, percent: 100, day: 'РџРµСЂРµСЃС‡С‘С‚ СЃРІРѕРґРѕРє...' }
            : {
                percent: 100,
                day: 'РџРµСЂРµСЃС‡С‘С‚ СЃРІРѕРґРѕРє...',
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
          setError(String(data.message || 'РћС€РёР±РєР° СЃРёРЅС…СЂРѕРЅРёР·Р°С†РёРё'));
        }
      });
      return;

  if (!response.ok || !response.body) {
    throw new Error(await readResponseError(response));
  }

  */

  if (!response.ok || !response.body) {
    throw new Error(await readResponseError(response));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const processChunk = (chunk: string) => {
    for (const line of chunk.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      try {
        onData(JSON.parse(line.slice(6)) as ISseMessage);
      } catch {
        // ignore malformed SSE payloads
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    processChunk(lines.join('\n'));
  }

  buffer += decoder.decode();
  processChunk(buffer);
};

type SettingsTab = 'settings' | 'access-points' | 'sync-filter';

export const SigurSettingsPage = () => {
  const { hasPosition, profile } = useAuth();
  const canEdit = hasPosition(['header', 'admin', 'super_admin']);

  const [activeTab, setActiveTab] = useState<SettingsTab>('settings');

  // Подключение
  const [connected, setConnected] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);
  const [connectionType, setConnectionType] = useState('');
  const [selectedConnection, setSelectedConnection] = useState<'internal' | 'external'>('internal');
  const [availableConnections, setAvailableConnections] = useState<{ internal: boolean; external: boolean }>({ internal: false, external: false });
  const [error, setError] = useState('');

  // Полная синхронизация структуры
  const [syncAllRunning, setSyncAllRunning] = useState(false);
  const [selectedSyncAllSteps, setSelectedSyncAllSteps] = useState<SyncStepName[]>(DEFAULT_SYNC_ALL_STEPS);
  const [syncAllSteps, setSyncAllSteps] = useState<ISyncAllStep[]>(buildStepState(DEFAULT_SYNC_ALL_STEPS));
  const [syncAllDone, setSyncAllDone] = useState(false);
  const [syncAllSummary, setSyncAllSummary] = useState<ISyncAllSummary | null>(null);
  const [syncFilterCount, setSyncFilterCount] = useState<number | null>(null);

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
  const [eventsProgress, setEventsProgress] = useState<IEventsProgressState | null>(null);
  const [employeesProgress, setEmployeesProgress] = useState<IEmployeesProgressState | null>(null);
  const [clearing, setClearing] = useState(false);
  const [clearResult, setClearResult] = useState<{ deleted: number } | null>(null);

  // Очистка структуры
  const [clearingStructure, setClearingStructure] = useState(false);
  const [clearStructureResult, setClearStructureResult] = useState<{ employeesDeleted: number; departmentsDeleted: number } | null>(null);

  // Точки доступа
  const [accessPoints, setAccessPoints] = useState<string[]>([]);
  const [apLoading, setApLoading] = useState(false);
  const [apSettings, setApSettings] = useState<Map<string, boolean>>(new Map());
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [syncingAP, setSyncingAP] = useState(false);
  const [syncAPResult, setSyncAPResult] = useState<{ added: number; removed: number } | null>(null);
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

  useEffect(() => {
    sigurService.getSyncFilter()
      .then(filter => setSyncFilterCount(filter.length))
      .catch(() => setSyncFilterCount(null));
  }, []);

  const filteredAccessPoints = useMemo(() => {
    if (!apSearch.trim()) return accessPoints;
    const q = apSearch.toLowerCase();
    return accessPoints.filter(ap => ap.toLowerCase().includes(q));
  }, [accessPoints, apSearch]);

  const toggleSyncAllStep = (stepName: SyncStepName) => {
    if (manualSyncBusy) return;

    setSelectedSyncAllSteps(prev => {
      const hasStep = prev.includes(stepName);
      const next = STRUCTURE_SYNC_STEPS
        .map(step => step.name)
        .filter(name => (name === stepName ? !hasStep : prev.includes(name)));

      setSyncAllSteps(buildStepState(next));
      setSyncAllDone(false);
      return next;
    });
  };

  const toggleApInternal = (apName: string) => {
    const key = apName.trim();
    setApSettings(prev => {
      const next = new Map(prev);
      next.set(key, !next.get(key));
      return next;
    });
    setSettingsSaved(false);
  };

  const handleSaveApSettings = async () => {
    setSavingSettings(true);
    try {
      const settings: IAccessPointSetting[] = accessPoints.map(ap => ({
        access_point_name: ap,
        is_internal: apSettings.get(ap.trim()) || false,
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

  const handleSyncAccessPoints = async () => {
    setSyncingAP(true);
    setSyncAPResult(null);
    setError('');
    try {
      const oldSet = new Set(accessPoints);
      const result = await skudService.syncAccessPoints();
      setAccessPoints(result.accessPoints);
      if (result.removed.length > 0) {
        setApSettings(prev => {
          const next = new Map(prev);
          for (const name of result.removed) next.delete(name);
          return next;
        });
      }
      const addedCount = result.accessPoints.filter(ap => !oldSet.has(ap)).length;
      setSyncAPResult({ added: addedCount, removed: result.removed.length });
      setTimeout(() => setSyncAPResult(null), 5000);
    } catch {
      setError('Ошибка обновления точек доступа');
    } finally {
      setSyncingAP(false);
    }
  };

  const checkConnection = useCallback(async (connType?: 'internal' | 'external') => {
    setChecking(true);
    setError('');
    try {
      const result = await sigurService.testConnection(connType ?? selectedConnection);
      setConnected(result.success);
      setConnectionType(result.connection || '');
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

  const handleSyncAll = async () => {
    if (selectedSyncAllSteps.length === 0) {
      setError('Выберите хотя бы один шаг синхронизации');
      return;
    }

    setSyncAllRunning(true);
    setSyncAllDone(false);
    setSyncAllSummary(null);
    setEventsProgress(null);
    setEmployeesProgress(null);
    setError('');
    setSyncAllSteps(buildStepState(selectedSyncAllSteps));

    try {
      const token = localStorage.getItem('access_token');
      const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';
      const response = await fetch(`${apiUrl}/sigur/sync-all`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ steps: selectedSyncAllSteps }),
      });
      await readSseResponse(response, data => {
        if (data.type === 'step' && typeof data.step === 'number') {
          setSyncAllSteps(prev => prev.map(step =>
            step.id === data.step
              ? {
                  ...step,
                  status: (data.status as ISyncAllStep['status']) || step.status,
                  result: (data.result as Record<string, unknown> | undefined) ?? step.result,
                  error: (data.error as string | undefined) ?? undefined,
                }
              : step,
          ));

          if (data.status === 'done' || data.status === 'error') {
            setEventsProgress(null);
            setEmployeesProgress(null);
          }
          return;
        }

        if (data.type === 'employees_progress') {
          setEmployeesProgress({
            percent: Number(data.percent || 0),
            current: Number(data.current || 0),
            total: Number(data.total || 0),
          });
          return;
        }

        if (data.type === 'done') {
          const failedSteps = Array.isArray(data.failedSteps)
            ? data.failedSteps.filter((step): step is SyncStepName =>
                typeof step === 'string' && STRUCTURE_SYNC_STEPS.some(candidate => candidate.name === step),
              )
            : [];

          setSyncAllSummary({
            hasErrors: Boolean(data.hasErrors),
            failedSteps,
            completedSteps: typeof data.completedSteps === 'number'
              ? data.completedSteps
              : Math.max(selectedSyncAllSteps.length - failedSteps.length, 0),
          });
          setSyncAllDone(true);
          setEventsProgress(null);
          setEmployeesProgress(null);
          return;
        }

        if (data.type === 'error') {
          setError(String(data.message || 'Ошибка синхронизации'));
        }
      });
      return;


      if (!response.ok || !response.body) {
        throw new Error('Ошибка синхронизации');
      }

      const reader = response.body!.getReader();
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
              if (data.status === 'done' || data.status === 'error') {
                setEventsProgress(null);
                setEmployeesProgress(null);
              }
            } else if (data.type === 'employees_progress') {
              setEmployeesProgress({ percent: data.percent, current: data.current, total: data.total });
            } else if (data.type === 'events_day') {
              setEventsProgress({ percent: data.percent, day: data.day, dayIndex: data.dayIndex, totalDays: data.totalDays });
            } else if (data.type === 'events_summaries') {
              setEventsProgress(prev => prev ? { ...prev, percent: 100, day: 'Пересчёт сводок...' } : null);
            } else if (data.type === 'done') {
              setSyncAllDone(true);
              setEventsProgress(null);
              setEmployeesProgress(null);
            } else if (data.type === 'error') {
              setError(data.message);
            }
          } catch { /* skip parse errors */ }
        }
      }

      // Flush decoder и обработка остатка буфера
      buffer += decoder.decode();
      for (const line of buffer.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          const data = JSON.parse(line.slice(6));
          if (data.type === 'done') {
            setSyncAllDone(true);
            setEventsProgress(null);
            setEmployeesProgress(null);
          } else if (data.type === 'error') {
            setError(data.message);
          }
        } catch { /* skip */ }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка синхронизации');
    } finally {
      setSyncAllRunning(false);
      setEventsProgress(null);
      setEmployeesProgress(null);
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
    // Запускаем отдельную синхронизацию событий за выбранный период
    setSyncing(true);
    setSyncResult(null);
    setEventsProgress(null);
    setClearResult(null);
    setError('');
    setEmployeesProgress(null);

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
      await readSseResponse(response, data => {
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
      return;


      if (!response.ok || !response.body) {
        throw new Error('Ошибка синхронизации');
      }

      const reader = response.body!.getReader();
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
              if (data.status === 'done' || data.status === 'error') {
                setEventsProgress(null);
                setEmployeesProgress(null);
              }
            } else if (data.type === 'employees_progress') {
              setEmployeesProgress({ percent: data.percent, current: data.current, total: data.total });
            } else if (data.type === 'events_day') {
              setEventsProgress({ percent: data.percent, day: data.day, dayIndex: data.dayIndex, totalDays: data.totalDays });
            } else if (data.type === 'events_summaries') {
              setEventsProgress(prev => prev ? { ...prev, percent: 100, day: 'Пересчёт сводок...' } : null);
            } else if (data.type === 'done') {
              setSyncAllDone(true);
              setEventsProgress(null);
              setEmployeesProgress(null);
              const eventsResult = data.results?.events;
              if (eventsResult && 'imported' in eventsResult) {
                setSyncResult(eventsResult as ISyncResult);
              }
            } else if (data.type === 'error') {
              setError(data.message);
            }
          } catch { /* skip parse errors */ }
        }
      }

      // Flush decoder и обработка остатка буфера
      buffer += decoder.decode();
      for (const line of buffer.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          const data = JSON.parse(line.slice(6));
          if (data.type === 'done') {
            setSyncAllDone(true);
            setEventsProgress(null);
            setEmployeesProgress(null);
            const eventsResult = data.results?.events;
            if (eventsResult && 'imported' in eventsResult) {
              setSyncResult(eventsResult as ISyncResult);
            }
          } else if (data.type === 'error') {
            setError(data.message);
          }
        } catch { /* skip */ }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка синхронизации');
    } finally {
      setSyncing(false);
      setEventsProgress(null);
      setEmployeesProgress(null);
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

  const handleClearStructure = async () => {
    if (!confirm('Удалить ВСЕ отделы и сотрудников организации? Это действие необратимо!')) return;
    setClearingStructure(true);
    setClearStructureResult(null);
    setError('');
    try {
      const result = await structureApi.clearStructure(profile?.organization_id || undefined);
      if (result.success && result.data) {
        setClearStructureResult(result.data);
      } else {
        setError(result.error || 'Ошибка очистки структуры');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка очистки структуры');
    } finally {
      setClearingStructure(false);
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

  const syncFilterSummary = syncFilterCount === null
    ? 'Фильтр отделов не загружен'
    : syncFilterCount === 0
      ? 'Фильтр не задан: синхронизация затронет все отделы'
      : `Активен фильтр: ${syncFilterCount} отдел(ов)`;

  const manualSyncBusy = syncAllRunning || syncing || clearing || clearingStructure;

  return (
    <div className="sigur-page">
      <div className="sigur-header">
        <Settings size={24} />
        <h1>Настройки СКУД (Sigur)</h1>
        <a
          href="http://127.0.0.1:54323"
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

      {activeTab === 'settings' && <>
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
      <div className="sigur-section">
        <h2 className="sigur-section-title">
          <RefreshCw size={18} />
          Полная синхронизация структуры
        </h2>
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
        <div className="sigur-sync-summary-note" style={{ marginBottom: '0.75rem' }}>
          Этот блок синхронизирует только структуру: отделы, должности и сотрудников. События загружаются отдельно ниже.
        </div>
        <div className="sigur-sync-steps-selector">
          {STRUCTURE_SYNC_STEPS.map(step => (
            <label key={step.name} className="sigur-sync-step-option">
              <input
                type="checkbox"
                checked={selectedSyncAllSteps.includes(step.name)}
                onChange={() => toggleSyncAllStep(step.name)}
                disabled={manualSyncBusy}
              />
              <span>{step.label}</span>
            </label>
          ))}
        </div>
        <div className="sigur-connection-row">
          <button
            className="sigur-btn sigur-btn-primary"
            onClick={handleSyncAll}
            disabled={manualSyncBusy || !connected || selectedSyncAllSteps.length === 0}
          >
            <RefreshCw size={14} className={syncAllRunning ? 'sigur-spin' : ''} />
            {syncAllRunning ? 'Синхронизация...' : 'Запустить выбранные шаги'}
          </button>
          {canEdit && (
            <button
              className="sigur-btn sigur-btn-danger"
              onClick={handleClearStructure}
              disabled={manualSyncBusy}
            >
              <Trash2 size={14} />
              {clearingStructure ? 'Очистка...' : 'Очистить структуру'}
            </button>
          )}
        </div>

        {clearStructureResult && (
          <div className="sigur-sync-result">
            <div className="sigur-sync-stats">
              <span className="sigur-sync-stat success">Удалено сотрудников: <strong>{clearStructureResult.employeesDeleted}</strong></span>
              <span className="sigur-sync-stat success">Удалено отделов: <strong>{clearStructureResult.departmentsDeleted}</strong></span>
            </div>
          </div>
        )}

        {syncAllSummary && (
          <div className="sigur-sync-result">
            <div className="sigur-sync-stats">
              <span className={`sigur-sync-stat ${syncAllSummary.hasErrors ? 'skipped' : 'success'}`}>
                {syncAllSummary.hasErrors ? 'Синхронизация структуры завершена с ошибками' : 'Синхронизация структуры завершена успешно'}
              </span>
              <span className="sigur-sync-stat">Выполнено: <strong>{syncAllSummary.completedSteps}/{syncAllSummary.completedSteps + syncAllSummary.failedSteps.length}</strong></span>
              {syncAllSummary.hasErrors && (
                <span className="sigur-sync-stat skipped">
                  Шаги с ошибками: <strong>{syncAllSummary.failedSteps.map(getSyncStepLabel).join(', ')}</strong>
                </span>
              )}
            </div>
          </div>
        )}

        {(syncAllRunning || syncAllDone) && syncAllSteps.length > 0 && (
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
                  {step.status === 'running' && step.name === 'employees' && employeesProgress ? (
                    <div className="sigur-events-progress">
                      <div className="sigur-events-progress-bar">
                        <div className="sigur-events-progress-fill" style={{ width: `${employeesProgress.percent}%` }} />
                      </div>
                      <span className="sigur-events-progress-text">
                        {employeesProgress.current}/{employeesProgress.total} — {employeesProgress.percent}%
                      </span>
                    </div>
                  ) : step.status === 'running' && (
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
        <div className="sigur-sync-summary-note" style={{ marginBottom: '0.75rem' }}>
          Этот блок загружает только события за выбранный период.
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
            disabled={manualSyncBusy || !connected || !syncStartDate || !syncEndDate}
          >
            <RefreshCw size={14} className={syncing ? 'sigur-spin' : ''} />
            {syncing ? 'Синхронизация...' : 'Синхронизировать'}
          </button>
          <button
            className="sigur-btn sigur-btn-danger"
            onClick={handleClearEvents}
            disabled={manualSyncBusy || !connected || !syncStartDate || !syncEndDate}
          >
            <Trash2 size={14} />
            {clearing ? 'Удаление...' : 'Очистить события'}
          </button>
        </div>

        {syncing && (
          <div className="sigur-sync-result">
            <div className="sigur-step-status">Выполняется синхронизация событий...</div>
            {eventsProgress ? (
              <div className="sigur-events-progress">
                <div className="sigur-events-progress-bar">
                  <div className="sigur-events-progress-fill" style={{ width: `${eventsProgress.percent}%` }} />
                </div>
                <span className="sigur-events-progress-text">
                  {eventsProgress.day === 'Пересчёт сводок...'
                    ? eventsProgress.day
                    : `${eventsProgress.day || 'Подготовка...'} - ${eventsProgress.percent}% (${Math.min(eventsProgress.dayIndex + 1, Math.max(eventsProgress.totalDays, 1))}/${Math.max(eventsProgress.totalDays, 1)})`}
                </span>
              </div>
            ) : (
              <div className="sigur-events-progress-text">Подготовка данных...</div>
            )}
          </div>
        )}

        {false && (syncing || syncAllDone) && (
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
                  {step.status === 'running' && step.name === 'employees' && employeesProgress && (
                    <div className="sigur-events-progress">
                      <div className="sigur-events-progress-bar">
                        <div className="sigur-events-progress-fill" style={{ width: `${employeesProgress.percent}%` }} />
                      </div>
                      <span className="sigur-events-progress-text">
                        {employeesProgress.current}/{employeesProgress.total} — {employeesProgress.percent}%
                      </span>
                    </div>
                  )}
                  {step.status === 'done' && step.result && (
                    <div className="sigur-step-result">
                      {renderStepResult(step.name, step.result)}
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
      </>}

      {activeTab === 'sync-filter' && (
        <SyncFilterTab
          connected={connected}
          canEdit={canEdit}
          onFilterCountChange={setSyncFilterCount}
        />
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
          {canEdit && (<>
            <button
              className="sigur-btn"
              onClick={handleSyncAccessPoints}
              disabled={syncingAP || !connected}
              title="Обновить список из Sigur"
            >
              <RefreshCw size={14} className={syncingAP ? 'sigur-spin' : ''} />
              {syncingAP ? 'Обновление...' : 'Обновить'}
            </button>
            <button
              className={`sigur-btn sigur-btn-primary ${settingsSaved ? 'sigur-btn-saved' : ''}`}
              onClick={handleSaveApSettings}
              disabled={savingSettings}
            >
              {settingsSaved ? <><Check size={14} /> Сохранено</> : <><Save size={14} /> Сохранить</>}
            </button>
          </>)}
        </div>

        {syncAPResult && (
          <div className="sigur-sync-result" style={{ marginBottom: '0.75rem' }}>
            <div className="sigur-sync-stats">
              {syncAPResult.added > 0 && (
                <span className="sigur-sync-stat success">Добавлено: <strong>{syncAPResult.added}</strong></span>
              )}
              {syncAPResult.removed > 0 && (
                <span className="sigur-sync-stat skipped">Удалено: <strong>{syncAPResult.removed}</strong></span>
              )}
              {syncAPResult.added === 0 && syncAPResult.removed === 0 && (
                <span className="sigur-sync-stat">Изменений нет</span>
              )}
            </div>
          </div>
        )}

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
                  const isInternal = apSettings.get(ap.trim()) || false;
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
