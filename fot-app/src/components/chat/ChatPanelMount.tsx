import { lazy, Suspense, type FC } from 'react';
import { useAuth } from '../../contexts/AuthContext';

const ChatSidePanel = lazy(() => import('./ChatSidePanel').then(m => ({ default: m.ChatSidePanel })));

export const ChatPanelMount: FC = () => {
  const { isAuthenticated, isApproved } = useAuth();
  if (!isAuthenticated || !isApproved) return null;

  return (
    <Suspense fallback={null}>
      <ChatSidePanel />
    </Suspense>
  );
};
