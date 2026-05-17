import { useEffect, type FC } from 'react';
import { useNavigate } from 'react-router-dom';
import { useNotifications } from '../../hooks/useNotifications';
import { useChatContext } from '../../contexts/ChatContext';
import { NotificationDropdown } from './NotificationDropdown';
import type { INotification } from '../../services/notificationService';

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
  const navigate = useNavigate();
  const { openChat, selectConversation } = useChatContext();
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

  const handleNavigate = (notification: INotification) => {
    if (notification.type === 'chat_message') {
      const convId = typeof notification.metadata?.conversationId === 'string'
        ? notification.metadata.conversationId
        : null;
      if (convId) {
        openChat();
        void selectConversation(convId);
        return;
      }
    }
    const path = typeof notification.metadata?.path === 'string' ? notification.metadata.path : null;
    if (path) {
      navigate(path);
    }
  };

  return (
    <NotificationDropdown
      notifications={notifications}
      loading={loading}
      onLoad={loadNotifications}
      onMarkRead={markRead}
      onMarkAllRead={markAllRead}
      onClose={onClose}
      onNavigate={handleNavigate}
    />
  );
};
