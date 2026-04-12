import { lazy, Suspense, useState } from 'react';
import type { FC } from 'react';
import styles from './Header.module.css';
import { IconButton } from '../ui/Button';
import { Tabs } from '../ui/Tabs';
import { MoonIcon, SunIcon, BellIcon } from '../ui/Icons';
import dropdownStyles from '../ui/NotificationDropdown.module.css';
import { useUnreadNotificationsCount } from '../../hooks/useUnreadNotificationsCount';

interface IHeaderProps {
  title: string;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onMenuOpen?: () => void;
  showPeriodTabs?: boolean;
}

const periodTabs = ['Сегодня', 'Неделя', 'Месяц'];
const NotificationBellContent = lazy(() => import('../ui/NotificationBellContent').then(m => ({ default: m.NotificationBellContent })));

export const Header: FC<IHeaderProps> = ({ title, theme, onToggleTheme, onMenuOpen, showPeriodTabs = false }) => {
  const [activeTab, setActiveTab] = useState(0);
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
    <header className={styles.header}>
      <div className={styles.left}>
        {onMenuOpen && (
          <button className={styles.menuBtn} onClick={onMenuOpen}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="3" y1="12" x2="21" y2="12"/>
              <line x1="3" y1="6" x2="21" y2="6"/>
              <line x1="3" y1="18" x2="21" y2="18"/>
            </svg>
          </button>
        )}
        <h1 className={styles.title}>{title}</h1>
        {showPeriodTabs && <Tabs tabs={periodTabs} activeTab={activeTab} onTabChange={setActiveTab} />}
      </div>

      <div className={styles.right}>
        <IconButton onClick={onToggleTheme} title="Переключить тему">
          {theme === 'dark' ? <MoonIcon /> : <SunIcon />}
        </IconButton>

        <div className={dropdownStyles.wrapper}>
          <IconButton
            onClick={toggleNotifications}
            onMouseEnter={activateNotifications}
            onFocus={activateNotifications}
            title="Уведомления"
          >
            <BellIcon />
            {unreadCount > 0 && (
              <span className={dropdownStyles.badge}>
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}
          </IconButton>
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
  );
};
