import { lazy, Suspense, type FC } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useChatContext } from '../../contexts/ChatContext';

const ChatSidePanel = lazy(() => import('./ChatSidePanel').then(m => ({ default: m.ChatSidePanel })));

export const ChatPanelMount: FC = () => {
  const { isAuthenticated, isApproved } = useAuth();
  const { isOpen } = useChatContext();
  if (!isAuthenticated || !isApproved || !isOpen) return null;

  return (
    <Suspense fallback={null}>
      <ChatSidePanel />
    </Suspense>
  );
};
