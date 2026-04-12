import { useEffect, type FC } from 'react';
import { useNotifications } from '../../hooks/useNotifications';
import { NotificationDropdown } from './NotificationDropdown';

interface INotificationBellContentProps {
  open: boolean;
  onClose: () => void;
  onUnreadCountChange?: (count: number) => void;
}

export const NotificationBellContent: FC<INotificationBellContentProps> = ({
  open,
  onClose,
  onUnreadCountChange,
}) => {
  const {
    notifications,
    unreadCount,
    loading,
    loadNotifications,
    markRead,
    markAllRead,
  } = useNotifications(open);

  useEffect(() => {
    onUnreadCountChange?.(unreadCount);
  }, [onUnreadCountChange, unreadCount]);

  if (!open) {
    return null;
  }

  return (
    <NotificationDropdown
      notifications={notifications}
      loading={loading}
      onLoad={loadNotifications}
      onMarkRead={markRead}
      onMarkAllRead={markAllRead}
      onClose={onClose}
    />
  );
};
