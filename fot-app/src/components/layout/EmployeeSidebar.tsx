import type { FC, ReactNode } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useMyPresence } from '../../hooks/useMyPresence';
import styles from './EmployeeSidebar.module.css';

interface INavItem {
  id: string;
  path: string;
  label: string;
  icon: ReactNode;
  badge?: number;
  badgeType?: 'pending' | 'new';
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
        id: 'requests',
        path: '/employee/requests',
        label: 'Мои заявления',
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
        id: 'calendar',
        path: '/employee/calendar',
        label: 'Календарь',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="4" width="18" height="18" rx="2"/>
            <line x1="16" y1="2" x2="16" y2="6"/>
            <line x1="8" y1="2" x2="8" y2="6"/>
            <line x1="3" y1="10" x2="21" y2="10"/>
          </svg>
        ),
      },
      {
        id: 'history',
        path: '/employee/history',
        label: 'Моя история',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/>
            <polyline points="16 7 22 7 22 13"/>
          </svg>
        ),
      },
    ],
  },
  {
    label: 'Финансы',
    items: [
      {
        id: 'salary-raise',
        path: '/employee/salary-raise',
        label: 'Повышение оклада',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/>
            <polyline points="17 6 23 6 23 12"/>
          </svg>
        ),
      },
      {
        id: 'payslips',
        path: '/employee/payslips',
        label: 'Расчётные листки',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="2" y="6" width="20" height="12" rx="2"/>
            <circle cx="12" cy="12" r="2"/>
            <path d="M6 12h.01M18 12h.01"/>
          </svg>
        ),
      },
      {
        id: 'payments',
        path: '/employee/payments',
        label: 'История выплат',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
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
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
        ),
      },
      {
        id: 'certificates',
        path: '/employee/certificates',
        label: 'Справки и выписки',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10"/>
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
            <line x1="12" y1="17" x2="12.01" y2="17"/>
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
}

export const EmployeeSidebar: FC<IEmployeeSidebarProps> = ({ isOpen, onClose, theme = 'dark' }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { profile, logout, canAccess } = useAuth();
  const { status: presenceStatus } = useMyPresence();

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
    <aside className={`${styles.sidebar} ${isOpen ? styles.open : ''}`}>
      <div className={styles.logo}>
        <img src={logoSrc} alt="FOT" className={styles.logoImage} />
      </div>

      <div className={styles.profileCard}>
        <div className={styles.profileHeader}>
          <div className={styles.profileAvatarWrap}>
            <div className={styles.profileAvatar}>{getInitials(profile?.full_name || null)}</div>
            {presenceStatus !== 'unknown' && (
              <span className={`${styles.presenceIndicator} ${presenceStatus === 'online' ? styles.presenceOn : styles.presenceOff}`} />
            )}
          </div>
          <div className={styles.profileInfo}>
            <h3>{profile?.full_name || 'Сотрудник'}</h3>
            {profile?.imported_position && <p>{profile.imported_position}</p>}
          </div>
        </div>
      </div>

      <nav className={styles.nav}>
        {canAccess('header') && (
          <div className={styles.navGroup}>
            <div className={styles.navLabel}>Управление</div>
            <div
              className={`${styles.navItem} ${location.pathname === '/dashboard' ? styles.active : ''}`}
              onClick={() => { navigate('/dashboard'); onClose?.(); }}
            >
              <div className={styles.navIcon}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="3" width="18" height="18" rx="2"/>
                  <path d="M3 9h18M9 21V9"/>
                </svg>
              </div>
              Панель управления
            </div>
          </div>
        )}
        {navGroups.map(group => (
          <div key={group.label} className={styles.navGroup}>
            <div className={styles.navLabel}>{group.label}</div>
            {group.items.map(item => (
              <div
                key={item.id}
                className={`${styles.navItem} ${activeItem === item.id ? styles.active : ''}`}
                onClick={() => handleItemClick(item.path)}
              >
                <div className={styles.navIcon}>{item.icon}</div>
                {item.label}
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
        <button className={styles.logoutBtn} onClick={handleLogout}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
            <polyline points="16 17 21 12 16 7"/>
            <line x1="21" y1="12" x2="9" y2="12"/>
          </svg>
          Выйти из системы
        </button>
      </div>
    </aside>
  );
};
