import type { FC } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import type { EmployeePositionType } from '../../types';
import styles from './Sidebar.module.css';
import {
  GridIcon,
  UsersIcon,
  CalendarIcon,
  SettingsIcon,
  BuildingIcon,
  ClipboardCheckIcon,
  FileTextIcon,
  DatabaseIcon,
  UserIcon,
  BarChartIcon,
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
      { id: 'employees', path: '/tender', label: 'Сотрудники', icon: UsersIcon, requiredPosition: 'admin' },
      { id: 'timesheet', path: '/timesheet', label: 'Табель', icon: CalendarIcon },
      { id: 'admin-structure', path: '/admin/structure', label: 'Управление', icon: BuildingIcon },
      { id: 'my-cabinet', path: '/employee', label: 'Личный кабинет', icon: UserIcon, requiredPosition: 'header' },
    ]
  },
  {
    label: 'Контроль',
    items: [
      { id: 'skud-raw', path: '/skud-raw', label: 'Просмотр СКУД', icon: FileTextIcon, requiredPosition: 'admin' },
      { id: 'skud-db', path: '/skud-db', label: 'СКУД (база)', icon: DatabaseIcon, requiredPosition: 'admin' },
      { id: 'discipline', path: '/discipline', label: 'Аналитика', icon: BarChartIcon, requiredPosition: 'admin' },
    ]
  },
  {
    label: 'Система',
    items: [
      { id: 'admin-orgs', path: '/admin/organizations', label: 'Организации', icon: BuildingIcon, requiredPosition: 'super_admin' },
      { id: 'sigur-settings', path: '/skud-settings', label: 'Настройки СКУД', icon: SettingsIcon, requiredPosition: 'super_admin' },
      { id: 'admin-users', path: '/admin/users', label: 'Пользователи', icon: SettingsIcon, requiredPosition: 'super_admin' },
      { id: 'admin-audit', path: '/admin/audit', label: 'Аудит данных', icon: ClipboardCheckIcon, requiredPosition: 'super_admin' },
    ]
  }
];

interface ISidebarProps {
  theme?: 'light' | 'dark';
  isOpen?: boolean;
  onClose?: () => void;
}

export const Sidebar: FC<ISidebarProps> = ({ theme = 'dark', isOpen, onClose }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { profile, logout, canAccess } = useAuth();

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

  const handleItemClick = (e: React.MouseEvent, path: string) => {
    // Позволяем браузеру обработать Ctrl+Click / средняя кнопка (новая вкладка)
    if (e.metaKey || e.ctrlKey || e.button === 1) return;
    e.preventDefault();
    navigate(path);
    onClose?.();
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
    if (importedPosition) return importedPosition;
    switch (positionType) {
      case 'super_admin': return 'Супер-админ';
      case 'admin': return 'Администратор';
      case 'header': return 'Руководитель';
      case 'worker': return 'Сотрудник';
      default: return 'Пользователь';
    }
  };

  return (
    <aside className={`${styles.sidebar} ${isOpen ? styles.open : ''}`}>
      <div className={styles.logo}>
        <img src={logoSrc} alt="FOT" className={styles.logoImage} />
      </div>

      <nav className={styles.nav}>
        {navGroups.map(group => {
          // Filter items based on position
          const visibleItems = group.items.filter(item => {
            if (!item.requiredPosition) return true;
            return canAccess(item.requiredPosition);
          });

          if (visibleItems.length === 0) return null;

          return (
            <div key={group.label} className={styles.navGroup}>
              <div className={styles.navLabel}>{group.label}</div>
              {visibleItems.map(item => {
                const Icon = item.icon;
                return (
                  <a
                    key={item.id}
                    href={item.path}
                    className={`${styles.navItem} ${activeItem === item.id ? styles.active : ''}`}
                    onClick={(e) => handleItemClick(e, item.path)}
                  >
                    <Icon className={styles.navIcon} />
                    {item.label}
                    {item.badge !== undefined && item.badge > 0 && (
                      <span className={styles.navBadge}>{item.badge}</span>
                    )}
                  </a>
                );
              })}
            </div>
          );
        })}
      </nav>

      <div className={styles.footer}>
        <div className={styles.userCard}>
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
