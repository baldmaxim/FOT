import { useState, useEffect, useMemo, useCallback, type FC } from 'react';
import { skudService } from '../services/skudService';
import { useIsMobile } from '../hooks/useIsMobile';
import { useManagedDepartments } from '../hooks/useManagedDepartments';
import { DisciplineTable } from '../components/discipline/DisciplineTable';
import { DisciplineDetailPanel } from '../components/discipline/DisciplineDetailPanel';
import { DepartmentTreeMultiSelect } from '../components/staff/DepartmentTreeMultiSelect';
import { triggerBlobDownload } from '../utils/download';
import { getVisibleRootNodes, filterDepartmentTreeByIds, collectDescendantIds } from '../utils/departmentUtils';
import '../styles/DisciplineAnalyticsPage.css';

type ViolationType = 'late' | 'underwork' | 'early' | 'absence';

interface IViolationRaw {
  employee_id: number;
  date: string;
  type: ViolationType;
  first_entry: string | null;
  last_exit: string | null;
  total_hours: number | null;
  deviation: string;
}

interface IViolationMapped extends IViolationRaw {
  dateFormatted: string;
  typeLabel: string;
  summary: string;
}

interface IEmployeeSummary {
  employee_id: number;
  name: string;
  position: string;
  department: string;
  departmentId: string | null;
  initials: string;
  late: number;
  underwork: number;
  early: number;
  absence: number;
  total: number;
  worked_hours: number;
  norm_hours: number;
  violations: IViolationMapped[];
}

const TYPE_LABELS: Record<ViolationType, string> = {
  late: 'Опоздание', underwork: 'Недоработка', early: 'Ранний уход', absence: 'Отсутствие >3ч',
};

const TABS: { key: string; label: string }[] = [
  { key: 'all', label: 'Все' },
  { key: 'late', label: 'Опоздания' },
  { key: 'underwork', label: 'Недоработки' },
  { key: 'early', label: 'Ранние уходы' },
  { key: 'absence', label: 'Отсутствия >3ч' },
];

const MONTH_NAMES = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

const getInitials = (name: string) => {
  const parts = name.split(' ');
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
};

const formatDate = (iso: string) => {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
};

const formatTime = (t: string | null) => t ? t.slice(0, 5) : '—';

const formatHours = (h: number | null) => {
  if (h === null) return '—';
  const hrs = Math.floor(h);
  const mins = Math.round((h - hrs) * 60);
  return mins > 0 ? `${hrs}ч ${mins}м` : `${hrs}ч`;
};

const fixDeviation = (dev: string): string => {
  const match = dev.match(/^([+-]?)(\d+)\s*мин$/);
  if (!match) return dev;
  const sign = match[1];
  const totalMin = parseInt(match[2], 10);
  if (totalMin < 60) return dev;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (m > 0) return `${sign}${h}ч ${m}м`;
  return `${sign}${h}ч`;
};

const getSummary = (v: IViolationRaw): string => {
  const entry = formatTime(v.first_entry);
  const exit = formatTime(v.last_exit);
  const worked = formatHours(v.total_hours);
  const dev = fixDeviation(v.deviation);

  switch (v.type) {
    case 'late':
      return `Приход\u00A0${entry}, опоздание\u00A0${dev}`;
    case 'underwork':
      return `${entry}\u00A0→\u00A0${exit}, отработано\u00A0${worked}\u00A0(${dev})`;
    case 'early': {
      const earlyDev = dev.startsWith('Уход') ? dev : `ушёл на\u00A0${dev.replace('-', '')} раньше`;
      return `${entry}\u00A0→\u00A0${exit}, ${earlyDev}`;
    }
    case 'absence':
      return `${entry}\u00A0→\u00A0${exit}, отсутствие\u00A0${dev.replace('Отсутствие ', '')}`;
  }
};

