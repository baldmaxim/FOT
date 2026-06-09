import { execute, query, queryOne, withTransaction } from '../config/postgres.js';
import { encryptionService } from './encryption.service.js';
import { escapeLike } from '../utils/search.utils.js';
import {
  chatPolicyService,
  type ChatAvailability,
  type ChatRequestStatus,
  type IChatPolicyDecision,
} from './chat-policy.service.js';
import { ChatError } from './chat.errors.js';
import { notificationService } from './notification.service.js';
import { r2Service } from './r2.service.js';

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

// Подписываем короткоживущий URL для вложения при отдаче клиенту (в БД хранится
// только key). Для картинок — inline (предпросмотр в <img>), для прочего — attachment.
const withAttachmentUrl = async (attachment: IChatAttachment | null): Promise<IChatAttachment | null> => {
  if (!attachment?.key) return attachment ?? null;
  try {
    const disposition = attachment.mime?.startsWith('image/') ? 'inline' : 'attachment';
    const url = await r2Service.generateDownloadUrl(attachment.key, attachment.name, disposition);
    return { ...attachment, url };
  } catch {
    return attachment;
  }
};

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

const REQUEST_COLS =
  'id, requester_id, target_user_id, message, status, created_at, resolved_at, resolved_by';

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
  let rows: Array<{ user_id: string }>;
  try {
    rows = await query<{ user_id: string }>(
      `SELECT user_id FROM chat_participants WHERE conversation_id = $1`,
      [conversationId],
    );
  } catch {
    throw new Error('Failed to load conversation participants');
  }
  return rows.map(p => p.user_id);
}

async function getOrCreateConversationRecord(userId1: string, userId2: string): Promise<string> {
  // Используем функцию find_direct_conversation (см. миграцию 087).
  let existing: Array<{ conversation_id: string }>;
  try {
    existing = await query<{ conversation_id: string }>(
      `SELECT conversation_id FROM find_direct_conversation($1::uuid, $2::uuid)`,
      [userId1, userId2],
    );
  } catch {
    throw new Error('Failed to search existing conversation');
  }

  if (existing.length > 0) {
    return existing[0].conversation_id;
  }

  // Создание новой беседы + участников в одной транзакции.
  try {
    return await withTransaction(async (client) => {
      const insRes = await client.query<{ id: string }>(
        `INSERT INTO chat_conversations DEFAULT VALUES RETURNING id`,
      );
      const conversationId = insRes.rows[0]?.id;
      if (!conversationId) throw new Error('Failed to create conversation');

      await client.query(
        `INSERT INTO chat_participants (conversation_id, user_id)
         VALUES ($1, $2), ($1, $3)`,
        [conversationId, userId1, userId2],
      );

      return conversationId;
    });
  } catch (err) {
    if (err instanceof Error && err.message === 'Failed to create conversation') throw err;
    throw new Error('Failed to create conversation participants');
  }
}

