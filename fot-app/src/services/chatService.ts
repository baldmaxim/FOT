import { apiClient } from '../api/client';
import type { ChatInboundMode, EmployeePositionType } from '../types';

interface ApiResponse<T> {
  data: T;
  message?: string;
}

export type ChatAvailability = 'direct' | 'request' | 'forbidden';
export type ChatRequestStatus = 'incoming_pending' | 'outgoing_pending' | null;

export interface IChatAttachment {
  key: string;
  name: string;
  size: number;
  mime: string;
  url?: string;
}

export interface IChatConversation {
  id: string;
  created_at: string;
  updated_at: string;
  participants: { user_id: string; full_name: string | null }[];
  last_message: { content: string; sender_id: string; created_at: string; has_attachment?: boolean } | null;
  unread_count: number;
  is_writable: boolean;
  write_lock_reason: string | null;
}

export interface IChatMessage {
  id: string;
  conversation_id: string;
  sender_id: string;
  content: string;
  is_read: boolean;
  created_at: string;
  attachment?: IChatAttachment | null;
}

export interface IChatUser {
  id: string;
  full_name: string | null;
  position_type: EmployeePositionType;
  department_id: string | null;
  availability: ChatAvailability;
  availability_reason: string;
  request_status: ChatRequestStatus;
}

export interface IChatContactRequest {
  id: string;
  requester_id: string;
  requester_name: string | null;
  target_user_id: string;
  target_name: string | null;
  message: string | null;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolved_by_name: string | null;
  direction: 'inbox' | 'outbox';
}

export interface IAdminChatUser {
  id: string;
  full_name: string | null;
  position_type: EmployeePositionType;
  department_id: string | null;
  chat_inbound_mode: ChatInboundMode;
}

export const chatService = {
  async getConversations(): Promise<IChatConversation[]> {
    const response = await apiClient.get<ApiResponse<IChatConversation[]>>('/chat/conversations');
    return response.data || [];
  },

  async createConversation(participantId: string): Promise<string> {
    const response = await apiClient.post<ApiResponse<{ id: string }>>('/chat/conversations', { participantId });
    return response.data.id;
  },

  async getMessages(conversationId: string, limit = 50, offset = 0): Promise<IChatMessage[]> {
    const response = await apiClient.get<ApiResponse<IChatMessage[]>>(
      `/chat/conversations/${conversationId}/messages?limit=${limit}&offset=${offset}`,
    );
    return response.data || [];
  },

  async sendMessage(conversationId: string, content: string): Promise<IChatMessage> {
    const response = await apiClient.post<ApiResponse<IChatMessage>>(
      `/chat/conversations/${conversationId}/messages`,
      { content },
    );
    return response.data;
  },

  async sendMessageWithFile(conversationId: string, content: string, file: File): Promise<IChatMessage> {
    const form = new FormData();
    form.append('content', content);
    form.append('file', file);
    const response = await apiClient.post<ApiResponse<IChatMessage>>(
      `/chat/conversations/${conversationId}/messages`,
      form,
    );
    return response.data;
  },

  async markAsRead(conversationId: string): Promise<void> {
    await apiClient.patch(`/chat/conversations/${conversationId}/read`);
  },

  async getUnreadCount(): Promise<number> {
    const response = await apiClient.get<ApiResponse<{ count: number }>>('/chat/unread-count');
    return response.data.count;
  },

  async searchUsers(query: string): Promise<IChatUser[]> {
    const response = await apiClient.get<ApiResponse<IChatUser[]>>(`/chat/users/search?q=${encodeURIComponent(query)}`);
    return response.data || [];
  },

  async getRequests(box: 'inbox' | 'outbox'): Promise<IChatContactRequest[]> {
    const response = await apiClient.get<ApiResponse<IChatContactRequest[]>>(`/chat/requests?box=${box}`);
    return response.data || [];
  },

  async createRequest(targetUserId: string, message?: string): Promise<IChatContactRequest> {
    const response = await apiClient.post<ApiResponse<IChatContactRequest>>('/chat/requests', {
      targetUserId,
      message,
    });
    return response.data;
  },

  async approveRequest(requestId: string): Promise<{ request: IChatContactRequest; conversation_id: string }> {
    const response = await apiClient.patch<ApiResponse<{ request: IChatContactRequest; conversation_id: string }>>(
      `/chat/requests/${requestId}/approve`,
    );
    return response.data;
  },

  async rejectRequest(requestId: string): Promise<IChatContactRequest> {
    const response = await apiClient.patch<ApiResponse<IChatContactRequest>>(`/chat/requests/${requestId}/reject`);
    return response.data;
  },
};