export const DisciplineAnalyticsPage: FC = () => {
  const { isDepartmentScope, managedDepartmentIds, structureQuery } = useManagedDepartments();
  const isMobile = useIsMobile(430);

  const now = new Date();
  const currentYear = now.getFullYear();
  const initialMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const [startMonth, setStartMonth] = useState(initialMonth);
  const [endMonth, setEndMonth] = useState(initialMonth);
  const [rawViolations, setRawViolations] = useState<IViolationMapped[]>([]);
  const [empData, setEmpData] = useState<Record<number, { full_name: string; position: string | null; department_id: string | null; worked_hours: number; norm_hours: number }>>({});
  const [deptData, setDeptData] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [activeTab, setActiveTab] = useState('all');
  const [panelEmpId, setPanelEmpId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedDeptIds, setSelectedDeptIds] = useState<string[]>([]);
  const [viewMode, setViewMode] = useState<'all' | 'violations'>('all');

  const normalizedPeriod = useMemo(() => {
    if (startMonth <= endMonth) return { startMonth, endMonth };
    return { startMonth: endMonth, endMonth: startMonth };
  }, [startMonth, endMonth]);

  const yearOptions = useMemo(() => {
    const selectedYears = [startMonth, endMonth].map(value => Number(value.slice(0, 4)));
    const minYear = Math.min(currentYear, ...selectedYears) - 2;
    const maxYear = Math.max(currentYear, ...selectedYears) + 2;
    return Array.from({ length: maxYear - minYear + 1 }, (_, index) => minYear + index);
  }, [currentYear, endMonth, startMonth]);

  const getMonthParts = useCallback((value: string) => {
    const [year, month] = value.split('-').map(Number);
    return { year, month };
  }, []);

  const buildMonthValue = useCallback((year: number, month: number) => `${year}-${String(month).padStart(2, '0')}`, []);

  // Дерево отделов: для скоупа начальника участка ограничиваем его поддеревьями.
  const allTreeNodes = useMemo(
    () => getVisibleRootNodes(structureQuery.data?.departments || []),
    [structureQuery.data],
  );
  const scopeTreeNodes = useMemo(() => {
    if (!isDepartmentScope) return allTreeNodes;
    const scopeIds = collectDescendantIds(allTreeNodes, new Set(managedDepartmentIds));
    return filterDepartmentTreeByIds(allTreeNodes, scopeIds);
  }, [allTreeNodes, isDepartmentScope, managedDepartmentIds]);

  // Раскрытый набор id (выбранные узлы + все их потомки) — для фильтра сотрудников и экспорта.
  const effectiveDeptIds = useMemo(
    () => collectDescendantIds(allTreeNodes, new Set(selectedDeptIds)),
    [allTreeNodes, selectedDeptIds],
  );

  // По умолчанию начальнику участка выбираем его управляемые отделы.
  useEffect(() => {
    if (isDepartmentScope && managedDepartmentIds.length > 0) {
      setSelectedDeptIds(prev => (prev.length === 0 ? managedDepartmentIds : prev));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDepartmentScope, managedDepartmentIds]);

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const data = await skudService.getDisciplineViolations(normalizedPeriod, signal);
      if (signal?.aborted) return;
      setEmpData(data.employees);
      setDeptData(data.departments);
      setRawViolations(data.violations.map(v => {
        const fixed = { ...v, deviation: fixDeviation(v.deviation) };
        return {
          ...fixed,
          dateFormatted: formatDate(v.date),
          typeLabel: TYPE_LABELS[v.type],
          summary: getSummary(fixed),
        };
      }));
    } catch (e) {
      if (signal?.aborted) return;
      setError(e instanceof Error ? e.message : 'Ошибка загрузки');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [normalizedPeriod]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchData(controller.signal);
    return () => controller.abort();
  }, [fetchData]);

  // Строки по ВСЕМ сотрудникам в скоупе (empData), статистика нарушений — overlay из rawViolations.
  const employees = useMemo<IEmployeeSummary[]>(() => {
    const map: Record<number, IEmployeeSummary> = {};
    for (const [idStr, emp] of Object.entries(empData)) {
      const id = Number(idStr);
      const dept = emp.department_id ? (deptData[emp.department_id] || '—') : '—';
      map[id] = {
        employee_id: id,
        name: emp.full_name || `#${id}`,
        position: emp.position || '—',
        department: dept,
        departmentId: emp.department_id,
        initials: getInitials(emp.full_name || ''),
        late: 0, underwork: 0, early: 0, absence: 0, total: 0,
        worked_hours: emp.worked_hours ?? 0,
        norm_hours: emp.norm_hours ?? 0,
        violations: [],
      };
    }
    for (const v of rawViolations) {
      const row = map[v.employee_id];
      if (!row) continue;
      row[v.type]++;
      row.total++;
      row.violations.push(v);
    }
    return Object.values(map).sort(
      (a, b) => a.department.localeCompare(b.department, 'ru') || a.name.localeCompare(b.name, 'ru'),
    );
  }, [rawViolations, empData, deptData]);

  const deptFilteredBase = useMemo(() => {
    let list = employees;
    if (selectedDeptIds.length > 0) {
      list = list.filter(e => e.departmentId !== null && effectiveDeptIds.has(e.departmentId));
    }
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      list = list.filter(e => e.name.toLowerCase().includes(q));
    }
    return list;
  }, [employees, selectedDeptIds, effectiveDeptIds, searchQuery]);

  const filtered = useMemo(() => {
    let list = deptFilteredBase;
    if (viewMode === 'violations') {
      list = list.filter(e => e.total > 0);
    }
    if (activeTab !== 'all') {
      const key = activeTab as ViolationType;
      list = list.filter(e => e[key] > 0).sort((a, b) => b[key] - a[key]);
    }
    return list;
  }, [deptFilteredBase, viewMode, activeTab]);

  const peopleCounts = useMemo(() => {
    const c: Record<string, number> = { all: deptFilteredBase.length, late: 0, underwork: 0, early: 0, absence: 0 };
    for (const e of deptFilteredBase) {
      if (e.late > 0) c.late++;
      if (e.underwork > 0) c.underwork++;
      if (e.early > 0) c.early++;
      if (e.absence > 0) c.absence++;
    }
    return c;
  }, [deptFilteredBase]);

  // Гейт от перегруза: в режиме «Все» без выбора отделов и поиска не рендерим таблицу.
  const needsDeptSelection = viewMode === 'all' && selectedDeptIds.length === 0 && !searchQuery.trim();

  const panelEmployee = panelEmpId !== null ? employees.find(e => e.employee_id === panelEmpId) ?? null : null;

  const hasFilters = (isDepartmentScope ? false : selectedDeptIds.length > 0) || searchQuery !== '';

  const clearFilters = () => {
    if (!isDepartmentScope) setSelectedDeptIds([]);
    setSearchQuery('');
  };

  const exportToExcel = async () => {
    setIsExporting(true);
    try {
      const { blob, filename } = await skudService.exportDiscipline({
        startMonth: normalizedPeriod.startMonth,
        endMonth: normalizedPeriod.endMonth,
        tab: activeTab as 'all' | ViolationType,
        departmentIds: [...effectiveDeptIds],
        onlyViolations: viewMode === 'violations',
        search: searchQuery,
      });
      triggerBlobDownload(blob, filename);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Не удалось экспортировать аналитику дисциплины');
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="da-page">
      {/* Header: period picker + export */}
      <div className="da-header-row">
        <div className="da-period-control">
          <label className="da-month-field">
            <select
              className="da-period-select"
              value={getMonthParts(startMonth).month}
              onChange={e => {
                const m = Number(e.target.value);
                const y = getMonthParts(startMonth).year;
                const v = buildMonthValue(y, m);
                setStartMonth(v);
                if (v > endMonth) setEndMonth(v);
              }}
            >
              {MONTH_NAMES.map((name, index) => (
                <option key={`start-month-${index + 1}`} value={index + 1}>{name}</option>
              ))}
            </select>
            <select
              className="da-period-select da-period-select-year"
              value={getMonthParts(startMonth).year}
              onChange={e => {
                const y = Number(e.target.value);
                const m = getMonthParts(startMonth).month;
                const v = buildMonthValue(y, m);
                setStartMonth(v);
                if (v > endMonth) setEndMonth(v);
              }}
            >
              {yearOptions.map(year => (
                <option key={`start-year-${year}`} value={year}>{year}</option>
              ))}
            </select>
          </label>
          <span className="da-period-sep">—</span>
          <label className="da-month-field">
            <select
              className="da-period-select"
              value={getMonthParts(endMonth).month}
              onChange={e => {
                const m = Number(e.target.value);
                const y = getMonthParts(endMonth).year;
                const v = buildMonthValue(y, m);
                setEndMonth(v);
                if (v < startMonth) setStartMonth(v);
              }}
            >
              {MONTH_NAMES.map((name, index) => (
                <option key={`end-month-${index + 1}`} value={index + 1}>{name}</option>
              ))}
            </select>
            <select
              className="da-period-select da-period-select-year"
              value={getMonthParts(endMonth).year}
              onChange={e => {
                const y = Number(e.target.value);
                const m = getMonthParts(endMonth).month;
                const v = buildMonthValue(y, m);
                setEndMonth(v);
                if (v < startMonth) setStartMonth(v);
              }}
            >
              {yearOptions.map(year => (
                <option key={`end-year-${year}`} value={year}>{year}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="da-viewmode" role="tablist" aria-label="Кого показывать">
          <button
            type="button"
            className={`da-viewmode-btn ${viewMode === 'all' ? 'active' : ''}`}
            onClick={() => setViewMode('all')}
          >
            Все
          </button>
          <button
            type="button"
            className={`da-viewmode-btn ${viewMode === 'violations' ? 'active' : ''}`}
            onClick={() => setViewMode('violations')}
          >
            С нарушениями
          </button>
        </div>
        <div className="da-header-spacer" />
        <button className="da-btn da-btn-export" onClick={() => { void exportToExcel(); }} disabled={isExporting}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          {isExporting ? 'Экспорт...' : 'Экспорт в Excel'}
        </button>
      </div>

      {/* Stats bar */}
      <div className="da-stats-bar">
        <div className="da-stats-item">
          <span className="da-stats-dot" style={{ background: 'var(--warning)' }} />
          <span className="da-stats-item-label">Опоздания</span>
          <span className="da-stats-item-value" style={{ color: 'var(--warning)' }}>{peopleCounts.late}</span>
        </div>
        <div className="da-stats-divider" />
        <div className="da-stats-item">
          <span className="da-stats-dot" style={{ background: '#8b5cf6' }} />
          <span className="da-stats-item-label">Недоработки</span>
          <span className="da-stats-item-value" style={{ color: '#8b5cf6' }}>{peopleCounts.underwork}</span>
        </div>
        <div className="da-stats-divider" />
        <div className="da-stats-item">
          <span className="da-stats-dot" style={{ background: 'var(--primary)' }} />
          <span className="da-stats-item-label">Ранние уходы</span>
          <span className="da-stats-item-value" style={{ color: 'var(--primary)' }}>{peopleCounts.early}</span>
        </div>
        <div className="da-stats-divider" />
        <div className="da-stats-item">
          <span className="da-stats-dot" style={{ background: 'var(--error)' }} />
          <span className="da-stats-item-label">Отсутствия &gt;3ч</span>
          <span className="da-stats-item-value" style={{ color: 'var(--error)' }}>{peopleCounts.absence}</span>
        </div>
      </div>

      {loading && <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Загрузка...</div>}
      {error && <div style={{ padding: 20, color: 'var(--error)' }}>{error}</div>}

      {!loading && !error && (
        <>
          {/* Tabs + filters */}
          <div className="da-toolbar">
            <div className="da-tabs">
              {TABS.map(t => (
                <button key={t.key} className={`da-tab ${activeTab === t.key ? 'active' : ''}`} onClick={() => setActiveTab(t.key)}>
                  {t.label}
                  <span className="da-tab-count">{peopleCounts[t.key]}</span>
                </button>
              ))}
            </div>
            <div className="da-filters">
              <div className="da-search">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <input
                  type="text"
                  placeholder="Поиск по ФИО..."
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                />
                {searchQuery && (
                  <button className="da-search-clear" onClick={() => setSearchQuery('')}>&times;</button>
                )}
              </div>
              <div className="da-dept-tree">
                <DepartmentTreeMultiSelect
                  nodes={scopeTreeNodes}
                  value={selectedDeptIds}
                  onChange={setSelectedDeptIds}
                  isLoading={structureQuery.isLoading}
                  placeholder="Выберите отделы…"
                />
              </div>
              {hasFilters && (
                <button className="da-btn da-btn-reset" onClick={clearFilters}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  Сбросить
                </button>
              )}
            </div>
          </div>

          {needsDeptSelection ? (
            <div className="da-table-wrap">
              <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
                Выберите отделы в фильтре, чтобы увидеть сотрудников и часы за период.
              </div>
            </div>
          ) : (
            <DisciplineTable
              filtered={filtered}
              isMobile={isMobile}
              onSelectEmployee={setPanelEmpId}
            />
          )}
        </>
      )}

      <DisciplineDetailPanel
        employee={panelEmployee}
        onClose={() => setPanelEmpId(null)}
      />
    </div>
  );
};
