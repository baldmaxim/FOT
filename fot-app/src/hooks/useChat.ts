import { useState, useEffect, useCallback, useRef } from 'react';
import type { wsService } from '../services/websocket';
import {
  chatService,
  type IChatConversation,
  type IChatContactRequest,
  type IChatMessage,
} from '../services/chatService';

export const useChat = (ws: typeof wsService | null) => {
  const [conversations, setConversations] = useState<IChatConversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<IChatMessage[]>([]);
  const [incomingRequests, setIncomingRequests] = useState<IChatContactRequest[]>([]);
  const [outgoingRequests, setOutgoingRequests] = useState<IChatContactRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [unreadTotal, setUnreadTotal] = useState(0);
  const activeConvRef = useRef<string | null>(null);

  // Sync ref with state
  useEffect(() => {
    activeConvRef.current = activeConversationId;
  }, [activeConversationId]);

  // Load conversations
  const loadConversations = useCallback(async () => {
    const data = await chatService.getConversations();
    setConversations(data);
    setUnreadTotal(data.reduce((sum, conversation) => sum + conversation.unread_count, 0));
  }, []);

  const loadRequests = useCallback(async () => {
    const [inbox, outbox] = await Promise.all([
      chatService.getRequests('inbox'),
      chatService.getRequests('outbox'),
    ]);

    setIncomingRequests(inbox);
    setOutgoingRequests(outbox);
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
      await new Promise<void>((resolve, reject) => {
        ws.send('send_message', {
          conversationId: activeConvRef.current,
          content: content.trim(),
        }, (response: unknown) => {
          const payload = response as { success?: boolean; error?: string };
          if (payload?.success) {
            resolve();
            return;
          }
          reject(new Error(payload?.error || 'Не удалось отправить сообщение'));
        });
      });
    } else {
      const message = await chatService.sendMessage(activeConvRef.current, content);
      setMessages(prev => [...prev, message]);
      await loadConversations();
    }
  }, [ws, loadConversations]);

  // Start new conversation
  const startConversation = useCallback(async (participantId: string) => {
    const conversationId = await chatService.createConversation(participantId);
    await loadConversations();
    await selectConversation(conversationId);
    return conversationId;
  }, [loadConversations, selectConversation]);

  const createRequest = useCallback(async (targetUserId: string, message?: string) => {
    const request = await chatService.createRequest(targetUserId, message);
    await loadRequests();
    return request;
  }, [loadRequests]);

  const approveRequest = useCallback(async (requestId: string) => {
    const result = await chatService.approveRequest(requestId);
    await Promise.all([loadRequests(), loadConversations()]);
    return result;
  }, [loadConversations, loadRequests]);

  const rejectRequest = useCallback(async (requestId: string) => {
    const request = await chatService.rejectRequest(requestId);
    await loadRequests();
    return request;
  }, [loadRequests]);

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
      void loadConversations().catch(() => undefined);
    });

    const unsubNotification = ws.on('message_notification', (payload: unknown) => {
      const data = payload as { conversationId: string; message: IChatMessage };
      if (data.conversationId !== activeConvRef.current) {
        setUnreadTotal(prev => prev + 1);
      }
      void loadConversations().catch(() => undefined);
    });

    return () => {
      unsubMessage();
      unsubNotification();
    };
  }, [ws, loadConversations]);

  const resetActiveChat = useCallback(() => {
    setActiveConversationId(null);
    setMessages([]);
  }, []);

  return {
    conversations,
    activeConversationId,
    messages,
    incomingRequests,
    outgoingRequests,
    loading,
    unreadTotal,
    selectConversation,
    sendMessage,
    startConversation,
    createRequest,
    approveRequest,
    rejectRequest,
    loadConversations,
    loadRequests,
    resetActiveChat,
  };
};
