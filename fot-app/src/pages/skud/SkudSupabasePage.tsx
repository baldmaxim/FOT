import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Search, X, HardDrive, RefreshCw, AlertCircle, Save, Check, ChevronDown } from 'lucide-react';
import { skudService } from '../../services/skudService';
import { structureApi } from '../../api/structure';
import { adminService } from '../../services/adminService';
import { useAuth } from '../../contexts/AuthContext';
import type { SkudEvent, SkudDailySummary, Organization, OrgDepartmentNode, IAccessPointSetting } from '../../types';
import '../../styles/SkudSupabasePage.css';

type TabId = 'events' | 'summary' | 'access-points';

interface ITab {
  id: TabId;
  label: string;
}

const TABS: ITab[] = [
  { id: 'events', label: 'События' },
  { id: 'summary', label: 'Сводка' },
  { id: 'access-points', label: 'Точки доступа' },
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

const flattenDepts = (nodes: OrgDepartmentNode[], depth = 0): { id: string; name: string; depth: number }[] => {
  const result: { id: string; name: string; depth: number }[] = [];
  for (const n of nodes) {
    result.push({ id: n.id, name: n.name, depth });
    if (n.children?.length) result.push(...flattenDepts(n.children, depth + 1));
  }
  return result;
};

export const SkudSupabasePage: React.FC = () => {
  const { hasPosition } = useAuth();
  const isSuperAdmin = hasPosition('super_admin');
  const canEdit = hasPosition('manager') || hasPosition('owner') || isSuperAdmin;

  const [activeTab, setActiveTab] = useState<TabId>('events');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  // Даты
  const [startDate, setStartDate] = useState(monthStart);
  const [endDate, setEndDate] = useState(today);

  // Фильтр по организации (super_admin)
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [orgFilter, setOrgFilter] = useState('');

  // Данные
  const [events, setEvents] = useState<SkudEvent[]>([]);
  const [summary, setSummary] = useState<SkudDailySummary[]>([]);
  const [accessPoints, setAccessPoints] = useState<string[]>([]);

  // Настройки точек доступа
  const [departments, setDepartments] = useState<{ id: string; name: string; depth: number }[]>([]);
  const [selectedDeptId, setSelectedDeptId] = useState('');
  const [apSettings, setApSettings] = useState<Map<string, boolean>>(new Map());
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [deptDropdownOpen, setDeptDropdownOpen] = useState(false);
  const [deptSearch, setDeptSearch] = useState('');
  const deptDropdownRef = useRef<HTMLDivElement>(null);

  // Загрузка организаций
  useEffect(() => {
    if (!isSuperAdmin) return;
    adminService.getOrganizations().then(setOrganizations).catch(() => {});
  }, [isSuperAdmin]);

  // Загрузка отделов
  useEffect(() => {
    structureApi.getTree().then(res => {
      if (res.success && res.data) {
        setDepartments(flattenDepts(res.data.departments));
      }
    }).catch(() => {});
  }, []);

  // Закрытие dropdown при клике вне
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (deptDropdownRef.current && !deptDropdownRef.current.contains(e.target as Node)) {
        setDeptDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Загрузка настроек при выборе отдела
  useEffect(() => {
    if (!selectedDeptId) {
      setApSettings(new Map());
      return;
    }
    skudService.getAccessPointSettings(selectedDeptId).then(settings => {
      const map = new Map<string, boolean>();
      for (const s of settings) {
        map.set(s.access_point_name, s.is_internal);
      }
      setApSettings(map);
      setSettingsSaved(false);
    }).catch(() => {});
  }, [selectedDeptId]);

  // Debounce поиска (для табa events — серверный поиск)
  const handleSearchChange = useCallback((value: string) => {
    setSearchInput(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setSearchQuery(value), 400);
  }, []);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await skudService.getEvents({
        startDate,
        endDate,
        organizationId: orgFilter || undefined,
        search: searchQuery || undefined,
      });
      setEvents(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки');
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate, orgFilter, searchQuery]);

  const loadSummary = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await skudService.getDailySummary(startDate, orgFilter || undefined);
      setSummary(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки');
      setSummary([]);
    } finally {
      setLoading(false);
    }
  }, [startDate, orgFilter]);

  const loadAccessPoints = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await skudService.getAccessPoints(orgFilter || undefined);
      setAccessPoints(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки');
      setAccessPoints([]);
    } finally {
      setLoading(false);
    }
  }, [orgFilter]);

  const loadData = useCallback(() => {
    if (activeTab === 'events') loadEvents();
    else if (activeTab === 'summary') loadSummary();
    else loadAccessPoints();
  }, [activeTab, loadEvents, loadSummary, loadAccessPoints]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Данные для таблицы (для events/summary)
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

  // Для табов summary — локальная фильтрация
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

  const filteredDepts = useMemo(() => {
    if (!deptSearch.trim()) return departments;
    const q = deptSearch.toLowerCase();
    return departments.filter(d => d.name.toLowerCase().includes(q));
  }, [departments, deptSearch]);

  const selectedDeptName = useMemo(() => {
    return departments.find(d => d.id === selectedDeptId)?.name || '';
  }, [departments, selectedDeptId]);

  const selectDept = (id: string) => {
    setSelectedDeptId(id);
    setDeptDropdownOpen(false);
    setDeptSearch('');
  };

  const toggleApInternal = (apName: string) => {
    setApSettings(prev => {
      const next = new Map(prev);
      next.set(apName, !next.get(apName));
      return next;
    });
    setSettingsSaved(false);
  };

  const handleSaveSettings = async () => {
    if (!selectedDeptId) return;
    setSavingSettings(true);
    try {
      const settings: IAccessPointSetting[] = accessPoints.map(ap => ({
        access_point_name: ap,
        is_internal: apSettings.get(ap) || false,
      }));
      await skudService.saveAccessPointSettings(selectedDeptId, settings);
      setSettingsSaved(true);
      setTimeout(() => setSettingsSaved(false), 3000);
    } catch {
      setError('Ошибка сохранения настроек');
    } finally {
      setSavingSettings(false);
    }
  };

  const renderAccessPointsTab = () => (
    <div className="skud-ap-settings">
      <div className="skud-ap-dept-selector">
        <label>Отдел:</label>
        <div className="skud-ap-dept-dropdown" ref={deptDropdownRef}>
          <button
            className="skud-ap-dept-trigger"
            onClick={() => setDeptDropdownOpen(!deptDropdownOpen)}
          >
            <span>{selectedDeptName || '— Выберите отдел —'}</span>
            <ChevronDown size={14} />
          </button>
          {deptDropdownOpen && (
            <div className="skud-ap-dept-menu">
              <div className="skud-ap-dept-search-wrap">
                <Search size={14} />
                <input
                  type="text"
                  placeholder="Поиск отдела..."
                  value={deptSearch}
                  onChange={e => setDeptSearch(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="skud-ap-dept-list">
                <button
                  className={`skud-ap-dept-option ${!selectedDeptId ? 'active' : ''}`}
                  onClick={() => selectDept('')}
                >
                  — Все —
                </button>
                {filteredDepts.map(d => (
                  <button
                    key={d.id}
                    className={`skud-ap-dept-option ${selectedDeptId === d.id ? 'active' : ''}`}
                    style={{ paddingLeft: `${12 + d.depth * 16}px` }}
                    onClick={() => selectDept(d.id)}
                  >
                    {d.name}
                  </button>
                ))}
                {filteredDepts.length === 0 && (
                  <div className="skud-ap-dept-empty">Не найдено</div>
                )}
              </div>
            </div>
          )}
        </div>
        {selectedDeptId && canEdit && (
          <button
            className={`skud-ap-save-btn ${settingsSaved ? 'saved' : ''}`}
            onClick={handleSaveSettings}
            disabled={savingSettings}
          >
            {settingsSaved ? <><Check size={14} /> Сохранено</> : <><Save size={14} /> Сохранить</>}
          </button>
        )}
      </div>

      {accessPoints.length === 0 ? (
        <div className="skud-db-empty">Нет точек доступа</div>
      ) : (
        <div className="skud-db-table-wrap">
          <table className="skud-db-table">
            <thead>
              <tr>
                <th className="skud-db-th-num">#</th>
                <th>Точка доступа</th>
                <th>Тип</th>
              </tr>
            </thead>
            <tbody>
              {accessPoints.map((ap, idx) => {
                const isInternal = apSettings.get(ap) || false;
                return (
                  <tr key={ap}>
                    <td className="skud-db-td-num">{idx + 1}</td>
                    <td>{ap}</td>
                    <td>
                      {selectedDeptId && canEdit ? (
                        <button
                          className={`skud-ap-type-btn ${isInternal ? 'internal' : 'external'}`}
                          onClick={() => toggleApInternal(ap)}
                        >
                          {isInternal ? 'Внутренняя' : 'Внешняя'}
                        </button>
                      ) : (
                        <span className={`skud-ap-type-label ${isInternal ? 'internal' : 'external'}`}>
                          {selectedDeptId ? (isInternal ? 'Внутренняя' : 'Внешняя') : '—'}
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
  );

  return (
    <div className="skud-db">
      <div className="skud-db-header">
        <div className="skud-db-title">
          <HardDrive size={22} />
          <h1>Просмотр СКУД (база)</h1>
          {!loading && activeTab !== 'access-points' && tableData.length > 0 && (
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

      {activeTab !== 'access-points' && (
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
      )}

      {activeTab !== 'access-points' && (
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
      )}

      {error && (
        <div className="skud-db-error">
          <AlertCircle size={16} />
          <span>{error}</span>
        </div>
      )}

      {activeTab === 'access-points' ? (
        loading ? (
          <div className="skud-db-loading">
            <div className="spinner"></div>
            <p>Загрузка из базы...</p>
          </div>
        ) : (
          renderAccessPointsTab()
        )
      ) : loading ? (
        <div className="skud-db-loading">
          <div className="spinner"></div>
          <p>Загрузка из базы...</p>
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
