import React, { lazy, Suspense, useCallback, useEffect, useMemo, useState, memo } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronLeft, ChevronRight, Building2, LogOut, Users, Clock, ArrowDownRight, ArrowUpRight, X, RefreshCw } from 'lucide-react';
import { usePresence } from '../hooks/usePresence';
import { useDashboardStats } from '../hooks/useDashboardStats';
import { usePresenceRealtime } from '../hooks/usePresenceRealtime';
import { useManagedDepartments } from '../hooks/useManagedDepartments';
import { useTimesheetMonthAccess } from '../hooks/useTimesheetMonthAccess';
import type { DashboardPeriod } from '../types';
import { filterDepartmentTreeByIds, findDepartmentName } from '../utils/departmentUtils';
import { DepartmentTreeSelect } from '../components/staff/DepartmentTreeSelect';
import '../styles/DashboardPage.css';

const ActivityList = lazy(() => import('../components/dashboard/ActivityList').then(m => ({ default: m.ActivityList })));
const PunctualityCard = lazy(() => import('../components/dashboard/AnalyticsRow').then(m => ({ default: m.PunctualityCard })));
const AvgArrivalCard = lazy(() => import('../components/dashboard/AnalyticsRow').then(m => ({ default: m.AvgArrivalCard })));
const ComparisonCard = lazy(() => import('../components/dashboard/DashboardSidebar').then(m => ({ default: m.ComparisonCard })));
const LiveEventsCard = lazy(() => import('../components/dashboard/stats/LiveEventsCard').then(m => ({ default: m.LiveEventsCard })));

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

const DashboardSectionFallback = () => (
  <div className="dash-placeholder" style={{ minHeight: 160 }}>
    <div className="loading-spinner" />
    <p>Загрузка блока...</p>
  </div>
);

