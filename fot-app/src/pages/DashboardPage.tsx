import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronDown, Search, Building2, LogOut } from 'lucide-react';
import { StatCard } from '../components/ui/StatCard';
import { ActivityList } from '../components/dashboard/ActivityList';
import { AnalyticsRow } from '../components/dashboard/AnalyticsRow';
import { DashboardSidebar } from '../components/dashboard/DashboardSidebar';
import { usePresence } from '../hooks/usePresence';
import { useDashboardStats } from '../hooks/useDashboardStats';
import { apiClient } from '../api/client';
import type { DashboardPeriod } from '../types';
import {
  UsersIcon,
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
    result.push(...flattenDbTree(node.children, level + 1));
  }
  return result;
};

const getWeekInfo = (): { weekNumber: number; workDay: number } => {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  const diff = now.getTime() - start.getTime();
  const weekNumber = Math.ceil((diff / 86400000 + start.getDay() + 1) / 7);
  const day = now.getDay();
  const workDay = day === 0 ? 0 : day === 6 ? 0 : day;
  return { weekNumber, workDay };
};

export const DashboardPage: React.FC = () => {
  const today = new Date().toLocaleDateString('ru-RU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const { weekNumber, workDay } = useMemo(() => getWeekInfo(), []);

  // Department selector
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedDeptId = searchParams.get('dept');
  const [deptOptions, setDeptOptions] = useState<IDeptFlatOption[]>([]);
  const [deptDropdownOpen, setDeptDropdownOpen] = useState(false);
  const [deptSearchQuery, setDeptSearchQuery] = useState('');
  const deptDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    apiClient.get<{ success: boolean; data: { departments: IDbDepartment[] } }>('/structure')
      .then(res => {
        const departments = res.data?.departments || [];
        setDeptOptions(flattenDbTree(departments));
      })
      .catch(() => {});
  }, []);

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

  // Data
  const { employees, loading } = usePresence(selectedDeptId);
  const { stats, loading: statsLoading } = useDashboardStats(selectedDeptId, period);

  const onlineCount = useMemo(
    () => employees.filter(e => e.status === 'online').length,
    [employees],
  );

  const offlineCount = useMemo(
    () => employees.filter(e => e.status === 'offline').length,
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

  const deptSelector = (
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
                style={{ paddingLeft: 12 + dept.level * 16 }}
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
        <>
          <div className="content-header">
            <div>
              <div className="date-display">{today}</div>
              <div className="date-subtitle">Неделя {weekNumber} · Рабочий день {workDay}/5</div>
            </div>
            {deptSelector}
          </div>

          <div className="stats-section">
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
            <div className="stats-row">
              <StatCard
                label="Всего сотрудников"
                value={employees.length > 0 ? String(employees.length) : '—'}
                icon={<UsersIcon />}
                iconType="blue"
                change="Без изменений"
                changeType="neutral"
              />
              {period === 'today' ? (
                <>
                  <StatCard
                    label="В офисе"
                    value={onlineCount > 0 ? String(onlineCount) : '—'}
                    icon={<MapPinIcon />}
                    iconType="green"
                    change={`${onlineCount > 0 ? '+' : ''}${onlineCount} сегодня`}
                    changeType="positive"
                  />
                  <StatCard
                    label="Вышли"
                    value={offlineCount > 0 ? String(offlineCount) : '—'}
                    icon={<LogOut size={18} />}
                    iconType="red"
                    change={offlineCount === 0 ? 'Никто не ушёл' : undefined}
                    changeType="neutral"
                  />
                  <StatCard
                    label="Присутствие"
                    value={employees.length > 0 ? `${presencePercent}%` : '—'}
                    icon={<CheckCircleIcon />}
                    iconType="green"
                  />
                  <StatCard
                    label="Опоздания сегодня"
                    value={stats ? String(stats.lateToday) : '—'}
                    icon={<ClockIcon />}
                    iconType="orange"
                    change={stats ? `${stats.lateToday > stats.lateYesterday ? '+' : ''}${stats.lateToday - stats.lateYesterday} к вчера` : undefined}
                    changeType={stats ? (stats.lateToday > stats.lateYesterday ? 'negative' : stats.lateToday < stats.lateYesterday ? 'positive' : 'neutral') : 'neutral'}
                  />
                </>
              ) : (
                <>
                  <StatCard
                    label="Ср. посещаемость"
                    value={stats?.periodStats ? String(stats.periodStats.avgPresent) : '—'}
                    icon={<MapPinIcon />}
                    iconType="green"
                    change={stats?.periodStats ? `из ${employees.length} в день` : undefined}
                    changeType="neutral"
                  />
                  <StatCard
                    label="Ср. отсутствие"
                    value={stats?.periodStats ? String(stats.periodStats.avgAbsent) : '—'}
                    icon={<LogOut size={18} />}
                    iconType="red"
                    change={stats?.periodStats ? `в среднем за день` : undefined}
                    changeType="neutral"
                  />
                  <StatCard
                    label="Посещаемость"
                    value={stats?.periodStats ? `${stats.periodStats.attendanceRate}%` : '—'}
                    icon={<CheckCircleIcon />}
                    iconType="green"
                  />
                  <StatCard
                    label={period === 'week' ? 'Опоздания за неделю' : 'Опоздания за месяц'}
                    value={stats?.periodStats ? String(stats.periodStats.lateCount) : '—'}
                    icon={<ClockIcon />}
                    iconType="orange"
                    change={stats?.periodStats ? `${stats.periodStats.lateCount > stats.periodStats.prevLateCount ? '+' : ''}${stats.periodStats.lateCount - stats.periodStats.prevLateCount} к пред. ${period === 'week' ? 'неделе' : 'месяцу'}` : undefined}
                    changeType={stats?.periodStats ? (stats.periodStats.lateCount > stats.periodStats.prevLateCount ? 'negative' : stats.periodStats.lateCount < stats.periodStats.prevLateCount ? 'positive' : 'neutral') : 'neutral'}
                  />
                </>
              )}
            </div>
          </div>

          {stats && !statsLoading && <AnalyticsRow stats={stats} />}

          <div className="main-grid">
            <ActivityList employees={employees} loading={loading} />
            {stats && !statsLoading && <DashboardSidebar stats={stats} />}
          </div>
        </>
      )}
    </>
  );
};
