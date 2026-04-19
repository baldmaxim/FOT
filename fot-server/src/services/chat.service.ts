import { supabase } from '../config/database.js';
import { encryptionService } from './encryption.service.js';
import {
  chatPolicyService,
  type ChatAvailability,
  type ChatRequestStatus,
  type IChatPolicyDecision,
} from './chat-policy.service.js';
import { ChatError } from './chat.errors.js';

export interface IChatConversation {
  id: string;
  created_at: string;
  updated_at: string;
  participants: { user_id: string; full_name: string | null }[];
  last_message: { content: string; sender_id: string; created_at: string } | null;
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
}

export interface IChatUser {
  id: string;
  full_name: string | null;
  role_code: string;
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

type ChatRequestRow = {
  id: string;
  requester_id: string;
  target_user_id: string;
  message: string | null;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
};

type ConversationAccess = {
  participantIds: string[];
  is_writable: boolean;
  write_lock_reason: string | null;
};

const decryptOrPassthrough = (content: string): string => {
  if (/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i.test(content)) {
    try {
      return encryptionService.decrypt(content);
    } catch {
      return content;
    }
  }
  return content;
};

const wasReadByTimestamp = (readAt: string | null | undefined, createdAt: string): boolean => {
  if (!readAt) return false;
  return new Date(readAt).getTime() >= new Date(createdAt).getTime();
};

const toWriteState = (
  participantIds: string[],
  currentUserId: string,
  decisions: Map<string, IChatPolicyDecision>,
) => {
  const otherParticipantId = participantIds.find(userId => userId !== currentUserId) || null;
  if (!otherParticipantId) {
    return { is_writable: false, write_lock_reason: 'Диалог больше не связан с доступным собеседником' };
  }

  const decision = decisions.get(otherParticipantId);
  if (!decision) {
    return { is_writable: false, write_lock_reason: 'Не удалось определить текущие права на диалог' };
  }

  if (decision.availability === 'direct') {
    return { is_writable: true, write_lock_reason: null };
  }

  return {
    is_writable: false,
    write_lock_reason: decision.availability_reason,
  };
};

async function getConversationParticipantIds(conversationId: string): Promise<string[]> {
  const { data: participants, error } = await supabase
    .from('chat_participants')
    .select('user_id')
    .eq('conversation_id', conversationId);

  if (error) {
    throw new Error('Failed to load conversation participants');
  }

  return (participants || []).map(participant => participant.user_id);
}

async function getOrCreateConversationRecord(userId1: string, userId2: string): Promise<string> {
  const { data: existing, error: rpcError } = await supabase
    .rpc('find_direct_conversation', { user1: userId1, user2: userId2 });

  if (rpcError) {
    throw new Error('Failed to search existing conversation');
  }

  if (existing && existing.length > 0) {
    return existing[0].conversation_id;
  }

  const { data: conversation, error: conversationError } = await supabase
    .from('chat_conversations')
    .insert({})
    .select('id')
    .single();

  if (conversationError || !conversation) {
    throw new Error('Failed to create conversation');
  }

  const { error: participantsError } = await supabase
    .from('chat_participants')
    .insert([
      { conversation_id: conversation.id, user_id: userId1 },
      { conversation_id: conversation.id, user_id: userId2 },
    ]);

  if (participantsError) {
    throw new Error('Failed to create conversation participants');
  }

  return conversation.id;
}

async function formatContactRequests(rows: ChatRequestRow[], currentUserId: string): Promise<IChatContactRequest[]> {
  if (rows.length === 0) return [];

  const profileIds = [...new Set(rows.flatMap(row => [row.requester_id, row.target_user_id, row.resolved_by]).filter(Boolean) as string[])];

  const { data: profiles, error } = await supabase
    .from('user_profiles')
    .select('id, full_name')
    .in('id', profileIds);

  if (error) {
    throw new Error('Failed to load request participants');
  }

  const profileById = new Map<string, { id: string; full_name: string | null }>();
  (profiles || []).forEach(profile => profileById.set(profile.id, profile));

  return rows.map(row => ({
    id: row.id,
    requester_id: row.requester_id,
    requester_name: profileById.get(row.requester_id)?.full_name || null,
    target_user_id: row.target_user_id,
    target_name: profileById.get(row.target_user_id)?.full_name || null,
    message: row.message,
    status: row.status,
    created_at: row.created_at,
    resolved_at: row.resolved_at,
    resolved_by: row.resolved_by,
    resolved_by_name: row.resolved_by ? (profileById.get(row.resolved_by)?.full_name || null) : null,
    direction: row.target_user_id === currentUserId ? 'inbox' : 'outbox',
  }));
}

export const chatService = {
  async getOrCreateConversation(userId1: string, userId2: string): Promise<string> {
    const decision = await chatPolicyService.getPairDecision(userId1, userId2);

    if (decision.availability === 'request') {
      throw new ChatError(decision.availability_reason, 403, 'CHAT_REQUEST_REQUIRED');
    }

    if (decision.availability !== 'direct') {
      throw new ChatError(decision.availability_reason, 403, 'CHAT_FORBIDDEN');
    }

    return getOrCreateConversationRecord(userId1, userId2);
  },

  async getConversationAccess(conversationId: string, userId: string): Promise<ConversationAccess> {
    const participantIds = await getConversationParticipantIds(conversationId);

    if (!participantIds.includes(userId)) {
      throw new ChatError('Вы не участвуете в этом диалоге', 403, 'CHAT_ACCESS_DENIED');
    }

    if (participantIds.length !== 2) {
      return {
        participantIds,
        is_writable: false,
        write_lock_reason: 'Поддерживаются только личные диалоги',
      };
    }

    const otherParticipantId = participantIds.find(participantId => participantId !== userId);
    if (!otherParticipantId) {
      return {
        participantIds,
        is_writable: false,
        write_lock_reason: 'Собеседник не найден',
      };
    }

    const decision = await chatPolicyService.getPairDecision(userId, otherParticipantId);
    return {
      participantIds,
      is_writable: decision.availability === 'direct',
      write_lock_reason: decision.availability === 'direct' ? null : decision.availability_reason,
    };
  },

  async sendMessage(conversationId: string, senderId: string, content: string): Promise<IChatMessage> {
    const access = await this.getConversationAccess(conversationId, senderId);
    if (!access.is_writable) {
      throw new ChatError(access.write_lock_reason || 'Отправка сообщений недоступна', 403, 'CHAT_WRITE_FORBIDDEN');
    }

    const plainContent = content.trim();
    const encryptedContent = encryptionService.encrypt(plainContent);

    const { data: message, error } = await supabase
      .from('chat_messages')
      .insert({
        conversation_id: conversationId,
        sender_id: senderId,
        content: encryptedContent,
      })
      .select('id, conversation_id, sender_id, content, created_at')
      .single();

    if (error || !message) {
      throw new Error('Failed to send message');
    }

    await supabase
      .from('chat_conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', conversationId);

    await supabase
      .from('chat_participants')
      .update({ last_read_at: new Date().toISOString() })
      .eq('conversation_id', conversationId)
      .eq('user_id', senderId);

    return { ...message, content: plainContent, is_read: false } as IChatMessage;
  },

  async getMessages(conversationId: string, userId: string, limit = 50, offset = 0): Promise<IChatMessage[]> {
    await this.getConversationAccess(conversationId, userId);

    const { data, error } = await supabase
      .from('chat_messages')
      .select('id, conversation_id, sender_id, content, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw new Error('Failed to fetch messages');

    const { data: participants, error: participantsError } = await supabase
      .from('chat_participants')
      .select('conversation_id, user_id, last_read_at')
      .eq('conversation_id', conversationId);

    if (participantsError) {
      throw new Error('Failed to fetch conversation read state');
    }

    const otherParticipant = (participants || []).find(participant => participant.user_id !== userId);
    const currentParticipant = (participants || []).find(participant => participant.user_id === userId);
    const otherLastReadAt = otherParticipant?.last_read_at ?? null;
    const currentLastReadAt = currentParticipant?.last_read_at ?? null;

    return (data || []).map(message => ({
      ...message,
      content: decryptOrPassthrough(message.content),
      is_read: message.sender_id === userId
        ? wasReadByTimestamp(otherLastReadAt, message.created_at)
        : wasReadByTimestamp(currentLastReadAt, message.created_at),
    })) as IChatMessage[];
  },

  async getConversations(userId: string): Promise<IChatConversation[]> {
    const { data: participations, error: participationsError } = await supabase
      .from('chat_participants')
      .select('conversation_id, last_read_at')
      .eq('user_id', userId);

    if (participationsError) {
      throw new Error('Failed to load conversations');
    }

    if (!participations || participations.length === 0) return [];

    const conversationIds = participations.map(participation => participation.conversation_id);

    const { data: conversations, error: conversationsError } = await supabase
      .from('chat_conversations')
      .select('id, created_at, updated_at')
      .in('id', conversationIds)
      .order('updated_at', { ascending: false });

    if (conversationsError) {
      throw new Error('Failed to load conversations');
    }

    if (!conversations || conversations.length === 0) return [];

    const { data: allParticipants, error: allParticipantsError } = await supabase
      .from('chat_participants')
      .select('conversation_id, user_id, last_read_at')
      .in('conversation_id', conversationIds);

    if (allParticipantsError) {
      throw new Error('Failed to load conversation participants');
    }

    const participantsByConversation = new Map<string, string[]>();
    const readAtByConversationUser = new Map<string, Map<string, string | null>>();
    (allParticipants || []).forEach(participant => {
      const existing = participantsByConversation.get(participant.conversation_id) || [];
      existing.push(participant.user_id);
      participantsByConversation.set(participant.conversation_id, existing);

      const readMap = readAtByConversationUser.get(participant.conversation_id) || new Map<string, string | null>();
      readMap.set(participant.user_id, participant.last_read_at ?? null);
      readAtByConversationUser.set(participant.conversation_id, readMap);
    });

    const allUserIds = [...new Set((allParticipants || []).map(participant => participant.user_id))];
    const { data: profiles, error: profilesError } = await supabase
      .from('user_profiles')
      .select('id, full_name')
      .in('id', allUserIds);

    if (profilesError) {
      throw new Error('Failed to load conversation profiles');
    }

    const profileById = new Map<string, { id: string; full_name: string | null }>();
    (profiles || []).forEach(profile => profileById.set(profile.id, profile));

    const { data: allMessages, error: allMessagesError } = await supabase
      .from('chat_messages')
      .select('conversation_id, content, sender_id, created_at')
      .in('conversation_id', conversationIds)
      .order('created_at', { ascending: false })
      .limit(conversationIds.length * 50);

    if (allMessagesError) {
      throw new Error('Failed to load conversation messages');
    }

    const lastMessageByConversation = new Map<string, { content: string; sender_id: string; created_at: string }>();
    const unreadByConversation = new Map<string, number>();

    (allMessages || []).forEach(message => {
      if (!lastMessageByConversation.has(message.conversation_id)) {
        lastMessageByConversation.set(message.conversation_id, {
          content: message.content,
          sender_id: message.sender_id,
          created_at: message.created_at,
        });
      }

      const currentUserReadAt = readAtByConversationUser.get(message.conversation_id)?.get(userId) ?? null;
      if (message.sender_id !== userId && !wasReadByTimestamp(currentUserReadAt, message.created_at)) {
        unreadByConversation.set(
          message.conversation_id,
          (unreadByConversation.get(message.conversation_id) || 0) + 1,
        );
      }
    });

    const otherUserIds = [...new Set(
      conversations
        .flatMap(conversation => participantsByConversation.get(conversation.id) || [])
        .filter(participantId => participantId !== userId),
    )];

    const decisions = await chatPolicyService.getDecisionsForTargets(userId, otherUserIds);

    return conversations.map(conversation => {
      const participantIds = participantsByConversation.get(conversation.id) || [];
      const participants = participantIds
        .map(userIdValue => profileById.get(userIdValue))
        .filter((profile): profile is { id: string; full_name: string | null } => !!profile)
        .map(profile => ({ user_id: profile.id, full_name: profile.full_name }));

      const lastMessage = lastMessageByConversation.get(conversation.id);
      const writeState = toWriteState(participantIds, userId, decisions);

      return {
        id: conversation.id,
        created_at: conversation.created_at,
        updated_at: conversation.updated_at,
        participants,
        last_message: lastMessage ? {
          content: decryptOrPassthrough(lastMessage.content),
          sender_id: lastMessage.sender_id,
          created_at: lastMessage.created_at,
        } : null,
        unread_count: unreadByConversation.get(conversation.id) || 0,
        is_writable: writeState.is_writable,
        write_lock_reason: writeState.write_lock_reason,
      };
    });
  },

  async markAsRead(conversationId: string, userId: string): Promise<void> {
    await this.getConversationAccess(conversationId, userId);

    await supabase
      .from('chat_participants')
      .update({ last_read_at: new Date().toISOString() })
      .eq('conversation_id', conversationId)
      .eq('user_id', userId);
  },

  async getUnreadCount(userId: string): Promise<number> {
    const { data: participations, error: participationsError } = await supabase
      .from('chat_participants')
      .select('conversation_id, last_read_at')
      .eq('user_id', userId);

    if (participationsError) {
      throw new Error('Failed to load unread count');
    }

    if (!participations || participations.length === 0) return 0;

    const conversationIds = participations.map(participation => participation.conversation_id);
    const lastReadByConversation = new Map(
      participations.map(participation => [participation.conversation_id, participation.last_read_at ?? null] as const),
    );

    const { data: messages, error } = await supabase
      .from('chat_messages')
      .select('conversation_id, sender_id, created_at')
      .in('conversation_id', conversationIds)
      .neq('sender_id', userId);

    if (error) {
      throw new Error('Failed to load unread count');
    }

    return (messages || []).reduce((count, message) => (
      wasReadByTimestamp(lastReadByConversation.get(message.conversation_id) ?? null, message.created_at)
        ? count
        : count + 1
    ), 0);
  },

  async searchUsers(query: string, currentUserId: string): Promise<IChatUser[]> {
    let request = supabase
      .from('user_profiles')
      .select('id')
      .neq('id', currentUserId)
      .eq('is_approved', true)
      .order('full_name', { ascending: true })
      .limit(50);

    if (query.trim()) {
      request = request.ilike('full_name', `%${query.trim()}%`);
    }

    const { data: users, error } = await request;
    if (error) {
      throw new Error('Failed to search users');
    }

    const candidateIds = (users || []).map(user => user.id);
    if (candidateIds.length === 0) return [];

    const [contexts, decisions] = await Promise.all([
      chatPolicyService.getUserContexts([currentUserId, ...candidateIds]),
      chatPolicyService.getDecisionsForTargets(currentUserId, candidateIds),
    ]);

    const results: IChatUser[] = [];
    candidateIds.forEach(userIdValue => {
      const context = contexts.get(userIdValue);
      const decision = decisions.get(userIdValue);

      if (!context || !decision || decision.availability === 'forbidden') {
        return;
      }

      results.push({
        id: context.id,
        full_name: context.full_name,
        role_code: context.role_code,
        department_id: context.department_id,
        availability: decision.availability,
        availability_reason: decision.availability_reason,
        request_status: decision.request_status,
      });
    });

    return results;
  },

  async listContactRequests(userId: string, box: 'inbox' | 'outbox'): Promise<IChatContactRequest[]> {
    const query = supabase
      .from('chat_contact_requests')
      .select('id, requester_id, target_user_id, message, status, created_at, resolved_at, resolved_by')
      .order('created_at', { ascending: false });

    const { data, error } = box === 'inbox'
      ? await query.eq('target_user_id', userId)
      : await query.eq('requester_id', userId);

    if (error) {
      throw new Error('Failed to load chat requests');
    }

    return formatContactRequests((data || []) as ChatRequestRow[], userId);
  },

  async createContactRequest(requesterId: string, targetUserId: string, message?: string | null): Promise<IChatContactRequest> {
    if (requesterId === targetUserId) {
      throw new ChatError('Нельзя отправить запрос самому себе', 400, 'CHAT_INVALID_TARGET');
    }

    const decision = await chatPolicyService.getPairDecision(requesterId, targetUserId);

    if (decision.availability === 'direct') {
      throw new ChatError('Прямой чат уже доступен без запроса', 400, 'CHAT_DIRECT_AVAILABLE');
    }

    if (decision.availability !== 'request') {
      throw new ChatError(decision.availability_reason, 403, 'CHAT_FORBIDDEN');
    }

    const [existingOutgoing, existingIncoming] = await Promise.all([
      supabase
        .from('chat_contact_requests')
        .select('id, requester_id, target_user_id, message, status, created_at, resolved_at, resolved_by')
        .eq('requester_id', requesterId)
        .eq('target_user_id', targetUserId)
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(1),
      supabase
        .from('chat_contact_requests')
        .select('id, requester_id, target_user_id, message, status, created_at, resolved_at, resolved_by')
        .eq('requester_id', targetUserId)
        .eq('target_user_id', requesterId)
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(1),
    ]);

    const existingErrors = [existingOutgoing.error, existingIncoming.error].filter(Boolean);
    if (existingErrors.length > 0) {
      throw new Error('Failed to validate existing requests');
    }

    const existingRow = ((existingOutgoing.data || [])[0] || (existingIncoming.data || [])[0]) as ChatRequestRow | undefined;
    if (existingRow) {
      const requests = await formatContactRequests([existingRow], requesterId);
      return requests[0];
    }

    const { data, error } = await supabase
      .from('chat_contact_requests')
      .insert({
        requester_id: requesterId,
        target_user_id: targetUserId,
        message: message?.trim() || null,
      })
      .select('id, requester_id, target_user_id, message, status, created_at, resolved_at, resolved_by')
      .single();

    if (error || !data) {
      throw new Error('Failed to create chat request');
    }

    const requests = await formatContactRequests([data as ChatRequestRow], requesterId);
    return requests[0];
  },

  async approveContactRequest(requestId: string, currentUserId: string): Promise<{ request: IChatContactRequest; conversation_id: string }> {
    const { data: requestRow, error } = await supabase
      .from('chat_contact_requests')
      .select('id, requester_id, target_user_id, message, status, created_at, resolved_at, resolved_by')
      .eq('id', requestId)
      .single();

    if (error || !requestRow) {
      throw new ChatError('Запрос не найден', 404, 'CHAT_REQUEST_NOT_FOUND');
    }

    if (requestRow.target_user_id !== currentUserId) {
      throw new ChatError('Вы не можете обработать этот запрос', 403, 'CHAT_REQUEST_FORBIDDEN');
    }

    if (requestRow.status !== 'pending') {
      throw new ChatError('Запрос уже обработан', 400, 'CHAT_REQUEST_ALREADY_RESOLVED');
    }

    const [userAId, userBId] = chatPolicyService.normalizePair(requestRow.requester_id, requestRow.target_user_id);

    const { error: grantError } = await supabase
      .from('chat_contact_grants')
      .upsert({
        user_a_id: userAId,
        user_b_id: userBId,
        source: 'request',
        created_by: currentUserId,
      }, { onConflict: 'user_a_id,user_b_id' });

    if (grantError) {
      throw new Error('Failed to create chat grant');
    }

    const now = new Date().toISOString();
    const { data: updatedRequest, error: updateError } = await supabase
      .from('chat_contact_requests')
      .update({
        status: 'approved',
        resolved_by: currentUserId,
        resolved_at: now,
        updated_at: now,
      })
      .eq('id', requestId)
      .select('id, requester_id, target_user_id, message, status, created_at, resolved_at, resolved_by')
      .single();

    if (updateError || !updatedRequest) {
      throw new Error('Failed to approve chat request');
    }

    const conversationId = await getOrCreateConversationRecord(updatedRequest.requester_id, updatedRequest.target_user_id);
    const requests = await formatContactRequests([updatedRequest as ChatRequestRow], currentUserId);

    return {
      request: requests[0],
      conversation_id: conversationId,
    };
  },

  async rejectContactRequest(requestId: string, currentUserId: string): Promise<IChatContactRequest> {
    const { data: requestRow, error } = await supabase
      .from('chat_contact_requests')
      .select('id, requester_id, target_user_id, message, status, created_at, resolved_at, resolved_by')
      .eq('id', requestId)
      .single();

    if (error || !requestRow) {
      throw new ChatError('Запрос не найден', 404, 'CHAT_REQUEST_NOT_FOUND');
    }

    if (requestRow.target_user_id !== currentUserId) {
      throw new ChatError('Вы не можете обработать этот запрос', 403, 'CHAT_REQUEST_FORBIDDEN');
    }

    if (requestRow.status !== 'pending') {
      throw new ChatError('Запрос уже обработан', 400, 'CHAT_REQUEST_ALREADY_RESOLVED');
    }

    const now = new Date().toISOString();
    const { data: updatedRequest, error: updateError } = await supabase
      .from('chat_contact_requests')
      .update({
        status: 'rejected',
        resolved_by: currentUserId,
        resolved_at: now,
        updated_at: now,
      })
      .eq('id', requestId)
      .select('id, requester_id, target_user_id, message, status, created_at, resolved_at, resolved_by')
      .single();

    if (updateError || !updatedRequest) {
      throw new Error('Failed to reject chat request');
    }

    const requests = await formatContactRequests([updatedRequest as ChatRequestRow], currentUserId);
    return requests[0];
  },
};
