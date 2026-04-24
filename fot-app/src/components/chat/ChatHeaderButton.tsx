import type { FC } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useChatContext } from '../../contexts/ChatContext';
import dropdownStyles from '../ui/NotificationDropdown.module.css';

interface IChatHeaderButtonProps {
  buttonClassName?: string;
}

export const ChatHeaderButton: FC<IChatHeaderButtonProps> = ({ buttonClassName }) => {
  const { isAuthenticated, isApproved } = useAuth();
  const { toggleChat, unreadTotal } = useChatContext();

  if (!isAuthenticated || !isApproved) return null;

  return (
    <div className={dropdownStyles.wrapper}>
      <button
        type="button"
        className={buttonClassName}
        onClick={toggleChat}
        title="Открыть чат"
        aria-label="Открыть чат"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
        {unreadTotal > 0 && (
          <span className={dropdownStyles.badge}>
            {unreadTotal > 99 ? '99+' : unreadTotal}
          </span>
        )}
      </button>
    </div>
  );
};