export const DashboardPage: React.FC = () => {
  const {
    isDepartmentScope,
    managedDepartmentIds,
    primaryDepartmentId,
    structureQuery,
  } = useManagedDepartments();
  const { isWindowEnforced, minDate, maxDate } = useTimesheetMonthAccess({ enforceWhen: isDepartmentScope });
  const isSingleManagedDept = isDepartmentScope && managedDepartmentIds.length === 1;
  const noDepartmentsAssigned = isDepartmentScope && managedDepartmentIds.length === 0;

  const today = new Date().toLocaleDateString('ru-RU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  // Department selector
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedDeptId = searchParams.get('dept');
  // Для руководителя с одним отделом — единственный отдел подставляется автоматически.
  // Для руководителя с несколькими отделами и для админа — отдел выбирает пользователь
  // (если URL пустой → null → показывается placeholder с меню выбора).
  const effectiveSelectedDeptId = selectedDeptId
    || (isSingleManagedDept ? primaryDepartmentId ?? managedDepartmentIds[0] ?? null : null);

  // Для руководителя с одним отделом: фиксируем его в URL, чтобы остальные хуки
  // (presence, stats) видели стабильный dept и кэш не сбрасывался.
  useEffect(() => {
    if (!isSingleManagedDept) return;
    const defaultId = primaryDepartmentId ?? managedDepartmentIds[0] ?? null;
    if (!defaultId) return;
    if (searchParams.get('dept') === defaultId) return;

    const next = new URLSearchParams(searchParams);
    next.set('dept', defaultId);
    setSearchParams(next, { replace: true });
  }, [isSingleManagedDept, primaryDepartmentId, managedDepartmentIds, searchParams, setSearchParams]);

  const deptTree = useMemo(() => {
    const allNodes = structureQuery.data?.departments ?? [];
    if (isDepartmentScope) {
      return filterDepartmentTreeByIds(allNodes, new Set(managedDepartmentIds));
    }
    return allNodes;
  }, [structureQuery.data, isDepartmentScope, managedDepartmentIds]);

  const selectedDeptName = useMemo(
    () => (effectiveSelectedDeptId ? findDepartmentName(deptTree, effectiveSelectedDeptId) : null),
    [effectiveSelectedDeptId, deptTree],
  );

  // Month picker (YYYY-MM)
  const getCurrentMonth = () => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  };

  // Period toggle
  const [period, setPeriod] = useState<DashboardPeriod>(() => {
    const urlPeriod = searchParams.get('period');
    return urlPeriod === 'week' || urlPeriod === 'month' ? urlPeriod : 'today';
  });
  const [selectedMonth, setSelectedMonth] = useState(() => {
    const urlMonth = searchParams.get('month');
    return urlMonth && /^\d{4}-\d{2}$/.test(urlMonth) ? urlMonth : getCurrentMonth();
  });

  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (period === 'today') next.delete('period');
    else next.set('period', period);

    if (period === 'month') next.set('month', selectedMonth);
    else next.delete('month');

    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
  }, [period, searchParams, selectedMonth, setSearchParams]);

  const prevMonthLimit = minDate ? minDate.slice(0, 7) : '';
  const nextMonthLimit = maxDate ? maxDate.slice(0, 7) : '';
  const isTooOldMonth = isWindowEnforced && selectedMonth <= prevMonthLimit;

  useEffect(() => {
    if (!isWindowEnforced) return;
    if (selectedMonth < prevMonthLimit) {
      queueMicrotask(() => setSelectedMonth(prevMonthLimit));
    } else if (selectedMonth > nextMonthLimit) {
      queueMicrotask(() => setSelectedMonth(nextMonthLimit));
    }
  }, [isWindowEnforced, prevMonthLimit, nextMonthLimit, selectedMonth]);

  const shiftMonth = (delta: number) => {
    const [y, m] = selectedMonth.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    const next = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (isWindowEnforced) {
      if (delta < 0 && next < prevMonthLimit) return;
      if (delta > 0 && next > nextMonthLimit) return;
    }
    setSelectedMonth(next);
  };

  const MONTH_NAMES = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
  const formatMonth = (ym: string) => {
    const [y, m] = ym.split('-').map(Number);
    return `${MONTH_NAMES[m - 1]} ${y}`;
  };

  const isFutureMonth = isWindowEnforced ? selectedMonth >= nextMonthLimit : selectedMonth >= getCurrentMonth();
  const employeeCardBackState = useMemo(() => {
    const params = new URLSearchParams();
    if (effectiveSelectedDeptId) params.set('dept', effectiveSelectedDeptId);
    if (period !== 'today') params.set('period', period);
    if (period === 'month') params.set('month', selectedMonth);
    const query = params.toString();
    return {
      label: 'Обзор',
      from: `/dashboard${query ? `?${query}` : ''}`,
    };
  }, [effectiveSelectedDeptId, period, selectedMonth]);

  // Data
  const { employees, loading, refresh: refreshPresence } = usePresence(effectiveSelectedDeptId);
  const { stats, loading: statsLoading, refresh: refreshStats } = useDashboardStats(
    effectiveSelectedDeptId,
    period,
    period === 'month' ? selectedMonth : undefined,
  );

  const handlePresenceRealtime = useCallback(() => {
    refreshPresence();
    refreshStats();
  }, [refreshPresence, refreshStats]);

  const handleDashboardVisible = useCallback(() => {
    refreshPresence();
    refreshStats();
  }, [refreshPresence, refreshStats]);

  const [isRefreshing, setIsRefreshing] = useState(false);
  const handleManualRefresh = useCallback(() => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    refreshPresence();
    refreshStats(true);
    window.setTimeout(() => setIsRefreshing(false), 600);
  }, [isRefreshing, refreshPresence, refreshStats]);

  // Подписка не должна зависеть от выбора отдела: для админа без выбранного
  // отдела effectiveSelectedDeptId = null, но дашборд всё равно показывает
  // данные по всему порталу и должен оживать на presence_updated.
  usePresenceRealtime({
    enabled: true,
    owner: 'dashboard-presence',
    onPresenceUpdate: handlePresenceRealtime,
    onVisible: handleDashboardVisible,
  });

  const onlineCount = useMemo(
    () => employees.filter(e => e.status === 'online').length,
    [employees],
  );

  const [lateModalOpen, setLateModalOpen] = useState(false);
  const [expandedLateId, setExpandedLateId] = useState<number | null>(null);
  const navigate = useNavigate();

  const handleDeptSelect = (deptId: string) => {
    const next = new URLSearchParams(searchParams);
    if (deptId) next.set('dept', deptId);
    else next.delete('dept');
    setSearchParams(next, { replace: true });
  };

  const deptSelector = isSingleManagedDept ? (
    <div className="dash-dept-dropdown">
      <div className="dash-dept-trigger has-value" style={{ cursor: 'default' }}>
        <Building2 size={14} className="dash-dept-search-icon" />
        <span className="dash-dept-input" style={{ cursor: 'default' }}>
          {selectedDeptName ?? 'Мой отдел'}
        </span>
      </div>
    </div>
  ) : (
    <DepartmentTreeSelect
      departments={deptTree}
      value={effectiveSelectedDeptId ?? ''}
      onChange={handleDeptSelect}
      isLoading={structureQuery.isPending}
      isError={structureQuery.isError}
      onRetry={() => { void structureQuery.refetch(); }}
    />
  );

  return (
    <>
      {!effectiveSelectedDeptId ? (
        noDepartmentsAssigned ? (
          <div className="dash-placeholder">
            <Building2 size={48} strokeWidth={1.2} />
            <h3>Нет доступных отделов</h3>
            <p>Для вашей роли ещё не настроен доступ к отделам. Обратитесь в администрацию.</p>
          </div>
        ) : (
          <div className="dash-placeholder">
            <Building2 size={48} strokeWidth={1.2} />
            <h3>Выберите отдел</h3>
            <p>Чтобы увидеть статистику присутствия</p>
            {deptSelector}
          </div>
        )
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
                <button
                  type="button"
                  className="dash-refresh-btn"
                  onClick={handleManualRefresh}
                  disabled={isRefreshing}
                  title="Обновить данные дашборда"
                  aria-label="Обновить"
                >
                  <RefreshCw size={13} className={isRefreshing ? 'dash-refresh-spin' : undefined} />
                </button>
              </div>
            </div>
            {deptSelector}
          </div>

          <div className="dashboard-columns">
            <div className="col-activity">
              <Suspense fallback={<DashboardSectionFallback />}>
                <ActivityList employees={employees} loading={loading} employeeCardBackState={employeeCardBackState} />
              </Suspense>
            </div>

            <div className="col-events">
              <Suspense fallback={<DashboardSectionFallback />}>
                <LiveEventsCard
                  events={stats?.recentEvents ?? []}
                  totalCount={(stats?.todayEntriesCount ?? 0) + (stats?.todayExitsCount ?? 0)}
                />
              </Suspense>
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
                    <button
                      className="month-picker-btn"
                      onClick={() => shiftMonth(-1)}
                      disabled={isTooOldMonth}
                      title={isTooOldMonth ? 'Месяц вне доступного окна для вашей роли' : undefined}
                    >
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
                <Suspense fallback={<DashboardSectionFallback />}>
                  <PunctualityCard punctuality={stats.punctuality} period={period} />
                  <AvgArrivalCard data={stats.avgArrivalByDay} period={period} />
                  <ComparisonCard comparison={stats.weekComparison} period={period} />
                </Suspense>
              )}
            </div>
          </div>
        </div>
      )}
      {/* Late rating modal */}
      {lateModalOpen && stats && (
        <div className="dash-modal-overlay" onClick={() => setLateModalOpen(false)}>
          <div className={`dash-modal ${period !== 'today' ? 'dash-modal--period' : ''}`} onClick={e => e.stopPropagation()}>
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
                              navigate(`/employees/${item.employee_id}`, { state: employeeCardBackState });
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
