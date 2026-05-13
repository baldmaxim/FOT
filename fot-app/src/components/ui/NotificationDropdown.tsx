import { useEffect, useRef } from 'react';
import type { FC } from 'react';
import type { INotification } from '../../services/notificationService';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import styles from './NotificationDropdown.module.css';

interface INotificationDropdownProps {
  notifications: INotification[];
  loading: boolean;
  onLoad: () => void;
  onMarkRead: (id: string) => void;
  onMarkAllRead: () => void;
  onClose: () => void;
  onNavigate?: (notification: INotification) => void;
}

const formatRelativeTime = (dateStr: string): string => {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'только что';
  if (mins < 60) return `${mins} мин назад`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'вчера';
  if (days < 7) return `${days} дн назад`;
  return new Date(dateStr).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
};

const TypeIcon: FC<{ type: string }> = ({ type }) => {
  if (type === 'leave_request') {
    return (
      <div className={`${styles.itemIcon} ${styles.iconLeave}`}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
        </svg>
      </div>
    );
  }
  if (type === 'salary_raise') {
    return (
      <div className={`${styles.itemIcon} ${styles.iconSalary}`}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="12" y1="1" x2="12" y2="23" />
          <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
        </svg>
      </div>
    );
  }
  if (type === 'chat_message') {
    return (
      <div className={`${styles.itemIcon} ${styles.iconChat}`}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </div>
    );
  }
  if (type.startsWith('timesheet_')) {
    return (
      <div className={`${styles.itemIcon} ${styles.iconLeave}`}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
          <path d="M8 14h8" />
          <path d="M8 18h5" />
        </svg>
      </div>
    );
  }
  return (
    <div className={styles.itemIcon}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
      </svg>
    </div>
  );
};

export const NotificationDropdown: FC<INotificationDropdownProps> = ({
  notifications,
  loading,
  onLoad,
  onMarkRead,
  onMarkAllRead,
  onClose,
  onNavigate,
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const overlayHandlers = useOverlayDismiss(onClose);

  useEffect(() => {
    onLoad();
  }, [onLoad]);

  const handleItemClick = (n: INotification) => {
    if (!n.is_read) onMarkRead(n.id);
    onNavigate?.(n);
    onClose();
  };

  return (
    <>
      <div className={styles.overlay} {...overlayHandlers} />
      <div className={styles.dropdown} ref={ref}>
        <div className={styles.header}>
          <span className={styles.headerTitle}>Уведомления</span>
          {notifications.some(n => !n.is_read) && (
            <button className={styles.readAllBtn} onClick={onMarkAllRead}>
              Прочитать все
            </button>
          )}
        </div>
        <div className={styles.list}>
          {loading && <div className={styles.loading}>Загрузка...</div>}
          {!loading && notifications.length === 0 && (
            <div className={styles.empty}>Нет уведомлений</div>
          )}
          {!loading && notifications.map(n => (
            <div
              key={n.id}
              className={`${styles.item} ${!n.is_read ? styles.itemUnread : ''}`}
              onClick={() => handleItemClick(n)}
            >
              <TypeIcon type={n.type} />
              <div className={styles.itemContent}>
                <div className={styles.itemTitle}>{n.title}</div>
                <div className={styles.itemBody}>{n.body}</div>
                <div className={styles.itemTime}>{formatRelativeTime(n.created_at)}</div>
              </div>
              {!n.is_read && <div className={styles.unreadDot} />}
            </div>
          ))}
        </div>
      </div>
    </>
  );
};
