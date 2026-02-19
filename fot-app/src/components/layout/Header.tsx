import { useState } from 'react';
import type { FC } from 'react';
import styles from './Header.module.css';
import { SearchInput } from '../ui/SearchInput';
import { IconButton } from '../ui/Button';
import { Tabs } from '../ui/Tabs';
import { MoonIcon, SunIcon, BellIcon } from '../ui/Icons';

interface IHeaderProps {
  title: string;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onMenuOpen?: () => void;
  showPeriodTabs?: boolean;
}

const periodTabs = ['Сегодня', 'Неделя', 'Месяц'];

export const Header: FC<IHeaderProps> = ({ title, theme, onToggleTheme, onMenuOpen, showPeriodTabs = false }) => {
  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState(0);

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
        <SearchInput
          value={search}
          onValueChange={setSearch}
          placeholder="Поиск сотрудника..."
        />

        <IconButton onClick={onToggleTheme} title="Переключить тему">
          {theme === 'dark' ? <MoonIcon /> : <SunIcon />}
        </IconButton>

        <IconButton hasNotification>
          <BellIcon />
        </IconButton>
      </div>
    </header>
  );
};
