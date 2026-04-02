import React, { useEffect, useMemo, useRef, useState, memo } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronLeft, ChevronRight, Search, Building2, LogOut, Users, Clock, ArrowDownRight, ArrowUpRight, X } from 'lucide-react';
import { ActivityList } from '../components/dashboard/ActivityList';
import { PunctualityCard, AvgArrivalCard } from '../components/dashboard/AnalyticsRow';
import { HourlyActivityCard, ComparisonCard } from '../components/dashboard/DashboardSidebar';
import { LiveEventsCard } from '../components/dashboard/stats/LiveEventsCard';
import { usePresence } from '../hooks/usePresence';
import { useDashboardStats } from '../hooks/useDashboardStats';
import { useAuth } from '../contexts/AuthContext';
import { apiClient } from '../api/client';
import type { DashboardPeriod } from '../types';
import '../styles/DashboardPage.css';

interface IDbDepartment {
  id: string;
  name: string;
  parent_id: string | null;
  children: IDbDepartment[];
}

interface IDeptFlatOption {
  id: string;
  name: string;
  level: number;
}

const flattenDbTree = (nodes: IDbDepartment[], level = 0): IDeptFlatOption[] => {
  const result: IDeptFlatOption[] = [];
  for (const node of nodes) {
    result.push({ id: node.id, name: node.name, level });
    if (node.children && node.children.length > 0) {
      result.push(...flattenDbTree(node.children, level + 1));
    }
  }
  return result;
};

