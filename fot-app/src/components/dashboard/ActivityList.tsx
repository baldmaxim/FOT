import { type FC, useState, useEffect, useMemo, memo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Star, Search, X } from 'lucide-react';
import { Card, CardContent } from '../ui/Card';
import { formatElapsed } from '../../utils/formatElapsed';
import { useFavorites } from '../../hooks/useFavorites';
import type { IEmployeePresence } from '../../types';
import styles from './ActivityList.module.css';

type TabFilter = 'favorites' | 'all' | 'online' | 'offline' | 'absent';

interface IActivityListProps {
  employees: IEmployeePresence[];
  loading: boolean;
}

const getInitials = (name: string): string => {
  const parts = name.split(' ');
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return name.slice(0, 2).toUpperCase();
};

/** Прогресс рабочего дня (0-100%): online — от first_entry/since, offline — от total_hours */
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

/** Прогноз ухода: arrival + 9 часов (8ч работы + 1ч обед) */
const getLeaveInfo = (firstEntry: string | null): { leaveTime: string; remaining: string } | null => {
  if (!firstEntry) return null;
  const [h, m] = firstEntry.split(':').map(Number);
  const arrival = new Date();
  arrival.setHours(h, m, 0, 0);
  const leave = new Date(arrival.getTime() + 9 * 60 * 60 * 1000);
  const leaveTime = `${String(leave.getHours()).padStart(2, '0')}:${String(leave.getMinutes()).padStart(2, '0')}`;
  const now = new Date();
  const diffMs = leave.getTime() - now.getTime();
  if (diffMs <= 0) return { leaveTime, remaining: '' };
  const remH = Math.floor(diffMs / (1000 * 60 * 60));
  const remM = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  return { leaveTime, remaining: `${remH}ч ${remM}м` };
};

/** Форматирование минут вне офиса */
const formatOutsideTime = (minutes: number): string => {
  if (minutes < 1) return '0м';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}ч ${m}м` : `${m}м`;
};

/** Форматирование часов/минут из total_hours (число) */
const formatWorkTime = (hours: number): string => {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  if (h > 0) return `${h}ч ${m}м`;
  return `${m}м`;
};

/** Время присутствия: для online считаем от first_entry (fallback на since), для offline берём total_hours */
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

const EmployeeRow = memo<{
  employee: IEmployeePresence;
  isFavorite: boolean;
  onToggleFavorite: (id: number) => void;
  tick: number;
}>(({ employee, isFavorite, onToggleFavorite, tick }) => {
  const navigate = useNavigate();

  // eslint-disable-next-line react-hooks/exhaustive-deps -- tick forces recalculation every minute
  const workTime = useMemo(() => getWorkElapsed(employee), [employee, tick]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- tick forces recalculation every minute
  const absentTime = useMemo(() => (employee.status === 'offline' ? formatElapsed(employee.since) : ''), [employee.status, employee.since, tick]);

  const isOnline = employee.status === 'online';
  const isOffline = employee.status === 'offline';
  const timelineWidth = getTimelinePercent(employee);

  const arrivalTime = employee.first_entry ? employee.first_entry.slice(0, 5) : null;
  const isLate = arrivalTime ? arrivalTime > '09:00' : false;
  const leaveInfo = isOnline ? getLeaveInfo(employee.first_entry) : null;
  const punct = employee.punctuality_percent;

  return (
    <div className={styles.item} onClick={() => navigate(`/tender/${employee.employee_id}`, { state: { from: '/dashboard', label: 'Обзор' } })}>
      <button
        className={`${styles.starBtn} ${isFavorite ? styles.starActive : ''}`}
        onClick={e => { e.stopPropagation(); onToggleFavorite(employee.employee_id); }}
        title={isFavorite ? 'Убрать из избранного' : 'Добавить в избранное'}
      >
        <Star size={14} fill={isFavorite ? 'currentColor' : 'none'} />
      </button>
      <div className={styles.avatar}>{getInitials(employee.full_name)}</div>
      <div className={styles.arrivalBlock}>
        {arrivalTime && (
          <span className={`${styles.arrivalTime} ${isLate ? styles.arrivalLate : ''}`}>
            → {arrivalTime}
          </span>
        )}
        {leaveInfo && (
          <span className={styles.leaveForecast}>
            {leaveInfo.remaining ? `~ до конца ${leaveInfo.remaining}` : `~ уйдёт в ${leaveInfo.leaveTime}`}
          </span>
        )}
      </div>
      <div className={styles.content}>
        <div className={styles.name}>{employee.full_name}</div>
        <div className={styles.meta}>
          {employee.position_name || employee.department_name || ''}
        </div>
      </div>
      {timelineWidth > 0 && (
        <div className={styles.timeline}>
          <div
            className={`${styles.timelineFill} ${isOffline ? styles.stopped : styles.full}`}
            style={{ width: `${timelineWidth}%` }}
          />
        </div>
      )}
      <div className={styles.badges}>
        <span className={`${styles.status} ${isOnline ? styles.in : isOffline ? styles.out : styles.unknown}`}>
          {isOnline ? 'В офисе' : isOffline ? 'Вышел' : '—'}
        </span>
        {employee.last_access_point && (
          <span className={styles.locationBadge}>
            📍 {employee.last_access_point}
          </span>
        )}
        {punct != null && (
          <span className={`${styles.punctBadge} ${punct >= 90 ? styles.punctGood : styles.punctWarn}`}>
            {punct}%
          </span>
        )}
      </div>
      <div className={styles.times}>
        {workTime && <span className={`${styles.time} ${isOffline ? styles.timeStopped : ''}`}>{workTime}</span>}
        {isOffline && absentTime && <span className={styles.absentTime}>−{absentTime}</span>}
        {employee.exit_count > 0 && (
          <span className={styles.exitInfo}>
            {employee.exit_count} вых. · {formatOutsideTime(employee.time_outside_minutes)}
          </span>
        )}
      </div>
    </div>
  );
});

export const ActivityList: FC<IActivityListProps> = ({ employees, loading }) => {
  const [tab, setTab] = useState<TabFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const { favorites, toggle, isFavorite } = useFavorites();

  // Единый таймер для обновления времени (вместо per-row intervals)
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

    // Избранные наверху
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
          <button
            className={`${styles.tab} ${tab === 'all' ? styles.tabActive : ''}`}
            onClick={() => setTab('all')}
          >
            Все <span className={styles.tabCount}>{employees.length}</span>
          </button>
          <button
            className={`${styles.tab} ${tab === 'online' ? styles.tabActive : ''}`}
            onClick={() => setTab('online')}
          >
            В офисе <span className={styles.tabCount}>{onlineCount}</span>
          </button>
          <button
            className={`${styles.tab} ${tab === 'offline' ? styles.tabActive : ''}`}
            onClick={() => setTab('offline')}
          >
            Вышли <span className={styles.tabCount}>{offlineCount}</span>
          </button>
          <button
            className={`${styles.tab} ${tab === 'absent' ? styles.tabActive : ''}`}
            onClick={() => setTab('absent')}
          >
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
              />
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
};
