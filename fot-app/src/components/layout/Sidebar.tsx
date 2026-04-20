import type { FC } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useMyEmployee } from '../../hooks/useMyEmployee';
import { formatFioShort } from '../../utils/formatFio';
import styles from './Sidebar.module.css';
import {
  GridIcon,
  UsersIcon,
  CalendarIcon,
  ClipboardCheckIcon,
  DatabaseIcon,
  UserIcon,
  BarChartIcon,
  ShieldIcon,
  DollarIcon,
} from '../ui/Icons';

interface INavItem {
  id: string;
  path: string;
  label: string;
  icon: FC<{ className?: string }>;
  badge?: number;
  requiredPage?: string | string[];
}

interface INavGroup {
  label: string;
  items: INavItem[];
}

const navGroups: INavGroup[] = [
  {
    label: 'Моё',
    items: [
      { id: 'my-cabinet', path: '/employee', label: 'Личный кабинет', icon: UserIcon, requiredPage: '/employee' },
      { id: 'overview', path: '/', label: 'Обзор', icon: GridIcon, requiredPage: '/dashboard' },
      { id: 'leave-requests', path: '/leave-requests', label: 'Заявления', icon: ClipboardCheckIcon, requiredPage: ['/leave-requests', '/salary-raise-review'] },
    ]
  },
  {
    label: 'Работа',
    items: [
      { id: 'staff-control', path: '/staff-control', label: 'Управление кадрами', icon: UsersIcon, requiredPage: '/staff-control' },
      { id: 'timesheet', path: '/timesheet', label: 'Табель', icon: CalendarIcon, requiredPage: '/timesheet' },
      { id: 'timesheet-hr', path: '/timesheet-hr', label: 'Табели HR', icon: CalendarIcon, requiredPage: '/timesheet-hr' },
      { id: 'discipline', path: '/discipline', label: 'Аналитика', icon: BarChartIcon, requiredPage: '/discipline' },
    ]
  },
  {
    label: 'Администрирование',
    items: [
      { id: 'payroll-hub', path: '/admin/payroll', label: 'Графики работы', icon: DollarIcon, requiredPage: ['/admin/schedules'] },
      { id: 'skud-hub', path: '/skud', label: 'СКУД', icon: DatabaseIcon, requiredPage: '/skud-settings' },
      { id: 'system-hub', path: '/admin/system', label: 'Система', icon: ShieldIcon, requiredPage: ['/admin/users', '/admin/roles', '/admin/audit', '/admin/settings'] },
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
  const { profile, logout, canViewPage } = useAuth();
  const { data: myEmployee } = useMyEmployee(!profile?.imported_position);

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

  const positionLabel = profile?.imported_position
    || myEmployee?.position_name
    || 'Должность не указана';
  const displayName = formatFioShort(profile?.full_name) || 'Пользователь';

  return (
    <aside className={`${styles.sidebar} ${isOpen ? styles.open : ''}`}>
      <div className={styles.logo}>
        <img src={logoSrc} alt="FOT" className={styles.logoImage} />
      </div>

      <nav className={styles.nav}>
        {navGroups.map(group => {
          const visibleItems = group.items.filter(item => {
            const pages = item.requiredPage ?? item.path;
            const pageList = Array.isArray(pages) ? pages : [pages];
            return pageList.some(page => canViewPage(page));
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
            <div className={styles.userName}>{displayName}</div>
            <div className={styles.userRole}>{positionLabel}</div>
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
