import type { FC } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import type { EmployeePositionType } from '../../types';
import styles from './Sidebar.module.css';
import {
  GridIcon,
  UsersIcon,
  CalendarIcon,
  ShieldIcon,
  SettingsIcon,
  BuildingIcon,
  BarChartIcon,
  ClipboardCheckIcon,
} from '../ui/Icons';

interface INavItem {
  id: string;
  path: string;
  label: string;
  icon: FC<{ className?: string }>;
  badge?: number;
  requiredPosition?: EmployeePositionType;
}

interface INavGroup {
  label: string;
  items: INavItem[];
}

const navGroups: INavGroup[] = [
  {
    label: 'Основное',
    items: [
      { id: 'overview', path: '/', label: 'Обзор', icon: GridIcon },
      { id: 'employees', path: '/tender', label: 'Сотрудники', icon: UsersIcon },
      { id: 'timesheet', path: '/timesheet', label: 'Табель', icon: CalendarIcon },
    ]
  },
  {
    label: 'Контроль',
    items: [
      { id: 'access', path: '/skud', label: 'СКУД', icon: ShieldIcon },
      { id: 'access-analysis', path: '/skud-analysis', label: 'Анализ СКУД', icon: BarChartIcon },
    ]
  },
  {
    label: 'Система',
    items: [
      { id: 'admin-users', path: '/admin/users', label: 'Пользователи', icon: SettingsIcon, requiredPosition: 'super_admin' },
      { id: 'admin-structure', path: '/admin/structure', label: 'Структура', icon: BuildingIcon, requiredPosition: 'super_admin' },
      { id: 'admin-audit', path: '/admin/audit', label: 'Аудит данных', icon: ClipboardCheckIcon, requiredPosition: 'super_admin' },
    ]
  }
];

interface ISidebarProps {
  theme?: 'light' | 'dark';
}

export const Sidebar: FC<ISidebarProps> = ({ theme = 'dark' }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { profile, logout, hasPosition } = useAuth();

  const logoSrc = theme === 'dark' ? '/fot-logo-dark.svg' : '/fot-logo-light.svg';

  const getActiveItem = () => {
    const path = location.pathname;

    // Сначала ищем точное совпадение
    for (const group of navGroups) {
      for (const item of group.items) {
        if (item.path === path) return item.id;
      }
    }

    // Затем ищем по префиксу, выбирая самый длинный совпадающий путь
    let bestMatch: { id: string; length: number } | null = null;
    for (const group of navGroups) {
      for (const item of group.items) {
        if (item.path !== '/' && path.startsWith(item.path)) {
          if (!bestMatch || item.path.length > bestMatch.length) {
            bestMatch = { id: item.id, length: item.path.length };
          }
        }
      }
    }

    return bestMatch?.id || 'overview';
  };

  const activeItem = getActiveItem();

  const handleItemClick = (path: string) => {
    navigate(path);
  };

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const getInitials = (name: string | null) => {
    if (!name) return '??';
    const parts = name.split(' ');
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  };

  const getPositionLabel = (positionType: EmployeePositionType | null, importedPosition: string | null) => {
    // Для worker показываем реальную должность из импорта, если есть
    if (positionType === 'worker' && importedPosition) {
      return importedPosition;
    }
    switch (positionType) {
      case 'super_admin': return 'Супер-админ';
      case 'admin': return 'Администратор';
      case 'header': return 'Руководитель';
      case 'worker': return 'Сотрудник';
      default: return 'Пользователь';
    }
  };

  return (
    <aside className={styles.sidebar}>
      <div className={styles.logo}>
        <img src={logoSrc} alt="FOT" className={styles.logoImage} />
      </div>

      <nav className={styles.nav}>
        {navGroups.map(group => {
          // Filter items based on position
          const visibleItems = group.items.filter(item => {
            if (!item.requiredPosition) return true;
            return hasPosition(item.requiredPosition);
          });

          if (visibleItems.length === 0) return null;

          return (
            <div key={group.label} className={styles.navGroup}>
              <div className={styles.navLabel}>{group.label}</div>
              {visibleItems.map(item => {
                const Icon = item.icon;
                return (
                  <div
                    key={item.id}
                    className={`${styles.navItem} ${activeItem === item.id ? styles.active : ''}`}
                    onClick={() => handleItemClick(item.path)}
                  >
                    <Icon className={styles.navIcon} />
                    {item.label}
                    {item.badge !== undefined && item.badge > 0 && (
                      <span className={styles.navBadge}>{item.badge}</span>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </nav>

      <div className={styles.footer}>
        <div
          className={styles.userCard}
          onClick={() => navigate('/profile')}
          title="Личный кабинет"
        >
          <div className={styles.userAvatar}>{getInitials(profile?.full_name || null)}</div>
          <div className={styles.userInfo}>
            <div className={styles.userName}>{profile?.full_name || 'Пользователь'}</div>
            <div className={styles.userRole}>{getPositionLabel(profile?.position_type || null, profile?.imported_position || null)}</div>
          </div>
        </div>
        <button
          onClick={handleLogout}
          className={styles.logoutBtn}
          title="Выйти"
        >
          Выйти
        </button>
      </div>
    </aside>
  );
};
