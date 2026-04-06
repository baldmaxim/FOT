import { useState, useEffect, useCallback, useRef } from 'react';
import type { wsService } from '../services/websocket';
import { chatService, type IChatConversation, type IChatMessage } from '../services/chatService';

export const useChat = (ws: typeof wsService | null) => {
  const [conversations, setConversations] = useState<IChatConversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<IChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [unreadTotal, setUnreadTotal] = useState(0);
  const activeConvRef = useRef<string | null>(null);

  // Sync ref with state
  useEffect(() => {
    activeConvRef.current = activeConversationId;
  }, [activeConversationId]);

  // Load conversations
  const loadConversations = useCallback(async () => {
    try {
      const data = await chatService.getConversations();
      setConversations(data);
      setUnreadTotal(data.reduce((sum, c) => sum + c.unread_count, 0));
    } catch {
      // ignore
    }
  }, []);

  // Load messages for active conversation
  const loadMessages = useCallback(async (conversationId: string) => {
    setLoading(true);
    try {
      const data = await chatService.getMessages(conversationId);
      setMessages(data.reverse()); // API returns newest first, we want oldest first
      await chatService.markAsRead(conversationId);
      ws?.send('mark_read', conversationId);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [ws]);

  // Select conversation
  const selectConversation = useCallback(async (conversationId: string) => {
    // Leave previous
    if (activeConvRef.current) {
      ws?.send('leave_conversation', activeConvRef.current);
    }

    setActiveConversationId(conversationId);
    ws?.send('join_conversation', conversationId);
    await loadMessages(conversationId);
    await loadConversations(); // refresh unread counts
  }, [ws, loadMessages, loadConversations]);

  // Send message via socket (fallback to REST)
  const sendMessage = useCallback(async (content: string) => {
    if (!activeConvRef.current || !content.trim()) return;

    if (ws?.connected) {
      ws.send('send_message', {
        conversationId: activeConvRef.current,
        content: content.trim(),
      });
      // Message will arrive via 'new_message' event
    } else {
      // Fallback to REST
      try {
        const message = await chatService.sendMessage(activeConvRef.current, content);
        setMessages(prev => [...prev, message]);
        await loadConversations();
      } catch {
        // ignore
      }
    }
  }, [ws, loadConversations]);

  // Start new conversation
  const startConversation = useCallback(async (participantId: string) => {
    try {
      const conversationId = await chatService.createConversation(participantId);
      await loadConversations();
      await selectConversation(conversationId);
      return conversationId;
    } catch {
      return null;
    }
  }, [loadConversations, selectConversation]);

  // WebSocket events
  useEffect(() => {
    if (!ws) return;

    const unsubMessage = ws.on('new_message', (payload: unknown) => {
      const message = payload as IChatMessage;
      if (message.conversation_id === activeConvRef.current) {
        setMessages(prev => {
          // Avoid duplicates
          if (prev.some(m => m.id === message.id)) return prev;
          return [...prev, message];
        });
      }
      loadConversations();
    });

    const unsubNotification = ws.on('message_notification', (payload: unknown) => {
      const data = payload as { conversationId: string; message: IChatMessage };
      if (data.conversationId !== activeConvRef.current) {
        setUnreadTotal(prev => prev + 1);
      }
      loadConversations();
    });

    return () => {
      unsubMessage();
      unsubNotification();
    };
  }, [ws, loadConversations]);

  // Initial load
  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  // Load unread count periodically
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const count = await chatService.getUnreadCount();
        setUnreadTotal(count);
      } catch {
        // ignore
      }
    }, 60000);
    return () => clearInterval(interval);
  }, []);

  const resetActiveChat = useCallback(() => {
    setActiveConversationId(null);
    setMessages([]);
  }, []);

  return {
    conversations,
    activeConversationId,
    messages,
    loading,
    unreadTotal,
    selectConversation,
    sendMessage,
    startConversation,
    loadConversations,
    resetActiveChat,
  };
};
