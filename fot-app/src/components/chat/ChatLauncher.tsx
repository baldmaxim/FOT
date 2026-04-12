import type { FC } from 'react';
import styles from './ChatButton.module.css';

interface IChatLauncherProps {
  unreadCount: number;
  onOpen: () => void;
}

export const ChatLauncher: FC<IChatLauncherProps> = ({ unreadCount, onOpen }) => {
  return (
    <button className={styles.button} onClick={onOpen} title="Открыть чат">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="24" height="24">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>
      {unreadCount > 0 && (
        <span className={styles.badge}>{unreadCount > 99 ? '99+' : unreadCount}</span>
      )}
    </button>
  );
};
