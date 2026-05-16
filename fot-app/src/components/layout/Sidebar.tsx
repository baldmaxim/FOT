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
  FileTextIcon,
  KeyIcon,
  MapPinIcon,
} from '../ui/Icons';

interface INavItem {
  id: string;
  path: string;
  label: string;
  icon: FC<{ className?: string }>;
  badge?: number;
  requiredPage?: string | string[];
  /**
   * Если true — пункт скрыт для админа компании (is_admin со скоупом).
   * Системный админ (company_scope.roots === 'all') всегда видит пункт.
   */
  systemAdminOnly?: boolean;
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
      { id: 'skud-presence', path: '/skud-presence', label: 'Сотрудники на объектах', icon: MapPinIcon, requiredPage: '/skud-presence' },
    ]
  },
  {
    label: 'Работа',
    items: [
      { id: 'staff-control', path: '/staff-control', label: 'Управление кадрами', icon: UsersIcon, requiredPage: '/staff-control' },
      { id: 'timesheet', path: '/timesheet', label: 'Табель', icon: CalendarIcon, requiredPage: '/timesheet' },
      { id: 'approvals', path: '/approvals', label: 'Согласования', icon: CalendarIcon, requiredPage: '/timesheet-hr' },
      { id: 'timesheet-hr', path: '/timesheet-hr', label: 'Табели HR', icon: CalendarIcon, requiredPage: '/timesheet-hr' },
      { id: 'discipline', path: '/discipline', label: 'Аналитика', icon: BarChartIcon, requiredPage: '/discipline' },
    ]
  },
  {
    label: 'Администрирование',
    items: [
      { id: 'payroll-hub', path: '/admin/schedules', label: 'Графики работы', icon: DollarIcon, requiredPage: ['/admin/schedules', '/admin/schedules/templates'] },
      { id: 'patent-receipts', path: '/admin/patent-receipts', label: 'Чеки за патент', icon: FileTextIcon, requiredPage: '/admin/patent-receipts' },
      { id: 'timesheet-transfers', path: '/admin/timesheet-transfers', label: 'Переводы и исключения', icon: CalendarIcon, requiredPage: '/admin/timesheet-transfers' },
      { id: 'skud-hub', path: '/skud-settings', label: 'СКУД', icon: DatabaseIcon, requiredPage: '/skud-settings' },
      { id: 'sigur', path: '/sigur', label: 'SIGUR', icon: UsersIcon, requiredPage: '/skud-settings' },
      { id: 'card-reader', path: '/skud-card-reader', label: 'Считыватель пропусков', icon: KeyIcon, requiredPage: '/skud-card-reader' },
      { id: 'system-hub', path: '/admin/system', label: 'Система', icon: ShieldIcon, requiredPage: ['/admin/users', '/admin/roles', '/admin/audit', '/admin/action-history', '/admin/settings', '/admin/data-api'], systemAdminOnly: true },
    ]
  }
];

interface ISidebarProps {
  theme?: 'light' | 'dark';
  isOpen?: boolean;
  onClose?: () => void;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
}

export const Sidebar: FC<ISidebarProps> = ({ theme = 'dark', isOpen, onClose, isCollapsed = false, onToggleCollapse }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { profile, logout, canViewPage, hideSidebar } = useAuth();
  const { data: myEmployee } = useMyEmployee(!profile?.imported_position);

  // Defense in depth: если Layout по какой-то причине отрендерил Sidebar,
  // а флаг hide_sidebar активен (и пользователь не админ), всё равно не показываем меню.
  if (hideSidebar) return null;

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

  // Админ компании = is_admin со списком конкретных company_scope.roots.
  // Если roots === 'all' (или поле отсутствует — старая сессия) — это системный админ.
  const isCompanyAdmin = !!profile?.is_admin
    && Array.isArray(profile?.company_scope?.roots);

  return (
    <aside className={`${styles.sidebar} ${isOpen ? styles.open : ''} ${isCollapsed ? styles.collapsed : ''}`}>
      <div className={styles.logo}>
        <a
          href="/dashboard"
          className={styles.logoLink}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.button === 1) return;
            e.preventDefault();
            navigate('/dashboard');
            onClose?.();
          }}
          aria-label="На главную (Обзор)"
        >
          <img src={logoSrc} alt="FOT" className={styles.logoImage} />
          <img src="/fot-favicon-32.svg" alt="FOT" className={styles.logoMini} />
        </a>
        {onToggleCollapse && (
          <button
            type="button"
            className={styles.collapseBtn}
            onClick={(e) => { e.stopPropagation(); onToggleCollapse(); }}
            title={isCollapsed ? 'Развернуть меню' : 'Свернуть меню'}
            aria-label={isCollapsed ? 'Развернуть меню' : 'Свернуть меню'}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
        )}
      </div>

      <nav className={styles.nav}>
        {navGroups.map(group => {
          const visibleItems = group.items.filter(item => {
            if (item.systemAdminOnly && isCompanyAdmin) return false;
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
                    title={item.label}
                    className={`${styles.navItem} ${activeItem === item.id ? styles.active : ''}`}
                    onClick={(e) => handleItemClick(e, item.path)}
                  >
                    <Icon className={styles.navIcon} />
                    <span className={styles.navText}>{item.label}</span>
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
        <div className={styles.userCard} title={`${displayName} — ${positionLabel}`}>
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
          aria-label="Выйти"
        >
          <svg className={styles.logoutIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
          <span className={styles.logoutText}>Выйти</span>
        </button>
      </div>
    </aside>
  );
};
