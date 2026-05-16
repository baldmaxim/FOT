import { type FC, useState, useEffect, useMemo, memo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Star, Search, X } from 'lucide-react';
import { Card, CardContent } from '../ui/Card';
import { useFavorites } from '../../hooks/useFavorites';
import type { IEmployeePresence } from '../../types';
import styles from './ActivityList.module.css';

type TabFilter = 'favorites' | 'all' | 'online' | 'offline' | 'absent';

interface IActivityListProps {
  employees: IEmployeePresence[];
  loading: boolean;
  employeeCardBackState: { label: string; from: string };
}

const getInitials = (name: string): string => {
  const parts = name.split(' ');
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return name.slice(0, 2).toUpperCase();
};

const getTimelinePercent = (employee: IEmployeePresence): number => {
  if (employee.status === 'unknown') return 0;
  if (employee.status === 'online') {
    const timeStr = employee.first_entry || employee.since;
    if (!timeStr) return 0;
    const now = new Date();
    const [h, m] = timeStr.split(':').map(Number);
    const entry = new Date();
    entry.setHours(h, m, 0, 0);
    const hoursWorked = (now.getTime() - entry.getTime()) / (1000 * 60 * 60);
    return Math.min(100, Math.round((hoursWorked / 8) * 100));
  }
  if (employee.total_hours != null && employee.total_hours > 0) {
    return Math.min(100, Math.round((employee.total_hours / 8) * 100));
  }
  return 0;
};

const formatWorkTime = (hours: number): string => {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  if (h > 0) return `${h}ч ${m}м`;
  return `${m}м`;
};

const getWorkElapsed = (employee: IEmployeePresence): string => {
  if (employee.status === 'online') {
    const timeStr = employee.first_entry || employee.since;
    if (timeStr) {
      const now = new Date();
      const [h, m] = timeStr.split(':').map(Number);
      const entry = new Date();
      entry.setHours(h, m, 0, 0);
      const diffMs = now.getTime() - entry.getTime();
      if (diffMs < 0) return '0м';
      const totalMin = Math.floor(diffMs / 60_000);
      const hours = Math.floor(totalMin / 60);
      const mins = totalMin % 60;
      return hours > 0 ? `${hours}ч ${mins}м` : `${mins}м`;
    }
  }
  if (employee.total_hours != null && employee.total_hours > 0) {
    return formatWorkTime(employee.total_hours);
  }
  return '';
};

