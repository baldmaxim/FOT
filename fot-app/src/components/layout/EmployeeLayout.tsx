import { lazy, Suspense, useState } from 'react';
import type { FC, ReactNode } from 'react';
import { EmployeeSidebar } from './EmployeeSidebar';
import styles from './EmployeeLayout.module.css';
import { useMobileMenu } from '../../hooks/useMobileMenu';
import { useSidebarCollapse } from '../../hooks/useSidebarCollapse';
import { useSwipe } from '../../hooks/useSwipe';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import { useTheme } from '../../hooks/useTheme';
import { useMyPresence } from '../../hooks/useMyPresence';
import dropdownStyles from '../ui/NotificationDropdown.module.css';
import { useUnreadNotificationsCount } from '../../hooks/useUnreadNotificationsCount';
import { ChatHeaderButton } from '../chat/ChatHeaderButton';

interface IEmployeeLayoutProps {
  children: ReactNode;
  title: string;
}

const NotificationBellContent = lazy(() => import('../ui/NotificationBellContent').then(m => ({ default: m.NotificationBellContent })));

export const EmployeeLayout: FC<IEmployeeLayoutProps> = ({ children, title }) => {
  const { isOpen, open, close } = useMobileMenu();
  const { isCollapsed, toggle: toggleCollapse } = useSidebarCollapse();
  const { theme, toggleTheme } = useTheme();
  const { status: presenceStatus } = useMyPresence();
  const swipeHandlers = useSwipe({ isOpen, onOpen: open, onClose: close });
  const overlayHandlers = useOverlayDismiss(close);
  const [bellOpen, setBellOpen] = useState(false);
  const [notificationsActivated, setNotificationsActivated] = useState(false);
  const { unreadCount, setUnreadCount } = useUnreadNotificationsCount();

  const activateNotifications = () => {
    setNotificationsActivated(true);
  };

  const toggleNotifications = () => {
    activateNotifications();
    setBellOpen(prev => !prev);
  };

  return (
    <div className={`${styles.app} ${isCollapsed ? styles.appCollapsed : ''}`} {...swipeHandlers}>
      {isOpen && <div className={styles.overlay} {...overlayHandlers} />}
      <EmployeeSidebar
        isOpen={isOpen}
        onClose={close}
        theme={theme}
        isCollapsed={isCollapsed}
        onToggleCollapse={toggleCollapse}
      />
      <main className={styles.main}>
        <header className={styles.header}>
          <div className={styles.headerLeft}>
            <button className={styles.menuBtn} onClick={open}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="3" y1="12" x2="21" y2="12"/>
                <line x1="3" y1="6" x2="21" y2="6"/>
                <line x1="3" y1="18" x2="21" y2="18"/>
              </svg>
            </button>
            <h1 className={styles.pageTitle}>{title}</h1>
            {presenceStatus !== 'unknown' && (
              <span className={`${styles.presenceBadge} ${presenceStatus === 'online' ? styles.presenceOnline : styles.presenceOffline}`}>
                <span className={styles.presenceDot} />
                {presenceStatus === 'online' ? 'На месте' : 'Не на месте'}
              </span>
            )}
          </div>
          <div className={styles.headerRight}>
            <button className={styles.headerBtn} onClick={toggleTheme} title="Переключить тему">
              {theme === 'dark' ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="5"/>
                  <line x1="12" y1="1" x2="12" y2="3"/>
                  <line x1="12" y1="21" x2="12" y2="23"/>
                  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
                  <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
                  <line x1="1" y1="12" x2="3" y2="12"/>
                  <line x1="21" y1="12" x2="23" y2="12"/>
                  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
                  <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
                </svg>
              )}
            </button>
            <ChatHeaderButton buttonClassName={styles.headerBtn} />
            <div className={dropdownStyles.wrapper}>
              <button
                className={styles.headerBtn}
                onClick={toggleNotifications}
                onMouseEnter={activateNotifications}
                onFocus={activateNotifications}
                title="Уведомления"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
                  <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                </svg>
                {unreadCount > 0 && (
                  <span className={dropdownStyles.badge}>
                    {unreadCount > 99 ? '99+' : unreadCount}
                  </span>
                )}
              </button>
              {notificationsActivated && (
                <Suspense fallback={null}>
                  <NotificationBellContent
                    open={bellOpen}
                    onClose={() => setBellOpen(false)}
                    onUnreadCountChange={setUnreadCount}
                  />
                </Suspense>
              )}
            </div>
          </div>
        </header>
        {children}
      </main>
    </div>
  );
};
