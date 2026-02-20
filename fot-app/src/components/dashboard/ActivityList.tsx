import { type FC, useState, useEffect, useMemo } from 'react';
import { Card, CardHeader, CardContent } from '../ui/Card';
import { formatElapsed } from '../../utils/formatElapsed';
import type { IEmployeePresence } from '../../types';
import styles from './ActivityList.module.css';

type TabFilter = 'all' | 'online' | 'offline';

interface IActivityListProps {
  employees: IEmployeePresence[];
  loading: boolean;
}

const getInitials = (name: string): string => {
  const parts = name.split(' ');
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return name.slice(0, 2).toUpperCase();
};

const EmployeeRow: FC<{ employee: IEmployeePresence }> = ({ employee }) => {
  const [elapsed, setElapsed] = useState(() => formatElapsed(employee.since));

  useEffect(() => {
    setElapsed(formatElapsed(employee.since));
    const timer = setInterval(() => setElapsed(formatElapsed(employee.since)), 60_000);
    return () => clearInterval(timer);
  }, [employee.since]);

  const isOnline = employee.status === 'online';

  return (
    <div className={styles.item}>
      <div className={styles.avatar}>{getInitials(employee.full_name)}</div>
      <div className={styles.content}>
        <div className={styles.name}>{employee.full_name}</div>
        <div className={styles.meta}>
          {employee.position_name || employee.department_name || ''}
        </div>
      </div>
      <span className={`${styles.status} ${isOnline ? styles.in : styles.out}`}>
        {isOnline ? 'Онлайн' : employee.status === 'offline' ? 'Оффлайн' : '—'}
      </span>
      {elapsed && <span className={styles.time}>{elapsed}</span>}
    </div>
  );
};

export const ActivityList: FC<IActivityListProps> = ({ employees, loading }) => {
  const [tab, setTab] = useState<TabFilter>('all');

  const onlineCount = useMemo(() => employees.filter(e => e.status === 'online').length, [employees]);
  const offlineCount = useMemo(() => employees.filter(e => e.status === 'offline').length, [employees]);

  const filtered = useMemo(() => {
    if (tab === 'online') return employees.filter(e => e.status === 'online');
    if (tab === 'offline') return employees.filter(e => e.status === 'offline');
    return employees;
  }, [employees, tab]);

  if (loading) {
    return (
      <Card>
        <CardHeader title="Присутствие сотрудников" />
        <CardContent>
          <div className={styles.empty}>
            <span className={styles.emptyText}>Загрузка...</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader title="Присутствие сотрудников" />
      <CardContent>
        <div className={styles.tabs}>
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
            На работе <span className={styles.tabCount}>{onlineCount}</span>
          </button>
          <button
            className={`${styles.tab} ${tab === 'offline' ? styles.tabActive : ''}`}
            onClick={() => setTab('offline')}
          >
            Ушли <span className={styles.tabCount}>{offlineCount}</span>
          </button>
        </div>
        <div className={styles.list}>
          {filtered.length === 0 ? (
            <div className={styles.empty}>
              <span className={styles.emptyText}>
                {employees.length === 0 ? 'Нет данных' : 'Нет сотрудников'}
              </span>
              {employees.length === 0 && (
                <span className={styles.emptyHint}>Выберите отдел для просмотра</span>
              )}
            </div>
          ) : (
            filtered.map(emp => (
              <EmployeeRow key={emp.employee_id} employee={emp} />
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
};
