import { type FC, useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Star, Search } from 'lucide-react';
import { Card, CardHeader, CardContent } from '../ui/Card';
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

const EmployeeRow: FC<{
  employee: IEmployeePresence;
  isFavorite: boolean;
  onToggleFavorite: (id: number) => void;
}> = ({ employee, isFavorite, onToggleFavorite }) => {
  const navigate = useNavigate();

  // Время присутствия (обновляем каждую минуту для online)
  const [workTime, setWorkTime] = useState(() => getWorkElapsed(employee));
  // Время отсутствия для offline (с момента выхода)
  const [absentTime, setAbsentTime] = useState(() =>
    employee.status === 'offline' ? formatElapsed(employee.since) : '',
  );

  useEffect(() => {
    setWorkTime(getWorkElapsed(employee));
    setAbsentTime(employee.status === 'offline' ? formatElapsed(employee.since) : '');
    const timer = setInterval(() => {
      setWorkTime(getWorkElapsed(employee));
      setAbsentTime(employee.status === 'offline' ? formatElapsed(employee.since) : '');
    }, 60_000);
    return () => clearInterval(timer);
  }, [employee.since, employee.status, employee.first_entry, employee.total_hours]);

  const isOnline = employee.status === 'online';
  const isOffline = employee.status === 'offline';
  const timelineWidth = getTimelinePercent(employee);

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
      <span className={`${styles.status} ${isOnline ? styles.in : isOffline ? styles.out : styles.unknown}`}>
        {isOnline ? 'В офисе' : isOffline ? 'Вышел' : '—'}
      </span>
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
};

export const ActivityList: FC<IActivityListProps> = ({ employees, loading }) => {
  const [tab, setTab] = useState<TabFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const { favorites, toggle, isFavorite } = useFavorites();

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
        <CardHeader title="Присутствие сотрудников" />
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
      <CardHeader title="Присутствие сотрудников" />
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
        <div className={styles.searchBar}>
          <Search size={14} className={styles.searchIcon} />
          <input
            type="text"
            className={styles.searchInput}
            placeholder="Поиск сотрудника..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
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
              />
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
};
