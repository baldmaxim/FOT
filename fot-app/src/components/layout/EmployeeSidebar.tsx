import type { FC, ReactNode } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useMyPresence } from '../../hooks/useMyPresence';
import { useMyEmployee } from '../../hooks/useMyEmployee';
import { formatFioShort } from '../../utils/formatFio';
import styles from './EmployeeSidebar.module.css';

interface INavItem {
  id: string;
  path: string;
  label: string;
  icon: ReactNode;
  badge?: number;
  badgeType?: 'pending' | 'new';
  requiredPage?: string;
}

interface INavGroup {
  label: string;
  items: INavItem[];
}

const navGroups: INavGroup[] = [
  {
    label: 'Личный кабинет',
    items: [
      {
        id: 'home',
        path: '/employee',
        label: 'Главная',
        requiredPage: '/employee',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="7" height="7" rx="2"/>
            <rect x="14" y="3" width="7" height="7" rx="2"/>
            <rect x="3" y="14" width="7" height="7" rx="2"/>
            <rect x="14" y="14" width="7" height="7" rx="2"/>
          </svg>
        ),
      },
      {
        id: 'tasks',
        path: '/employee/tasks',
        label: 'Мои задачи',
        requiredPage: '/employee/tasks',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="4" y="4" width="16" height="16" rx="2"/>
            <path d="M9 12l2 2 4-4"/>
          </svg>
        ),
      },
      {
        id: 'requests',
        path: '/employee/requests',
        label: 'Мои заявления',
        requiredPage: '/employee/requests',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="16" y1="13" x2="8" y2="13"/>
            <line x1="16" y1="17" x2="8" y2="17"/>
          </svg>
        ),
      },
      {
        id: 'hiring',
        path: '/employee/hiring',
        label: 'Заявки на поиск',
        requiredPage: '/staff-control/hiring',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="2" y="7" width="20" height="14" rx="2"/>
            <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>
          </svg>
        ),
      },
    ],
  },
  {
    label: 'МТС',
    items: [
      {
        id: 'sim',
        path: '/employee/sim',
        label: 'Моя SIM',
        requiredPage: '/employee/sim',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="6" y="2" width="12" height="20" rx="2"/>
            <line x1="12" y1="18" x2="12" y2="18.01"/>
          </svg>
        ),
      },
      {
        id: 'phonebook',
        path: '/employee/phonebook',
        label: 'Телефонная книга',
        requiredPage: '/employee/phonebook',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
            <path d="M12 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/>
            <path d="M9 15c.5-1.2 1.6-2 3-2s2.5.8 3 2"/>
          </svg>
        ),
      },
    ],
  },
  {
    label: 'Документы',
    items: [
      {
        id: 'documents',
        path: '/employee/documents',
        label: 'Мои документы',
        requiredPage: '/employee/documents',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
        ),
      },
    ],
  },
];

interface IEmployeeSidebarProps {
  isOpen?: boolean;
  onClose?: () => void;
  theme?: 'light' | 'dark';
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
}

export const EmployeeSidebar: FC<IEmployeeSidebarProps> = ({ isOpen, onClose, theme = 'dark', isCollapsed = false, onToggleCollapse }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { profile, logout, canViewPage } = useAuth();
  const { status: presenceStatus } = useMyPresence();
  const { data: myEmployee } = useMyEmployee(!profile?.imported_position);
  const positionLabel = profile?.imported_position
    || myEmployee?.position_name
    || 'Должность не указана';
  const displayName = formatFioShort(profile?.full_name) || 'Сотрудник';

  const logoSrc = theme === 'dark' ? '/fot-logo-dark.svg' : '/fot-logo-light.svg';

  const getActiveItem = () => {
    const path = location.pathname;

    // Точное совпадение
    for (const group of navGroups) {
      for (const item of group.items) {
        if (item.path === path) return item.id;
      }
    }

    // Совпадение по префиксу (для вложенных роутов вроде /employee/salary-raise/new)
    for (const group of navGroups) {
      for (const item of group.items) {
        if (item.path !== '/employee' && path.startsWith(item.path)) return item.id;
      }
    }

    if (path.startsWith('/employee')) {
      return 'home';
    }

    return 'home';
  };

  const activeItem = getActiveItem();

  const handleItemClick = (path: string) => {
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

  return (
    <aside className={`${styles.sidebar} ${isOpen ? styles.open : ''} ${isCollapsed ? styles.collapsed : ''}`}>
      <div className={styles.logo}>
        <a
          href="/employee"
          className={styles.logoLink}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.button === 1) return;
            e.preventDefault();
            navigate('/employee');
            onClose?.();
          }}
          aria-label="На главную (Личный кабинет)"
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

      <div className={styles.profileCard} title={isCollapsed ? `${displayName} — ${positionLabel}` : undefined}>
        <div className={styles.profileHeader}>
          <div className={styles.profileAvatarWrap}>
            <div className={styles.profileAvatar}>{getInitials(profile?.full_name || null)}</div>
            {presenceStatus !== 'unknown' && (
              <span className={`${styles.presenceIndicator} ${presenceStatus === 'online' ? styles.presenceOn : styles.presenceOff}`} />
            )}
          </div>
          <div className={styles.profileInfo}>
            <h3>{displayName}</h3>
            <p>{positionLabel}</p>
          </div>
        </div>
      </div>

      <nav className={styles.nav}>
        {canViewPage('/dashboard') && (
          <div className={styles.navGroup}>
            <div className={styles.navLabel}>Управление</div>
            <div
              className={`${styles.navItem} ${location.pathname === '/dashboard' ? styles.active : ''}`}
              title="Панель управления"
              onClick={() => { navigate('/dashboard'); onClose?.(); }}
            >
              <div className={styles.navIcon}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="3" width="18" height="18" rx="2"/>
                  <path d="M3 9h18M9 21V9"/>
                </svg>
              </div>
              <span className={styles.navText}>Панель управления</span>
            </div>
          </div>
        )}
        {navGroups.map(group => (
          <div key={group.label} className={styles.navGroup}>
            <div className={styles.navLabel}>{group.label}</div>
            {group.items.filter(item => canViewPage(item.requiredPage || item.path)).map(item => (
              <div
                key={item.id}
                className={`${styles.navItem} ${activeItem === item.id ? styles.active : ''}`}
                title={item.label}
                onClick={() => handleItemClick(item.path)}
              >
                <div className={styles.navIcon}>{item.icon}</div>
                <span className={styles.navText}>{item.label}</span>
                {item.badge !== undefined && item.badge > 0 && (
                  <span className={`${styles.navBadge} ${styles[item.badgeType || 'new']}`}>
                    {item.badge}
                  </span>
                )}
              </div>
            ))}
          </div>
        ))}
      </nav>

      <div className={styles.sidebarFooter}>
        <button className={styles.logoutBtn} onClick={handleLogout} title="Выйти из системы" aria-label="Выйти из системы">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
            <polyline points="16 17 21 12 16 7"/>
            <line x1="21" y1="12" x2="9" y2="12"/>
          </svg>
          <span className={styles.logoutText}>Выйти из системы</span>
        </button>
      </div>
    </aside>
  );
};
