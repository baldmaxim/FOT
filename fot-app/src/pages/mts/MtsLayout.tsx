import { type FC } from 'react';
import { NavLink, Navigate, Outlet, useLocation } from 'react-router-dom';
import {
  useMtsConnectionSettings,
  useMtsSummary,
  useMtsSubscribers,
  useMtsEmployeesLinked,
  useMtsGeofences,
  useMtsTasks,
  useMtsSkudObjectsLite,
} from '../../hooks/useMtsData';
import styles from './MtsLayout.module.css';

interface INavItem {
  to: string;
  label: string;
  badge?: number;
  requiresConfigured: boolean;
}

export const MtsLayout: FC = () => {
  const location = useLocation();
  const connQuery = useMtsConnectionSettings();
  const configured = Boolean(connQuery.data?.hasToken);

  const summaryQuery = useMtsSummary(configured);
  const subsQuery = useMtsSubscribers(configured);
  const linkedQuery = useMtsEmployeesLinked({ pageSize: 1 }, configured);
  const geofencesQuery = useMtsGeofences(configured);
  const tasksQuery = useMtsTasks(configured);
  const objectsQuery = useMtsSkudObjectsLite(configured);

  // Дефолт: /mts → /mts/subscribers. Если нет токена — /mts/connection.
  if (location.pathname === '/mts' || location.pathname === '/mts/') {
    return <Navigate to={configured ? '/mts/subscribers' : '/mts/connection'} replace />;
  }
  // Защита: без токена доступна только вкладка «Подключение».
  if (!configured && location.pathname !== '/mts/connection') {
    return <Navigate to="/mts/connection" replace />;
  }

  const navItems: INavItem[] = [
    { to: 'subscribers', label: 'Абоненты МТС', badge: subsQuery.data?.length, requiresConfigured: true },
    { to: 'linked', label: 'Сотрудники', badge: linkedQuery.data?.total, requiresConfigured: true },
    { to: 'geofences', label: 'Геозоны', badge: geofencesQuery.data?.length, requiresConfigured: true },
    { to: 'objects', label: 'Объекты FOT', badge: objectsQuery.data?.length, requiresConfigured: true },
    { to: 'tracks', label: 'Треки', requiresConfigured: true },
    { to: 'tasks', label: 'Задачи МТС', badge: tasksQuery.data?.length, requiresConfigured: true },
    { to: 'dictionaries', label: 'Справочники', requiresConfigured: true },
    { to: 'connection', label: 'Подключение', requiresConfigured: false },
  ];

  const summary = summaryQuery.data;

  return (
    <div className={styles.layout}>
      <div className={styles.summary}>
        <div className={styles.summaryCard}>
          <span className={styles.summaryLabel}>Абонентов</span>
          <span className={styles.summaryValue}>{summary?.subscribersTotal ?? '—'}</span>
        </div>
        <div className={styles.summaryCard}>
          <span className={styles.summaryLabel}>Привязано</span>
          <span className={`${styles.summaryValue} ${styles.summaryValueAccent}`}>
            {summary?.linkedTotal ?? '—'}
          </span>
        </div>
        <div className={styles.summaryCard}>
          <span className={styles.summaryLabel}>Онлайн сейчас</span>
          <span className={styles.summaryValue}>{summary?.onlineNow ?? '—'}</span>
        </div>
        <div className={styles.summaryCard}>
          <span className={styles.summaryLabel}>Нарушений 24ч</span>
          <span
            className={`${styles.summaryValue} ${(summary?.violationsLast24h ?? 0) > 0 ? styles.summaryValueDanger : ''}`}
          >
            {summary?.violationsLast24h ?? '—'}
          </span>
        </div>
        <div className={styles.summaryConnState}>
          <span className={configured ? styles.dotOk : styles.dotErr} />
          {configured ? 'Подключено к МТС' : 'Не подключено'}
        </div>
      </div>

      <div className={styles.body}>
        <aside className={styles.sidebar}>
          {navItems.map(item => {
            const disabled = item.requiresConfigured && !configured;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                aria-disabled={disabled}
                className={({ isActive }) =>
                  `${styles.navLink} ${isActive ? styles.navLinkActive : ''}`
                }
                onClick={e => disabled && e.preventDefault()}
              >
                <span>{item.label}</span>
                {item.badge != null && item.badge > 0 && (
                  <span className={styles.navBadge}>{item.badge}</span>
                )}
              </NavLink>
            );
          })}
        </aside>

        <main className={styles.content}>
          <Outlet />
        </main>
      </div>
    </div>
  );
};