const formatClock = (): string => {
  const now = new Date();
  return now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

const LiveClock = memo(() => {
  const [clock, setClock] = useState(formatClock);
  useEffect(() => {
    const id = setInterval(() => setClock(formatClock()), 1000);
    return () => clearInterval(id);
  }, []);
  return <div className="live-clock">Время: {clock}</div>;
});

export const DashboardPage: React.FC = () => {
  const { positionType, profile } = useAuth();
  const isHeaderOnly = positionType === 'header';

  const today = new Date().toLocaleDateString('ru-RU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  // Department selector
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedDeptId = searchParams.get('dept');
  const [deptOptions, setDeptOptions] = useState<IDeptFlatOption[]>([]);
  const [deptDropdownOpen, setDeptDropdownOpen] = useState(false);
  const [deptSearchQuery, setDeptSearchQuery] = useState('');
  const deptDropdownRef = useRef<HTMLDivElement>(null);

  // Для header: сразу ставим отдел в URL без ожидания загрузки структуры
  useEffect(() => {
    if (isHeaderOnly && profile?.department_id && !searchParams.get('dept')) {
      setSearchParams({ dept: profile.department_id }, { replace: true });
    }
  }, [isHeaderOnly, profile?.department_id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    apiClient.get<{ success: boolean; data: { departments: IDbDepartment[] } }>('/structure')
      .then(res => {
        const departments = res.data?.departments || [];
        const collator = new Intl.Collator('ru', { sensitivity: 'base', ignorePunctuation: true });
        const flat = flattenDbTree(departments).sort((a, b) => collator.compare(a.name.trim(), b.name.trim()));
        setDeptOptions(flat);
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (deptDropdownRef.current && !deptDropdownRef.current.contains(e.target as Node)) {
        setDeptDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const selectedDept = useMemo(
    () => selectedDeptId ? deptOptions.find(d => d.id === selectedDeptId) : null,
    [selectedDeptId, deptOptions],
  );

  const filteredDeptOptions = useMemo(() => {
    if (!deptSearchQuery) return deptOptions;
    const q = deptSearchQuery.toLowerCase();
    return deptOptions.filter(d => d.name.toLowerCase().includes(q));
  }, [deptOptions, deptSearchQuery]);

  // Period toggle
  const [period, setPeriod] = useState<DashboardPeriod>('today');

  // Month picker (YYYY-MM)
  const getCurrentMonth = () => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  };
  const [selectedMonth, setSelectedMonth] = useState(getCurrentMonth);

  const shiftMonth = (delta: number) => {
    const [y, m] = selectedMonth.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    setSelectedMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  };

  const MONTH_NAMES = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
  const formatMonth = (ym: string) => {
    const [y, m] = ym.split('-').map(Number);
    return `${MONTH_NAMES[m - 1]} ${y}`;
  };

  const isFutureMonth = selectedMonth >= getCurrentMonth();

  // Data
  const { employees, loading } = usePresence(selectedDeptId);
  const { stats, loading: statsLoading } = useDashboardStats(
    selectedDeptId,
    period,
    period === 'month' ? selectedMonth : undefined,
  );

  const onlineCount = useMemo(
    () => employees.filter(e => e.status === 'online').length,
    [employees],
  );

  const [lateModalOpen, setLateModalOpen] = useState(false);
  const [expandedLateId, setExpandedLateId] = useState<number | null>(null);
  const navigate = useNavigate();

  const deptInputRef = useRef<HTMLInputElement>(null);

  const handleDeptInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setDeptSearchQuery(e.target.value);
    if (!deptDropdownOpen) setDeptDropdownOpen(true);
  };

  const handleDeptInputFocus = () => {
    setDeptSearchQuery('');
    setDeptDropdownOpen(true);
  };

  const handleDeptSelect = (deptId: string) => {
    setSearchParams({ dept: deptId }, { replace: true });
    setDeptDropdownOpen(false);
    setDeptSearchQuery('');
    deptInputRef.current?.blur();
  };

  const deptSelector = isHeaderOnly ? (
    <div className="dash-dept-dropdown">
      <div className="dash-dept-trigger has-value" style={{ cursor: 'default' }}>
        <Building2 size={14} className="dash-dept-search-icon" />
        <span className="dash-dept-input" style={{ cursor: 'default' }}>
          {selectedDept?.name ?? 'Мой отдел'}
        </span>
      </div>
    </div>
  ) : (
    <div className="dash-dept-dropdown" ref={deptDropdownRef}>
      <div className={`dash-dept-trigger ${selectedDeptId ? 'has-value' : ''} ${!selectedDeptId ? 'dash-dept-trigger--large' : ''}`}>
        <Search size={selectedDeptId ? 14 : 16} className="dash-dept-search-icon" />
        <input
          ref={deptInputRef}
          className="dash-dept-input"
          type="text"
          placeholder="Поиск отдела..."
          value={deptDropdownOpen ? deptSearchQuery : (selectedDept?.name ?? '')}
          onChange={handleDeptInputChange}
          onFocus={handleDeptInputFocus}
        />
        <ChevronDown size={selectedDeptId ? 14 : 18} className={`dash-dept-chevron ${deptDropdownOpen ? 'open' : ''}`} />
      </div>
      {deptDropdownOpen && (
        <div className={`dash-dept-menu ${!selectedDeptId ? 'dash-dept-menu--center' : ''}`}>
          <div className="dash-dept-list">
            {filteredDeptOptions.map(dept => (
              <div
                key={dept.id}
                className={`dash-dept-item ${selectedDeptId === dept.id ? 'selected' : ''}`}
                onClick={() => handleDeptSelect(dept.id)}
              >
                {dept.name}
              </div>
            ))}
            {filteredDeptOptions.length === 0 && (
              <div className="dash-dept-empty">Не найдено</div>
            )}
          </div>
        </div>
      )}
    </div>
  );

  return (
    <>
      {!selectedDeptId ? (
        <div className="dash-placeholder">
          <Building2 size={48} strokeWidth={1.2} />
          <h3>Выберите отдел</h3>
          <p>Чтобы увидеть статистику присутствия</p>
          {deptSelector}
        </div>
      ) : (
        <div className="dashboard-wrap">
          <div className="content-header">
            <div className="content-header-left">
              <div>
                <div className="date-display">{today}</div>
                <LiveClock />
              </div>
              <span className="live-badge">
                <span className="live-dot" />
                Прямой эфир
              </span>
              <div className="header-mini-stats">
                <span className="hms-item hms-green">
                  <Users size={13} />
                  {onlineCount}/{employees.length}
                </span>
                <span className="hms-item hms-orange">
                  <Clock size={13} />
                  {stats?.lateToday ?? 0}
                </span>
                <span className="hms-item hms-red">
                  <LogOut size={13} />
                  {stats?.earlyLeaveToday ?? 0}
                </span>
                <span className="hms-item hms-muted">
                  <ArrowDownRight size={13} />
                  {stats?.todayEntriesCount ?? 0}
                </span>
                <span className="hms-item hms-muted">
                  <ArrowUpRight size={13} />
                  {stats?.todayExitsCount ?? 0}
                </span>
              </div>
            </div>
            {deptSelector}
          </div>

          <div className="dashboard-columns">
            <div className="col-activity">
              <ActivityList employees={employees} loading={loading} />
            </div>

            <div className="col-events">
              <LiveEventsCard
                events={stats?.recentEvents ?? []}
                totalCount={(stats?.todayEntriesCount ?? 0) + (stats?.todayExitsCount ?? 0)}
              />
            </div>

            <div className="col-stats">
              <div className="period-toggle-row">
                <div className="period-toggle">
                  {(['today', 'week', 'month'] as const).map(p => (
                    <button
                      key={p}
                      className={`period-btn ${period === p ? 'active' : ''}`}
                      onClick={() => setPeriod(p)}
                    >
                      {p === 'today' ? 'Сегодня' : p === 'week' ? 'Неделя' : 'Месяц'}
                    </button>
                  ))}
                </div>
                {period === 'month' && (
                  <div className="month-picker">
                    <button className="month-picker-btn" onClick={() => shiftMonth(-1)}>
                      <ChevronLeft size={16} />
                    </button>
                    <span className="month-picker-label">{formatMonth(selectedMonth)}</span>
                    <button
                      className="month-picker-btn"
                      onClick={() => shiftMonth(1)}
                      disabled={isFutureMonth}
                    >
                      <ChevronRight size={16} />
                    </button>
                  </div>
                )}
              </div>

              {stats && (
                <div className="period-mini-cards">
                  {period === 'today' ? (
                    <>
                      <div className="pmc-item pmc-green">
                        <div className="pmc-label">Присутствуют</div>
                        <div className="pmc-value">{onlineCount}<span className="pmc-sub">/{employees.length}</span></div>
                      </div>
                      <div className="pmc-item pmc-red">
                        <div className="pmc-label">Отсутствуют</div>
                        <div className="pmc-value">{employees.length - onlineCount}</div>
                      </div>
                      <div className="pmc-item pmc-blue">
                        <div className="pmc-label">Вышедшие</div>
                        <div className="pmc-value">{stats.earlyLeaveToday}</div>
                      </div>
                      <div
                        className="pmc-item pmc-orange pmc-clickable"
                        onClick={() => setLateModalOpen(true)}
                        title="Посмотреть опоздавших"
                      >
                        <div className="pmc-label">Опоздания</div>
                        <div className="pmc-value">
                          {stats.lateToday}
                          {stats.lateYesterday > 0 && stats.lateToday !== stats.lateYesterday && (
                            <span className={`pmc-delta ${stats.lateToday > stats.lateYesterday ? 'neg' : 'pos'}`}>
                              {stats.lateToday > stats.lateYesterday ? '+' : ''}{stats.lateToday - stats.lateYesterday}
                            </span>
                          )}
                        </div>
                      </div>
                    </>
                  ) : stats.periodStats && (
                    <>
                      <div className="pmc-item pmc-green">
                        <div className="pmc-label">Ср. присутствие</div>
                        <div className="pmc-value">{stats.periodStats.avgPresent}<span className="pmc-sub">/{employees.length}</span></div>
                      </div>
                      <div className="pmc-item pmc-red">
                        <div className="pmc-label">Ср. отсутствие</div>
                        <div className="pmc-value">{stats.periodStats.avgAbsent}</div>
                      </div>
                      <div className="pmc-item pmc-blue">
                        <div className="pmc-label">Посещаемость</div>
                        <div className="pmc-value">{stats.periodStats.attendanceRate}%</div>
                      </div>
                      <div
                        className="pmc-item pmc-orange pmc-clickable"
                        onClick={() => setLateModalOpen(true)}
                        title="Посмотреть топ опаздывающих"
                      >
                        <div className="pmc-label">Опоздания</div>
                        <div className="pmc-value">
                          {stats.periodStats.lateCount}
                          {stats.periodStats.lateCount !== stats.periodStats.prevLateCount && (
                            <span className={`pmc-delta ${stats.periodStats.lateCount > stats.periodStats.prevLateCount ? 'neg' : 'pos'}`}>
                              {stats.periodStats.lateCount > stats.periodStats.prevLateCount ? '+' : ''}
                              {stats.periodStats.lateCount - stats.periodStats.prevLateCount}
                            </span>
                          )}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}

              {stats && !statsLoading && (
                <>
                  <PunctualityCard punctuality={stats.punctuality} period={period} />
                  <AvgArrivalCard data={stats.avgArrivalByDay} period={period} />
                  <HourlyActivityCard data={stats.hourlyActivity} period={period} />
                  <ComparisonCard comparison={stats.weekComparison} period={period} />
                </>
              )}
            </div>
          </div>
        </div>
      )}
      {/* Late rating modal */}
      {lateModalOpen && stats && (
        <div className="dash-modal-overlay" onClick={() => setLateModalOpen(false)}>
          <div className="dash-modal" onClick={e => e.stopPropagation()}>
            <div className="dash-modal-header">
              <span>Опоздания за {period === 'today' ? 'сегодня' : period === 'week' ? 'неделю' : 'месяц'}</span>
              <button className="dash-modal-close" onClick={() => setLateModalOpen(false)}>
                <X size={16} />
              </button>
            </div>
            <div className="dash-modal-body">
              {stats.topLate.length === 0 ? (
                <div className="dash-modal-empty">Опозданий нет</div>
              ) : (
                stats.topLate.map((item, i) => {
                  const isExpanded = expandedLateId === item.employee_id;
                  return (
                    <div key={item.employee_id} className="dash-late-group">
                      <div
                        className="dash-late-row"
                        onClick={() => setExpandedLateId(isExpanded ? null : item.employee_id)}
                      >
                        <span className="dash-late-rank">{i + 1}</span>
                        <div className="dash-late-info">
                          <div className="dash-late-name">{item.full_name}</div>
                          <div className="dash-late-avg">~{item.avgArrival}</div>
                        </div>
                        <span className="dash-late-count">{item.lateCount}</span>
                        <ChevronDown size={14} className={`dash-late-chevron ${isExpanded ? 'dash-late-chevron--open' : ''}`} />
                      </div>
                      {isExpanded && (
                        <div className="dash-late-details">
                          {(item.lateDetails || []).map(d => (
                            <div key={d.date} className="dash-late-detail-row">
                              <span className="dash-late-detail-date">
                                {new Date(d.date + 'T00:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', weekday: 'short' })}
                              </span>
                              <span className="dash-late-detail-time">{d.arrival}</span>
                            </div>
                          ))}
                          <div
                            className="dash-late-detail-link"
                            onClick={() => {
                              setLateModalOpen(false);
                              navigate(`/tender/${item.employee_id}`, { state: { from: '/dashboard', label: 'Обзор' } });
                            }}
                          >
                            Открыть карточку →
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
};
