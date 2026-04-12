import type { FC } from 'react';
import { ChatProvider } from '../../contexts/ChatContext';
import { ChatShell } from './ChatShell';

export const ChatRoot: FC<{ initialOpen?: boolean }> = ({ initialOpen = false }) => {
  return (
    <ChatProvider initialOpen={initialOpen}>
      <ChatShell />
    </ChatProvider>
  );
};
