/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useCallback, useEffect, useRef, type FC, type ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { useToast } from './ToastContext';
import { wsService } from '../services/websocket';
import { useChat } from '../hooks/useChat';
import type { IChatConversation, IChatMessage } from '../services/chatService';

interface IChatContextType {
  isOpen: boolean;
  openChat: () => void;
  closeChat: () => void;
  toggleChat: () => void;
  conversations: IChatConversation[];
  activeConversationId: string | null;
  messages: IChatMessage[];
  loading: boolean;
  unreadTotal: number;
  selectConversation: (id: string) => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  startConversation: (participantId: string) => Promise<string | null>;
  loadConversations: () => Promise<void>;
}

const ChatContext = createContext<IChatContextType | null>(null);

export const ChatProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const { token, isAuthenticated, isApproved } = useAuth();
  const { info } = useToast();
  const [isOpen, setIsOpen] = useState(false);
  const wsRef = useRef(false);

  // Socket lifecycle
  useEffect(() => {
    if (isAuthenticated && isApproved && token) {
      wsService.connect(token);
      wsRef.current = true;
    } else if (wsRef.current) {
      wsService.disconnect();
      wsRef.current = false;
    }
    return () => {
      if (wsRef.current) {
        wsService.disconnect();
        wsRef.current = false;
      }
    };
  }, [token, isAuthenticated, isApproved]);

  const ws = isAuthenticated && isApproved && token ? wsService : null;

  const {
    conversations,
    activeConversationId,
    messages,
    loading,
    unreadTotal,
    selectConversation,
    sendMessage,
    startConversation,
    loadConversations,
  } = useChat(ws);

  // Toast notifications for new messages
  const isOpenRef = useRef(isOpen);
  const activeConvRef = useRef(activeConversationId);
  useEffect(() => { isOpenRef.current = isOpen; }, [isOpen]);
  useEffect(() => { activeConvRef.current = activeConversationId; }, [activeConversationId]);

  useEffect(() => {
    if (!ws) return;

    const unsub = ws.on('message_notification', (payload: unknown) => {
      const data = payload as { conversationId: string; message: IChatMessage };
      if (isOpenRef.current && activeConvRef.current === data.conversationId) return;

      const conv = conversations.find(c => c.id === data.conversationId);
      const sender = conv?.participants.find(p => p.user_id === data.message.sender_id);
      const senderName = sender?.full_name || 'Новое сообщение';
      const preview = data.message.content?.slice(0, 60) || '';

      info(preview, {
        title: senderName,
        onClick: () => {
          setIsOpen(true);
          selectConversation(data.conversationId);
        },
      });
    });

    return unsub;
  }, [ws, info, conversations, selectConversation]);

  const openChat = useCallback(() => setIsOpen(true), []);
  const closeChat = useCallback(() => setIsOpen(false), []);
  const toggleChat = useCallback(() => setIsOpen(prev => !prev), []);

  return (
    <ChatContext.Provider value={{
      isOpen,
      openChat,
      closeChat,
      toggleChat,
      conversations,
      activeConversationId,
      messages,
      loading,
      unreadTotal,
      selectConversation,
      sendMessage,
      startConversation,
      loadConversations,
    }}>
      {children}
    </ChatContext.Provider>
  );
};

export const useChatContext = (): IChatContextType => {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error('useChatContext must be used within a ChatProvider');
  }
  return context;
};
