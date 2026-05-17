/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, type FC, type ReactNode } from 'react';
import { useCardReader } from '../hooks/useCardReader';

type CardReaderAgent = ReturnType<typeof useCardReader>;

const CardReaderAgentContext = createContext<CardReaderAgent | undefined>(undefined);

/** Один WebSocket-агент на поддерево: шапка и панели берут общее состояние. */
export const CardReaderAgentProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const agent = useCardReader();
  return (
    <CardReaderAgentContext.Provider value={agent}>
      {children}
    </CardReaderAgentContext.Provider>
  );
};

/** Если провайдера выше нет — создаёт свой (для standalone CardReaderPanel). */
export const EnsureCardReaderAgent: FC<{ children: ReactNode }> = ({ children }) => {
  const existing = useContext(CardReaderAgentContext);
  if (existing) return <>{children}</>;
  return <CardReaderAgentProvider>{children}</CardReaderAgentProvider>;
};

export const useCardReaderAgent = (): CardReaderAgent => {
  const ctx = useContext(CardReaderAgentContext);
  if (!ctx) {
    throw new Error('useCardReaderAgent должен использоваться внутри CardReaderAgentProvider');
  }
  return ctx;
};