const formatOutsideTime = (minutes: number): string => {
  if (minutes < 1) return '0м';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}ч ${m}м` : `${m}м`;
};

const EmployeeRow = memo<{
  employee: IEmployeePresence;
  isFavorite: boolean;
  onToggleFavorite: (id: number) => void;
  tick: number;
  employeeCardBackState: { label: string; from: string };
}>(({ employee, isFavorite, onToggleFavorite, tick, employeeCardBackState }) => {
  const navigate = useNavigate();

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const workTime = useMemo(() => getWorkElapsed(employee), [employee, tick]);

  const isOnline = employee.status === 'online';
  const isOffline = employee.status === 'offline';
  const timelineWidth = getTimelinePercent(employee);
  const arrivalTime = employee.first_entry ? employee.first_entry.slice(0, 5) : null;
  const isLate = arrivalTime ? arrivalTime > '09:00' : false;
  const outsideMin = employee.time_outside_minutes || 0;
  const outsideWarning = outsideMin > 60;

  return (
    <div className={styles.item} onClick={() => navigate(`/employees/${employee.employee_id}`, { state: employeeCardBackState })}>
      <button
        className={`${styles.starBtn} ${isFavorite ? styles.starActive : ''}`}
        onClick={e => { e.stopPropagation(); onToggleFavorite(employee.employee_id); }}
        title={isFavorite ? 'Убрать из избранного' : 'Добавить в избранное'}
      >
        <Star size={14} fill={isFavorite ? 'currentColor' : 'none'} />
      </button>

      {/* Аватар + огонёк присутствия */}
      <div className={styles.avatarWrap}>
        <div className={styles.avatar}>{getInitials(employee.full_name)}</div>
        <span className={`${styles.presenceDot} ${isOnline ? styles.dotOnline : isOffline ? styles.dotOffline : styles.dotUnknown}`} />
      </div>

      {/* ФИО + должность */}
      <div className={styles.content}>
        <div className={styles.name}>{employee.full_name}</div>
        <div className={styles.meta}>
          {employee.position_name || employee.department_name || ''}
        </div>
      </div>

      {/* Приход */}
      <div className={styles.arrivalBlock}>
        {arrivalTime && (
          <span className={`${styles.arrivalTime} ${isLate ? styles.arrivalLate : ''}`}>
            → {arrivalTime}
          </span>
        )}
      </div>

      {/* Таймлайн */}
      {timelineWidth > 0 && (
        <div className={styles.timeline}>
          <div
            className={`${styles.timelineFill} ${isOffline ? styles.stopped : styles.full}`}
            style={{ width: `${timelineWidth}%` }}
          />
        </div>
      )}

      {/* Отработано / отсутствие */}
      <div className={styles.times}>
        {workTime && (
          <span className={`${styles.time} ${isOffline ? styles.timeStopped : ''}`}>
            {workTime}
          </span>
        )}
        {outsideMin > 0 && (
          <span className={`${styles.outsideTime} ${outsideWarning ? styles.outsideWarning : ''}`}>
            {outsideWarning && '⚠ '}{formatOutsideTime(outsideMin)} вне
          </span>
        )}
        {employee.exit_count > 0 && (
          <span className={styles.exitInfo}>
            {employee.exit_count} вых.
          </span>
        )}
      </div>

      {/* Статус + локация (выровнены) */}
      <div className={styles.badges}>
        <span className={`${styles.status} ${isOnline ? styles.in : isOffline ? styles.out : styles.unknown}`}>
          {isOnline ? 'На месте' : isOffline ? 'Вышел' : '—'}
        </span>
        {employee.last_access_point && (
          <span className={styles.locationBadge}>
            📍 {employee.last_access_point}
          </span>
        )}
      </div>
    </div>
  );
});

export const ActivityList: FC<IActivityListProps> = ({ employees, loading, employeeCardBackState }) => {
  const [tab, setTab] = useState<TabFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const { favorites, toggle, isFavorite } = useFavorites();

  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const onlineCount = useMemo(() => employees.filter(e => e.status === 'online').length, [employees]);
  const offlineCount = useMemo(() => employees.filter(e => e.status === 'offline').length, [employees]);
  const absentCount = useMemo(() => employees.filter(e => e.status === 'unknown').length, [employees]);
  const favCount = useMemo(() => employees.filter(e => favorites.has(e.employee_id)).length, [employees, favorites]);

  const filtered = useMemo(() => {
    let list = employees;
    if (tab === 'favorites') list = list.filter(e => favorites.has(e.employee_id));
    else if (tab === 'online') list = list.filter(e => e.status === 'online');
    else if (tab === 'offline') list = list.filter(e => e.status === 'offline');
    else if (tab === 'absent') list = list.filter(e => e.status === 'unknown');

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter(e => e.full_name.toLowerCase().includes(q));
    }

    return [...list].sort((a, b) => {
      const aFav = favorites.has(a.employee_id) ? 0 : 1;
      const bFav = favorites.has(b.employee_id) ? 0 : 1;
      return aFav - bFav;
    });
  }, [employees, tab, favorites, searchQuery]);

  if (loading) {
    return (
      <Card className={styles.card}>
        <div className={styles.headerRow}>
          <h2 className={styles.headerTitle}>Присутствие сотрудников</h2>
        </div>
        <CardContent className={styles.cardContent}>
          <div className={styles.empty}>
            <span className={styles.emptyText}>Загрузка...</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={styles.card}>
      <div className={styles.headerRow}>
        <h2 className={styles.headerTitle}>Присутствие сотрудников</h2>
        <div className={styles.headerSearch}>
          <Search size={14} className={styles.searchIcon} />
          <input
            type="text"
            className={styles.searchInput}
            placeholder="Поиск..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button className={styles.searchClear} onClick={() => setSearchQuery('')}>
              <X size={12} />
            </button>
          )}
        </div>
      </div>
      <CardContent className={styles.cardContent}>
        <div className={styles.tabs}>
          {favCount > 0 && (
            <button
              className={`${styles.tab} ${tab === 'favorites' ? styles.tabActive : ''}`}
              onClick={() => setTab('favorites')}
            >
              <Star size={13} fill={tab === 'favorites' ? 'currentColor' : 'none'} />
              Избранные <span className={styles.tabCount}>{favCount}</span>
            </button>
          )}
          <button className={`${styles.tab} ${tab === 'all' ? styles.tabActive : ''}`} onClick={() => setTab('all')}>
            Все <span className={styles.tabCount}>{employees.length}</span>
          </button>
          <button className={`${styles.tab} ${tab === 'online' ? styles.tabActive : ''}`} onClick={() => setTab('online')}>
            На месте <span className={styles.tabCount}>{onlineCount}</span>
          </button>
          <button className={`${styles.tab} ${tab === 'offline' ? styles.tabActive : ''}`} onClick={() => setTab('offline')}>
            Вышли <span className={styles.tabCount}>{offlineCount}</span>
          </button>
          <button className={`${styles.tab} ${tab === 'absent' ? styles.tabActive : ''}`} onClick={() => setTab('absent')}>
            Отсутствуют <span className={styles.tabCount}>{absentCount}</span>
          </button>
        </div>
        <div className={styles.list}>
          {filtered.length === 0 ? (
            <div className={styles.empty}>
              <span className={styles.emptyText}>
                {tab === 'favorites' ? 'Нет избранных сотрудников' : employees.length === 0 ? 'Нет данных' : 'Нет сотрудников'}
              </span>
              {employees.length === 0 && (
                <span className={styles.emptyHint}>Выберите отдел для просмотра</span>
              )}
            </div>
          ) : (
            filtered.map(emp => (
              <EmployeeRow
                key={emp.employee_id}
                employee={emp}
                isFavorite={isFavorite(emp.employee_id)}
                onToggleFavorite={toggle}
                tick={tick}
                employeeCardBackState={employeeCardBackState}
              />
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
};
