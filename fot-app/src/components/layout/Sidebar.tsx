import type { FC } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import type { EmployeePositionType } from '../../types/auth';
import styles from './Sidebar.module.css';
import {
  GridIcon,
  UsersIcon,
  CalendarIcon,
  SettingsIcon,
  ClipboardCheckIcon,
  FileTextIcon,
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
      { id: 'leave-requests', path: '/leave-requests', label: 'Заявления', icon: ClipboardCheckIcon, requiredPage: '/leave-requests' },
    ]
  },
  {
    label: 'Сотрудники и табель',
    items: [
      { id: 'employees', path: '/employees', label: 'Сотрудники', icon: UsersIcon, requiredPage: '/employees' },
      { id: 'staff-control', path: '/staff-control', label: 'Управление кадрами', icon: UsersIcon, requiredPage: '/staff-control' },
      { id: 'timesheet', path: '/timesheet', label: 'Табель', icon: CalendarIcon, requiredPage: '/timesheet' },
      { id: 'timesheet-hr', path: '/timesheet-hr', label: 'Табели HR', icon: CalendarIcon, requiredPage: '/timesheet-hr' },
      { id: 'discipline', path: '/discipline', label: 'Аналитика', icon: BarChartIcon, requiredPage: '/discipline' },
      { id: 'salary-raise-review', path: '/salary-raise-review', label: 'Повышение оклада', icon: DollarIcon, requiredPage: '/salary-raise-review' },
    ]
  },
  {
    label: 'СКУД',
    items: [
      { id: 'skud-travel', path: '/skud-travel', label: 'Передвижения', icon: FileTextIcon, requiredPage: '/skud-travel' },
      { id: 'skud-raw', path: '/skud-raw', label: 'Просмотр СКУД', icon: FileTextIcon, requiredPage: '/skud-raw' },
      { id: 'skud-db', path: '/skud-db', label: 'СКУД (база)', icon: DatabaseIcon, requiredPage: '/skud-db' },
      { id: 'skud-monitor', path: '/skud-monitor', label: 'Монитор Sigur', icon: BarChartIcon, requiredPage: '/skud-monitor' },
      { id: 'sigur-settings', path: '/skud-settings', label: 'Настройки СКУД', icon: SettingsIcon, requiredPage: '/skud-settings' },
    ]
  },
  {
    label: 'Администрирование',
    items: [
      { id: 'admin-schedules', path: '/admin/schedules', label: 'Графики работы', icon: CalendarIcon, requiredPage: '/admin/schedules' },
      { id: 'admin-payslips', path: '/admin/payslips', label: 'Расчётные листки', icon: FileTextIcon, requiredPage: '/admin/payslips' },
      { id: 'admin-users', path: '/admin/users', label: 'Пользователи', icon: SettingsIcon, requiredPage: '/admin/users' },
      { id: 'admin-roles', path: '/admin/roles', label: 'Роли', icon: ShieldIcon, requiredPage: '/admin/roles' },
      { id: 'admin-settings', path: '/admin/settings', label: 'Настройки', icon: SettingsIcon, requiredPage: '/admin/settings' },
      { id: 'admin-audit', path: '/admin/audit', label: 'Аудит данных', icon: ClipboardCheckIcon, requiredPage: '/admin/audit' },
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
  const { profile, logout, canViewPage, getRoleLabel } = useAuth();

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
    if (!positionType) return 'Пользователь';
    return getRoleLabel(positionType);
  };

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
