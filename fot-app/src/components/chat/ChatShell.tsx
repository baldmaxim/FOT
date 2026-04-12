import type { FC } from 'react';
import { ChatButton } from './ChatButton';
import { ChatSidePanel } from './ChatSidePanel';

export const ChatShell: FC = () => {
  return (
    <>
      <ChatButton />
      <ChatSidePanel />
    </>
  );
};
