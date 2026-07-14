import type { FC } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useMyEmployee } from '../../hooks/useMyEmployee';
import { usePendingLeaveRequestsCount } from '../../hooks/usePendingLeaveRequestsCount';
import { usePendingContractorSubmissionsCount } from '../../hooks/usePendingContractorSubmissionsCount';
import { formatFioShort } from '../../utils/formatFio';
import { getLandingPath } from '../../utils/landingPath';
import { isNavItemVisible } from '../../utils/adminEntry';
import { navGroups } from './navConfig';
import styles from './Sidebar.module.css';

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
  const { profile, logout, canViewPage, hideSidebar, employeeVariant } = useAuth();
  const { data: myEmployee } = useMyEmployee(!profile?.imported_position);
  const leaveRequestsBadge = usePendingLeaveRequestsCount();
  const contractorBadge = usePendingContractorSubmissionsCount();

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

  const navContext = {
    canViewPage,
    employeeVariant,
    isCompanyAdmin,
    isWeekendResponsible: profile?.is_weekend_responsible === true,
  };

  // «Домой» — первая доступная страница роли (не хардкод /dashboard: узкие роли
  // без «Обзора», напр. ОТиТБ, иначе попадают в /unauthorized).
  const homePath = getLandingPath(canViewPage, employeeVariant, navContext);

  return (
    <aside className={`${styles.sidebar} ${isOpen ? styles.open : ''} ${isCollapsed ? styles.collapsed : ''}`}>
      <div className={styles.logo}>
        <a
          href={homePath}
          className={styles.logoLink}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.button === 1) return;
            e.preventDefault();
            navigate(homePath);
            onClose?.();
          }}
          aria-label="На главную"
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
          const visibleItems = group.items
            .map(item => item.id === 'leave-requests' ? { ...item, badge: leaveRequestsBadge } : item)
            .map(item => item.id === 'contractor-approvals' ? { ...item, badge: contractorBadge } : item)
            .filter(item => isNavItemVisible(item, navContext));

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
