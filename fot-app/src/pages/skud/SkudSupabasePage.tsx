import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Search, X, HardDrive, RefreshCw, AlertCircle } from 'lucide-react';
import { skudService } from '../../services/skudService';
import { useAuth } from '../../contexts/AuthContext';
import type { SkudEvent, SkudDailySummary } from '../../types';
import '../../styles/SkudSupabasePage.css';

type TabId = 'events' | 'summary';

interface ITab {
  id: TabId;
  label: string;
}

const TABS: ITab[] = [
  { id: 'events', label: 'События' },
  { id: 'summary', label: 'Сводка' },
];

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const monthStart = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
};

const formatCellValue = (value: unknown): string => {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'Да' : 'Нет';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

export const SkudSupabasePage: React.FC = () => {
  const { hasPosition } = useAuth();
  const isSuperAdmin = hasPosition('super_admin');

  const [activeTab, setActiveTab] = useState<TabId>('events');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const abortRef = useRef<AbortController | null>(null);

  // Даты
  const [startDate, setStartDate] = useState(monthStart);
  const [endDate, setEndDate] = useState(today);

  // Фильтр по организации (super_admin)
  const [organizations, setOrganizations] = useState<{ id: string; name: string }[]>([]);
  const [orgFilter, setOrgFilter] = useState('');

  // Данные
  const [events, setEvents] = useState<SkudEvent[]>([]);
  const [summary, setSummary] = useState<SkudDailySummary[]>([]);

  // Загрузка организаций
  useEffect(() => {
    if (!isSuperAdmin) return;
    skudService.getOrganizations().then(setOrganizations).catch(() => {});
  }, [isSuperAdmin]);

  // Debounce поиска (для табa events — серверный поиск)
  const handleSearchChange = useCallback((value: string) => {
    setSearchInput(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setSearchQuery(value), 400);
  }, []);

  const cancelLoading = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  const loadEvents = useCallback(async () => {
    cancelLoading();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const data = await skudService.getEvents({
        startDate,
        endDate,
        organizationId: orgFilter || undefined,
        search: searchQuery || undefined,
      }, controller.signal);
      setEvents(data);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Ошибка загрузки');
      setEvents([]);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [startDate, endDate, orgFilter, searchQuery, cancelLoading]);

  const loadSummary = useCallback(async () => {
    cancelLoading();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const data = await skudService.getDailySummary(startDate, orgFilter || undefined, controller.signal);
      setSummary(data);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Ошибка загрузки');
      setSummary([]);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [startDate, orgFilter, cancelLoading]);

  const loadData = useCallback(() => {
    if (activeTab === 'events') loadEvents();
    else loadSummary();
  }, [activeTab, loadEvents, loadSummary]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Данные для таблицы
  const tableData: Record<string, unknown>[] = useMemo(() => {
    if (activeTab === 'events') return events as unknown as Record<string, unknown>[];
    if (activeTab === 'summary') return summary as unknown as Record<string, unknown>[];
    return [];
  }, [activeTab, events, summary]);

  const columns = useMemo(() => {
    if (tableData.length === 0) return [];
    const keys = new Set<string>();
    for (const row of tableData.slice(0, 50)) {
      Object.keys(row).forEach(k => keys.add(k));
    }
    return Array.from(keys);
  }, [tableData]);

  // Для summary — локальная фильтрация
  const displayData = useMemo(() => {
    if (activeTab === 'events') return tableData;
    if (!searchInput.trim()) return tableData;
    const q = searchInput.toLowerCase();
    return tableData.filter(row =>
      columns.some(col => formatCellValue(row[col]).toLowerCase().includes(q))
    );
  }, [activeTab, tableData, searchInput, columns]);

  const handleTabChange = (tabId: TabId) => {
    setActiveTab(tabId);
    setSearchInput('');
    setSearchQuery('');
  };

  const clearSearch = () => {
    setSearchInput('');
    setSearchQuery('');
  };

  return (
    <div className="skud-db">
      <div className="skud-db-header">
        <div className="skud-db-title">
          <HardDrive size={22} />
          <h1>Просмотр СКУД (база)</h1>
          {!loading && tableData.length > 0 && (
            <span className="skud-db-count">
              {activeTab !== 'events' && searchInput
                ? `${displayData.length} / ${tableData.length}`
                : tableData.length}
            </span>
          )}
        </div>
        <button
          className="skud-db-refresh"
          onClick={loadData}
          disabled={loading}
        >
          <RefreshCw size={16} className={loading ? 'spinning' : ''} />
          Обновить
        </button>
      </div>

      <div className="skud-db-tabs">
        {TABS.map(tab => (
          <button
            key={tab.id}
            className={`skud-db-tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => handleTabChange(tab.id)}
            disabled={loading}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="skud-db-filters">
        <div className="skud-db-dates">
          <label>
            С:
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} />
          </label>
          <label>
            По:
            <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} />
          </label>
        </div>

        {isSuperAdmin && organizations.length > 0 && (
          <div className="skud-db-org-filter">
            <select
              value={orgFilter}
              onChange={e => setOrgFilter(e.target.value)}
              className="skud-db-org-select"
            >
              <option value="">Все организации</option>
              {organizations.map(org => (
                <option key={org.id} value={org.id}>{org.name}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="skud-db-search-wrap">
        <Search size={16} className="skud-db-search-icon" />
        <input
          type="text"
          placeholder={activeTab === 'events' ? 'Поиск по ФИО (все записи)...' : 'Поиск по всем полям...'}
          value={searchInput}
          onChange={e => handleSearchChange(e.target.value)}
          className="skud-db-search-input"
        />
        {searchInput && (
          <button className="skud-db-search-clear" onClick={clearSearch}>
            <X size={14} />
          </button>
        )}
      </div>

      {error && (
        <div className="skud-db-error">
          <AlertCircle size={16} />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="skud-db-loading">
          <div className="spinner"></div>
          <p>Загрузка из базы...</p>
          <button className="skud-db-cancel" onClick={() => { cancelLoading(); setLoading(false); }}>
            <X size={14} />
            Отменить
          </button>
        </div>
      ) : displayData.length === 0 && !error ? (
        <div className="skud-db-empty">
          {searchInput ? 'Ничего не найдено' : 'Нет данных за выбранный период'}
        </div>
      ) : (
        <div className="skud-db-table-wrap">
          <table className="skud-db-table">
            <thead>
              <tr>
                <th className="skud-db-th-num">#</th>
                {columns.map(col => (
                  <th key={col}>{col}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayData.map((row, idx) => (
                <tr key={idx}>
                  <td className="skud-db-td-num">{idx + 1}</td>
                  {columns.map(col => (
                    <td key={col} title={formatCellValue(row[col])}>
                      {formatCellValue(row[col])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
