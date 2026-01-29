import type { FC, ReactNode } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
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
        badge: 2,
        badgeType: 'pending',
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
    ],
  },
  {
    label: 'Финансы',
    items: [
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
        badge: 1,
        badgeType: 'new',
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
  {
    label: 'Настройки',
    items: [
      {
        id: 'profile',
        path: '/profile',
        label: 'Профиль',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
            <circle cx="12" cy="7" r="4"/>
          </svg>
        ),
      },
      {
        id: 'settings',
        path: '/employee/settings',
        label: 'Настройки',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
        ),
      },
    ],
  },
];

export const EmployeeSidebar: FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { profile, logout } = useAuth();

  const logoSrc = '/fot-logo-dark.svg';

  const getActiveItem = () => {
    const path = location.pathname;

    for (const group of navGroups) {
      for (const item of group.items) {
        if (item.path === path) return item.id;
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
    <aside className={styles.sidebar}>
      <div className={styles.logo}>
        <img src={logoSrc} alt="FOT" className={styles.logoImage} />
      </div>

      <div className={styles.profileCard}>
        <div className={styles.profileHeader}>
          <div className={styles.profileAvatar}>{getInitials(profile?.full_name || null)}</div>
          <div className={styles.profileInfo}>
            <h3>{profile?.full_name || 'Сотрудник'}</h3>
            <p>Сотрудник</p>
          </div>
        </div>
        <div className={styles.profileStats}>
          <div className={styles.profileStat}>
            <div className={styles.profileStatValue}>18</div>
            <div className={styles.profileStatLabel}>Дней отпуска</div>
          </div>
          <div className={styles.profileStat}>
            <div className={styles.profileStatValue}>3.2</div>
            <div className={styles.profileStatLabel}>Года в компании</div>
          </div>
        </div>
      </div>

      <nav className={styles.nav}>
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
