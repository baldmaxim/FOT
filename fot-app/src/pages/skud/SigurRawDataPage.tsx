import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Search, X, Database, RefreshCw, AlertCircle } from 'lucide-react';
import { buildApiUrl, buildAuthHeaders } from '../../api/client';
import { skudService } from '../../services/skudService';
import '../../styles/SigurRawDataPage.css';

const CACHE_TTL = 5 * 60 * 1000; // 5 минут

interface ITab {
  id: string;
  label: string;
}

const TABS: ITab[] = [
  { id: 'employees', label: 'Сотрудники' },
  { id: 'departments', label: 'Отделы' },
  { id: 'events', label: 'События' },
  { id: 'failures', label: 'Ошибочные события' },
  { id: 'access-points', label: 'Точки доступа' },
  { id: 'cards', label: 'Карты' },
  { id: 'zones', label: 'Зоны' },
  { id: 'access-rules', label: 'Режимы доступа' },
];

const formatCellValue = (value: unknown): string => {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

const getCached = (tabId: string): Record<string, unknown>[] | null => {
  try {
    const raw = sessionStorage.getItem(`sigur-raw:${tabId}`);
    if (!raw) return null;
    const { data, cachedAt } = JSON.parse(raw);
    if (Date.now() - cachedAt > CACHE_TTL) return null;
    return data;
  } catch { return null; }
};

const setCache = (tabId: string, data: Record<string, unknown>[]) => {
  try {
    sessionStorage.setItem(`sigur-raw:${tabId}`, JSON.stringify({ data, cachedAt: Date.now() }));
  } catch { /* quota exceeded */ }
};

export const SigurRawDataPage: React.FC = () => {
  const [activeTab, setActiveTab] = useState(TABS[0].id);
  const [data, setData] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [progress, setProgress] = useState<{ loaded: number; page: number } | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Фильтры для events / failures
  const [employeeIdInput, setEmployeeIdInput] = useState('');
  const [eventStartDate, setEventStartDate] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  const [eventEndDate, setEventEndDate] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  const [failureTypeFilter, setFailureTypeFilter] = useState('');

  const loadData = useCallback(async (tabId: string, skipCache = false) => {
    // Проверяем кэш
    if (!skipCache) {
      const cached = getCached(tabId);
      if (cached) {
        setData(cached);
        setFromCache(true);
        setLoading(false);
        setError(null);
        setProgress(null);
        return;
      }
    }

    // Отменяем предыдущий запрос
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    setData([]);
    setProgress(null);
    setFromCache(false);

    try {
      // Failures читаются из БД (таблица skud_event_failures), а не из live Sigur API.
      if (tabId === 'failures') {
        const result = await skudService.getEventFailures({
          ...(employeeIdInput.trim() ? { employeeId: employeeIdInput.trim() } : {}),
          ...(eventStartDate ? { startDate: eventStartDate } : {}),
          ...(eventEndDate ? { endDate: eventEndDate } : {}),
          ...(failureTypeFilter.trim() ? { failureType: failureTypeFilter.trim() } : {}),
          limit: 2000,
        }, controller.signal);
        const rows = result.data as unknown as Record<string, unknown>[];
        setData(rows);
        setCache(tabId, rows);
        return;
      }
      const params = new URLSearchParams({ type: tabId });
      if (tabId === 'events') {
        if (employeeIdInput.trim()) params.append('employeeId', employeeIdInput.trim());
        if (eventStartDate) params.append('startDate', eventStartDate);
        if (eventEndDate) params.append('endDate', eventEndDate);
      }
      const response = await fetch(buildApiUrl(`/sigur/stream?${params}`), {
        credentials: 'include',
        headers: buildAuthHeaders(),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const err = await response.json().catch(() => ({ error: 'Ошибка сервера' }));
        throw new Error(err.error || err.message || `HTTP ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let result: Record<string, unknown>[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6));
            if (event.type === 'progress') {
              setProgress({ loaded: event.loaded, page: event.page });
            } else if (event.type === 'done') {
              result = event.data || [];
            } else if (event.type === 'error') {
              throw new Error(event.message);
            }
          } catch (e) {
            if (e instanceof Error && e.message !== 'Unexpected end of JSON input') throw e;
          }
        }
      }

      setData(result as Record<string, unknown>[]);
      setCache(tabId, result as Record<string, unknown>[]);
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      const msg = err instanceof Error ? err.message : 'Ошибка загрузки данных';
      console.error(`[sigur-raw] ${tabId}: ошибка —`, msg);
      setError(msg);
      setData([]);
    } finally {
      setLoading(false);
      setProgress(null);
    }
  }, [employeeIdInput, eventEndDate, eventStartDate, failureTypeFilter]);

  useEffect(() => {
    // events и failures загружаются вручную по кнопке (там есть обязательные фильтры).
    if (activeTab !== 'events' && activeTab !== 'failures') loadData(activeTab);
    return () => abortRef.current?.abort();
  }, [activeTab, loadData]);

  const columns = useMemo(() => {
    if (data.length === 0) return [];
    const keys = new Set<string>();
    for (const row of data.slice(0, 50)) {
      Object.keys(row).forEach(k => keys.add(k));
    }
    return Array.from(keys);
  }, [data]);

  const filteredData = useMemo(() => {
    if (!searchQuery.trim()) return data;
    const q = searchQuery.toLowerCase();
    return data.filter(row =>
      columns.some(col => formatCellValue(row[col]).toLowerCase().includes(q))
    );
  }, [data, searchQuery, columns]);

  const handleTabChange = (tabId: string) => {
    setActiveTab(tabId);
    setSearchQuery('');
  };

  return (
    <div className="sigur-raw">
      <div className="sigur-raw-header">
        <div className="sigur-raw-title">
          <Database size={22} />
          {!loading && data.length > 0 && (
            <span className="sigur-raw-count">
              {filteredData.length}{searchQuery ? ` / ${data.length}` : ''}
              {fromCache && <span className="sigur-raw-cached" title="Данные из кэша"> (кэш)</span>}
            </span>
          )}
        </div>
        <button
          className="sigur-raw-refresh"
          onClick={() => loadData(activeTab, true)}
          disabled={loading}
          title="Загрузить заново из Sigur"
        >
          <RefreshCw size={16} className={loading ? 'spinning' : ''} />
          Обновить
        </button>
      </div>

      <div className="sigur-raw-tabs">
        {TABS.map(tab => (
          <button
            key={tab.id}
            className={`sigur-raw-tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => handleTabChange(tab.id)}
            disabled={loading}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {(activeTab === 'events' || activeTab === 'failures') && (
        <div className="sigur-raw-events-filters">
          <div className="sigur-raw-events-dates">
            <label>
              С:
              <input type="date" value={eventStartDate} onChange={e => setEventStartDate(e.target.value)} className="sigur-raw-date-input" />
            </label>
            <label>
              По:
              <input type="date" value={eventEndDate} onChange={e => setEventEndDate(e.target.value)} className="sigur-raw-date-input" />
            </label>
          </div>
          <label className="sigur-raw-employee-label">
            Employee ID:
            <input
              type="number"
              placeholder="ID сотрудника..."
              value={employeeIdInput}
              onChange={e => setEmployeeIdInput(e.target.value)}
              className="sigur-raw-employee-input"
            />
            {employeeIdInput && (
              <button className="sigur-raw-employee-clear" onClick={() => setEmployeeIdInput('')}>
                <X size={14} />
              </button>
            )}
          </label>
          {activeTab === 'failures' && (
            <label className="sigur-raw-employee-label">
              Тип ошибки:
              <input
                type="text"
                placeholder="PASS_DENY, READER_ERROR..."
                value={failureTypeFilter}
                onChange={e => setFailureTypeFilter(e.target.value)}
                className="sigur-raw-employee-input"
              />
              {failureTypeFilter && (
                <button className="sigur-raw-employee-clear" onClick={() => setFailureTypeFilter('')}>
                  <X size={14} />
                </button>
              )}
            </label>
          )}
          <button
            className="sigur-raw-refresh"
            onClick={() => loadData(activeTab, true)}
            disabled={loading}
          >
            Загрузить
          </button>
        </div>
      )}

      <div className="sigur-raw-search-wrap">
        <Search size={16} className="sigur-raw-search-icon" />
        <input
          type="text"
          placeholder="Поиск по всем полям..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          className="sigur-raw-search-input"
        />
        {searchQuery && (
          <button className="sigur-raw-search-clear" onClick={() => setSearchQuery('')}>
            <X size={14} />
          </button>
        )}
      </div>

      {error && (
        <div className="sigur-raw-error">
          <AlertCircle size={16} />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="sigur-raw-loading">
          <div className="spinner"></div>
          {progress ? (
            <p>Загружено {progress.loaded} записей (стр. {progress.page})...</p>
          ) : (
            <p>Подключение к Sigur...</p>
          )}
        </div>
      ) : data.length === 0 && !error ? (
        <div className="sigur-raw-empty">Нет данных</div>
      ) : (
        <div className="sigur-raw-table-wrap">
          <table className="sigur-raw-table">
            <thead>
              <tr>
                <th className="sigur-raw-th-num">#</th>
                {columns.map(col => (
                  <th key={col}>{col}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredData.map((row, idx) => (
                <tr key={idx}>
                  <td className="sigur-raw-td-num">{idx + 1}</td>
                  {columns.map(col => (
                    <td key={col} title={formatCellValue(row[col])}>
                      {formatCellValue(row[col])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {filteredData.length === 0 && searchQuery && (
            <div className="sigur-raw-empty">Ничего не найдено</div>
          )}
        </div>
      )}
    </div>
  );
};