async function formatContactRequests(rows: ChatRequestRow[], currentUserId: string): Promise<IChatContactRequest[]> {
  if (rows.length === 0) return [];

  const profileIds = [...new Set(
    rows.flatMap(row => [row.requester_id, row.target_user_id, row.resolved_by])
      .filter((v): v is string => Boolean(v)),
  )];

  let profiles: Array<{ id: string; full_name: string | null }> = [];
  if (profileIds.length > 0) {
    try {
      profiles = await query<{ id: string; full_name: string | null }>(
        `SELECT id, full_name FROM user_profiles WHERE id = ANY($1::uuid[])`,
        [profileIds],
      );
    } catch {
      throw new Error('Failed to load request participants');
    }
  }

  const profileById = new Map<string, { id: string; full_name: string | null }>();
  profiles.forEach(profile => profileById.set(profile.id, profile));

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

  async sendMessage(
    conversationId: string,
    senderId: string,
    content: string,
    attachment?: IChatAttachment | null,
  ): Promise<IChatMessage> {
    const access = await this.getConversationAccess(conversationId, senderId);
    if (!access.is_writable) {
      throw new ChatError(access.write_lock_reason || 'Отправка сообщений недоступна', 403, 'CHAT_WRITE_FORBIDDEN');
    }

    const plainContent = content.trim();
    if (!plainContent && !attachment) {
      throw new ChatError('Сообщение пустое', 400, 'CHAT_EMPTY_MESSAGE');
    }
    const encryptedContent = encryptionService.encrypt(plainContent);
    // В БД храним только метаданные без подписанного URL — он короткоживущий.
    const attachmentForDb = attachment
      ? { key: attachment.key, name: attachment.name, size: attachment.size, mime: attachment.mime }
      : null;

    // Многошаговая операция (insert + touch conversation + last_read) — в TX.
    const message = await withTransaction(async (client) => {
      const insRes = await client.query<{
        id: string;
        conversation_id: string;
        sender_id: string;
        content: string;
        created_at: string;
        attachment: IChatAttachment | null;
      }>(
        `INSERT INTO chat_messages (conversation_id, sender_id, content, attachment)
         VALUES ($1, $2, $3, $4::jsonb)
         RETURNING id, conversation_id, sender_id, content, created_at, attachment`,
        [conversationId, senderId, encryptedContent, attachmentForDb ? JSON.stringify(attachmentForDb) : null],
      );
      const m = insRes.rows[0];
      if (!m) throw new Error('Failed to send message');

      const nowIso = new Date().toISOString();
      await client.query(
        `UPDATE chat_conversations SET updated_at = $1 WHERE id = $2`,
        [nowIso, conversationId],
      );
      await client.query(
        `UPDATE chat_participants SET last_read_at = $1
          WHERE conversation_id = $2 AND user_id = $3`,
        [nowIso, conversationId, senderId],
      );

      return m;
    });

    return {
      ...message,
      content: plainContent,
      is_read: false,
      attachment: await withAttachmentUrl(message.attachment),
    } as IChatMessage;
  },

  async getMessages(conversationId: string, userId: string, limit = 50, offset = 0): Promise<IChatMessage[]> {
    await this.getConversationAccess(conversationId, userId);

    let data: Array<{
      id: string;
      conversation_id: string;
      sender_id: string;
      content: string;
      created_at: string;
      attachment: IChatAttachment | null;
    }>;
    try {
      data = await query(
        `SELECT id, conversation_id, sender_id, content, created_at, attachment
           FROM chat_messages
          WHERE conversation_id = $1
          ORDER BY created_at DESC
          LIMIT $2 OFFSET $3`,
        [conversationId, limit, offset],
      );
    } catch {
      throw new Error('Failed to fetch messages');
    }

    let participants: Array<{ conversation_id: string; user_id: string; last_read_at: string | null }>;
    try {
      participants = await query(
        `SELECT conversation_id, user_id, last_read_at
           FROM chat_participants
          WHERE conversation_id = $1`,
        [conversationId],
      );
    } catch {
      throw new Error('Failed to fetch conversation read state');
    }

    const otherParticipant = participants.find(participant => participant.user_id !== userId);
    const currentParticipant = participants.find(participant => participant.user_id === userId);
    const otherLastReadAt = otherParticipant?.last_read_at ?? null;
    const currentLastReadAt = currentParticipant?.last_read_at ?? null;

    return Promise.all(data.map(async message => ({
      ...message,
      content: decryptOrPassthrough(message.content),
      is_read: message.sender_id === userId
        ? wasReadByTimestamp(otherLastReadAt, message.created_at)
        : wasReadByTimestamp(currentLastReadAt, message.created_at),
      attachment: await withAttachmentUrl(message.attachment),
    }))) as Promise<IChatMessage[]>;
  },

  async getConversations(userId: string): Promise<IChatConversation[]> {
    let participations: Array<{ conversation_id: string; last_read_at: string | null }>;
    try {
      participations = await query(
        `SELECT conversation_id, last_read_at
           FROM chat_participants
          WHERE user_id = $1`,
        [userId],
      );
    } catch {
      throw new Error('Failed to load conversations');
    }

    if (participations.length === 0) return [];

    const conversationIds = participations.map(p => p.conversation_id);

    let conversations: Array<{ id: string; created_at: string; updated_at: string }>;
    try {
      conversations = await query(
        `SELECT id, created_at, updated_at
           FROM chat_conversations
          WHERE id = ANY($1::uuid[])
          ORDER BY updated_at DESC`,
        [conversationIds],
      );
    } catch {
      throw new Error('Failed to load conversations');
    }

    if (conversations.length === 0) return [];

    let allParticipants: Array<{ conversation_id: string; user_id: string; last_read_at: string | null }>;
    try {
      allParticipants = await query(
        `SELECT conversation_id, user_id, last_read_at
           FROM chat_participants
          WHERE conversation_id = ANY($1::uuid[])`,
        [conversationIds],
      );
    } catch {
      throw new Error('Failed to load conversation participants');
    }

    const participantsByConversation = new Map<string, string[]>();
    const readAtByConversationUser = new Map<string, Map<string, string | null>>();
    allParticipants.forEach(participant => {
      const existing = participantsByConversation.get(participant.conversation_id) || [];
      existing.push(participant.user_id);
      participantsByConversation.set(participant.conversation_id, existing);

      const readMap = readAtByConversationUser.get(participant.conversation_id) || new Map<string, string | null>();
      readMap.set(participant.user_id, participant.last_read_at ?? null);
      readAtByConversationUser.set(participant.conversation_id, readMap);
    });

    const allUserIds = [...new Set(allParticipants.map(p => p.user_id))];
    let profiles: Array<{ id: string; full_name: string | null }>;
    try {
      profiles = await query(
        `SELECT id, full_name FROM user_profiles WHERE id = ANY($1::uuid[])`,
        [allUserIds],
      );
    } catch {
      throw new Error('Failed to load conversation profiles');
    }

    const profileById = new Map<string, { id: string; full_name: string | null }>();
    profiles.forEach(profile => profileById.set(profile.id, profile));

    let allMessages: Array<{
      conversation_id: string;
      content: string;
      sender_id: string;
      created_at: string;
      attachment: IChatAttachment | null;
    }>;
    try {
      allMessages = await query(
        `SELECT conversation_id, content, sender_id, created_at, attachment
           FROM chat_messages
          WHERE conversation_id = ANY($1::uuid[])
          ORDER BY created_at DESC
          LIMIT $2`,
        [conversationIds, conversationIds.length * 50],
      );
    } catch {
      throw new Error('Failed to load conversation messages');
    }

    const lastMessageByConversation = new Map<string, { content: string; sender_id: string; created_at: string; has_attachment: boolean }>();
    const unreadByConversation = new Map<string, number>();

    allMessages.forEach(message => {
      if (!lastMessageByConversation.has(message.conversation_id)) {
        lastMessageByConversation.set(message.conversation_id, {
          content: message.content,
          sender_id: message.sender_id,
          created_at: message.created_at,
          has_attachment: !!message.attachment,
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
          has_attachment: lastMessage.has_attachment,
        } : null,
        unread_count: unreadByConversation.get(conversation.id) || 0,
        is_writable: writeState.is_writable,
        write_lock_reason: writeState.write_lock_reason,
      };
    });
  },

  async markAsRead(conversationId: string, userId: string): Promise<void> {
    await this.getConversationAccess(conversationId, userId);

    await execute(
      `UPDATE chat_participants SET last_read_at = $1
        WHERE conversation_id = $2 AND user_id = $3`,
      [new Date().toISOString(), conversationId, userId],
    );

    // Чтение переписки гасит её chat_message-уведомления и шлёт
    // авторитетный счётчик в шапку (не должно ронять чтение чата).
    await notificationService
      .markChatRead(userId, conversationId)
      .catch(err => console.error('chat.markAsRead → markChatRead failed:', err));
  },

  async getUnreadCount(userId: string): Promise<number> {
    let participations: Array<{ conversation_id: string; last_read_at: string | null }>;
    try {
      participations = await query(
        `SELECT conversation_id, last_read_at
           FROM chat_participants
          WHERE user_id = $1`,
        [userId],
      );
    } catch {
      throw new Error('Failed to load unread count');
    }

    if (participations.length === 0) return 0;

    const conversationIds = participations.map(p => p.conversation_id);
    const lastReadByConversation = new Map(
      participations.map(p => [p.conversation_id, p.last_read_at ?? null] as const),
    );

    let messages: Array<{ conversation_id: string; sender_id: string; created_at: string }>;
    try {
      messages = await query(
        `SELECT conversation_id, sender_id, created_at
           FROM chat_messages
          WHERE conversation_id = ANY($1::uuid[])
            AND sender_id <> $2`,
        [conversationIds, userId],
      );
    } catch {
      throw new Error('Failed to load unread count');
    }

    return messages.reduce((count, message) => (
      wasReadByTimestamp(lastReadByConversation.get(message.conversation_id) ?? null, message.created_at)
        ? count
        : count + 1
    ), 0);
  },

  async searchUsers(searchQuery: string, currentUserId: string): Promise<IChatUser[]> {
    const trimmed = searchQuery.trim();
    let users: Array<{ id: string }>;
    try {
      if (trimmed) {
        users = await query<{ id: string }>(
          `SELECT id FROM user_profiles
            WHERE id <> $1
              AND is_approved = true
              AND full_name ILIKE $2
            ORDER BY full_name ASC
            LIMIT 50`,
          [currentUserId, `%${escapeLike(trimmed)}%`],
        );
      } else {
        users = await query<{ id: string }>(
          `SELECT id FROM user_profiles
            WHERE id <> $1
              AND is_approved = true
            ORDER BY full_name ASC
            LIMIT 50`,
          [currentUserId],
        );
      }
    } catch {
      throw new Error('Failed to search users');
    }

    const candidateIds = users.map(user => user.id);
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
        department_id: context.department_ids[0] ?? null,
        availability: decision.availability,
        availability_reason: decision.availability_reason,
        request_status: decision.request_status,
      });
    });

    return results;
  },

  async listContactRequests(userId: string, box: 'inbox' | 'outbox'): Promise<IChatContactRequest[]> {
    const whereCol = box === 'inbox' ? 'target_user_id' : 'requester_id';
    let data: ChatRequestRow[];
    try {
      data = await query<ChatRequestRow>(
        `SELECT ${REQUEST_COLS}
           FROM chat_contact_requests
          WHERE ${whereCol} = $1
          ORDER BY created_at DESC`,
        [userId],
      );
    } catch {
      throw new Error('Failed to load chat requests');
    }

    return formatContactRequests(data, userId);
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

    let existingOutgoing: ChatRequestRow[];
    let existingIncoming: ChatRequestRow[];
    try {
      [existingOutgoing, existingIncoming] = await Promise.all([
        query<ChatRequestRow>(
          `SELECT ${REQUEST_COLS}
             FROM chat_contact_requests
            WHERE requester_id = $1 AND target_user_id = $2 AND status = 'pending'
            ORDER BY created_at DESC
            LIMIT 1`,
          [requesterId, targetUserId],
        ),
        query<ChatRequestRow>(
          `SELECT ${REQUEST_COLS}
             FROM chat_contact_requests
            WHERE requester_id = $1 AND target_user_id = $2 AND status = 'pending'
            ORDER BY created_at DESC
            LIMIT 1`,
          [targetUserId, requesterId],
        ),
      ]);
    } catch {
      throw new Error('Failed to validate existing requests');
    }

    const existingRow = existingOutgoing[0] || existingIncoming[0];
    if (existingRow) {
      const requests = await formatContactRequests([existingRow], requesterId);
      return requests[0];
    }

    let data: ChatRequestRow | null;
    try {
      data = await queryOne<ChatRequestRow>(
        `INSERT INTO chat_contact_requests (requester_id, target_user_id, message)
         VALUES ($1, $2, $3)
         RETURNING ${REQUEST_COLS}`,
        [requesterId, targetUserId, message?.trim() || null],
      );
    } catch {
      throw new Error('Failed to create chat request');
    }

    if (!data) throw new Error('Failed to create chat request');

    const requests = await formatContactRequests([data], requesterId);
    return requests[0];
  },

  async approveContactRequest(requestId: string, currentUserId: string): Promise<{ request: IChatContactRequest; conversation_id: string }> {
    let requestRow: ChatRequestRow | null;
    try {
      requestRow = await queryOne<ChatRequestRow>(
        `SELECT ${REQUEST_COLS}
           FROM chat_contact_requests
          WHERE id = $1`,
        [requestId],
      );
    } catch {
      throw new ChatError('Запрос не найден', 404, 'CHAT_REQUEST_NOT_FOUND');
    }

    if (!requestRow) {
      throw new ChatError('Запрос не найден', 404, 'CHAT_REQUEST_NOT_FOUND');
    }

    if (requestRow.target_user_id !== currentUserId) {
      throw new ChatError('Вы не можете обработать этот запрос', 403, 'CHAT_REQUEST_FORBIDDEN');
    }

    if (requestRow.status !== 'pending') {
      throw new ChatError('Запрос уже обработан', 400, 'CHAT_REQUEST_ALREADY_RESOLVED');
    }

    const [userAId, userBId] = chatPolicyService.normalizePair(requestRow.requester_id, requestRow.target_user_id);

    // Grant + update запроса — в одной транзакции.
    const updatedRequest = await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO chat_contact_grants (user_a_id, user_b_id, source, created_by)
         VALUES ($1, $2, 'request', $3)
         ON CONFLICT (user_a_id, user_b_id) DO UPDATE SET
           source = EXCLUDED.source,
           created_by = EXCLUDED.created_by`,
        [userAId, userBId, currentUserId],
      );

      const now = new Date().toISOString();
      const upRes = await client.query<ChatRequestRow>(
        `UPDATE chat_contact_requests SET
           status = 'approved',
           resolved_by = $1,
           resolved_at = $2,
           updated_at = $2
         WHERE id = $3
         RETURNING ${REQUEST_COLS}`,
        [currentUserId, now, requestId],
      );
      const row = upRes.rows[0];
      if (!row) throw new Error('Failed to approve chat request');
      return row;
    });

    const conversationId = await getOrCreateConversationRecord(updatedRequest.requester_id, updatedRequest.target_user_id);
    const requests = await formatContactRequests([updatedRequest], currentUserId);

    return {
      request: requests[0],
      conversation_id: conversationId,
    };
  },

  async rejectContactRequest(requestId: string, currentUserId: string): Promise<IChatContactRequest> {
    let requestRow: ChatRequestRow | null;
    try {
      requestRow = await queryOne<ChatRequestRow>(
        `SELECT ${REQUEST_COLS}
           FROM chat_contact_requests
          WHERE id = $1`,
        [requestId],
      );
    } catch {
      throw new ChatError('Запрос не найден', 404, 'CHAT_REQUEST_NOT_FOUND');
    }

    if (!requestRow) {
      throw new ChatError('Запрос не найден', 404, 'CHAT_REQUEST_NOT_FOUND');
    }

    if (requestRow.target_user_id !== currentUserId) {
      throw new ChatError('Вы не можете обработать этот запрос', 403, 'CHAT_REQUEST_FORBIDDEN');
    }

    if (requestRow.status !== 'pending') {
      throw new ChatError('Запрос уже обработан', 400, 'CHAT_REQUEST_ALREADY_RESOLVED');
    }

    const now = new Date().toISOString();
    let updatedRequest: ChatRequestRow | null;
    try {
      updatedRequest = await queryOne<ChatRequestRow>(
        `UPDATE chat_contact_requests SET
           status = 'rejected',
           resolved_by = $1,
           resolved_at = $2,
           updated_at = $2
         WHERE id = $3
         RETURNING ${REQUEST_COLS}`,
        [currentUserId, now, requestId],
      );
    } catch {
      throw new Error('Failed to reject chat request');
    }

    if (!updatedRequest) {
      throw new Error('Failed to reject chat request');
    }

    const requests = await formatContactRequests([updatedRequest], currentUserId);
    return requests[0];
  },
};
