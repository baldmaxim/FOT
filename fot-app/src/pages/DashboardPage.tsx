import React, { useEffect, useMemo, useRef, useState, memo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronDown, ChevronLeft, ChevronRight, Search, Building2, LogOut } from 'lucide-react';
import { StatCard } from '../components/ui/StatCard';
import { ActivityList } from '../components/dashboard/ActivityList';
import { PunctualityCard, AvgArrivalCard, RisksCard } from '../components/dashboard/AnalyticsRow';
import { HourlyActivityCard, ComparisonCard, TopLateCard } from '../components/dashboard/DashboardSidebar';
import { PresenceTodayCard } from '../components/dashboard/stats/PresenceTodayCard';
import { LatenessCard } from '../components/dashboard/stats/LatenessCard';
import { LiveEventsCard } from '../components/dashboard/stats/LiveEventsCard';
import { usePresence } from '../hooks/usePresence';
import { useDashboardStats } from '../hooks/useDashboardStats';
import { useAuth } from '../contexts/AuthContext';
import { apiClient } from '../api/client';
import type { DashboardPeriod } from '../types';
import {
  MapPinIcon,
  CheckCircleIcon,
  ClockIcon,
} from '../components/ui/Icons';
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

const ATTENDANCE_TARGET = 90;

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

  const presencePercent = useMemo(
    () => employees.length > 0 ? Math.round((onlineCount / employees.length) * 100) : 0,
    [employees, onlineCount],
  );

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
              <PresenceTodayCard
                online={onlineCount}
                total={employees.length}
                absent={employees.length - onlineCount}
                target={ATTENDANCE_TARGET}
                current={presencePercent}
              />
              <LatenessCard
                lateCount={stats?.lateToday ?? 0}
                earlyLeaveCount={stats?.earlyLeaveToday ?? 0}
                entries={stats?.todayEntriesCount ?? 0}
                exits={stats?.todayExitsCount ?? 0}
              />

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

              {period !== 'today' && stats?.periodStats && (
                <div className="period-stat-cards">
                  <StatCard
                    label="Ср. посещаемость"
                    value={String(stats.periodStats.avgPresent)}
                    icon={<MapPinIcon />}
                    iconType="green"
                    change={`из ${employees.length} в день`}
                    changeType="neutral"
                  />
                  <StatCard
                    label="Ср. отсутствие"
                    value={String(stats.periodStats.avgAbsent)}
                    icon={<LogOut size={18} />}
                    iconType="red"
                    change="в среднем за день"
                    changeType="neutral"
                  />
                  <StatCard
                    label="Посещаемость"
                    value={`${stats.periodStats.attendanceRate}%`}
                    icon={<CheckCircleIcon />}
                    iconType="green"
                  />
                  <StatCard
                    label={period === 'week' ? 'Опоздания за неделю' : 'Опоздания за месяц'}
                    value={String(stats.periodStats.lateCount)}
                    icon={<ClockIcon />}
                    iconType="orange"
                    change={`${stats.periodStats.lateCount > stats.periodStats.prevLateCount ? '+' : ''}${stats.periodStats.lateCount - stats.periodStats.prevLateCount} к пред. ${period === 'week' ? 'неделе' : 'месяцу'}`}
                    changeType={stats.periodStats.lateCount > stats.periodStats.prevLateCount ? 'negative' : stats.periodStats.lateCount < stats.periodStats.prevLateCount ? 'positive' : 'neutral'}
                  />
                </div>
              )}

              {stats && !statsLoading && (
                <>
                  <PunctualityCard punctuality={stats.punctuality} period={period} />
                  <AvgArrivalCard data={stats.avgArrivalByDay} period={period} />
                  <HourlyActivityCard data={stats.hourlyActivity} period={period} />
                  <ComparisonCard comparison={stats.weekComparison} period={period} />
                  <RisksCard risks={stats.risks} period={period} />
                  <TopLateCard data={stats.topLate} period={period} />
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
};
