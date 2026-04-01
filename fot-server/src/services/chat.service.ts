import { supabase } from '../config/database.js';
import { encryptionService } from './encryption.service.js';

export interface IChatConversation {
  id: string;
  organization_id: string;
  created_at: string;
  updated_at: string;
  participants: { user_id: string; full_name: string | null }[];
  last_message: { content: string; sender_id: string; created_at: string } | null;
  unread_count: number;
}

export interface IChatMessage {
  id: string;
  conversation_id: string;
  sender_id: string;
  content: string;
  is_read: boolean;
  created_at: string;
}

/**
 * Расшифровать контент или вернуть как есть (для старых незашифрованных сообщений)
 */
const decryptOrPassthrough = (content: string): string => {
  // Encrypted format: hex:hex:hex (iv:authTag:encrypted)
  if (/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i.test(content)) {
    try {
      return encryptionService.decrypt(content);
    } catch {
      return content;
    }
  }
  return content;
};

export const chatService = {
  /**
   * Получить или создать диалог между двумя пользователями
   */
  async getOrCreateConversation(userId1: string, userId2: string, organizationId: string): Promise<string> {
    // Ищем существующий диалог между этими двумя пользователями
    const { data: existing } = await supabase
      .rpc('find_direct_conversation', { user1: userId1, user2: userId2 });

    if (existing && existing.length > 0) {
      return existing[0].conversation_id;
    }

    // Создаём новый диалог
    const { data: conv, error: convError } = await supabase
      .from('chat_conversations')
      .insert({ organization_id: organizationId })
      .select('id')
      .single();

    if (convError || !conv) {
      throw new Error('Failed to create conversation');
    }

    // Добавляем участников
    await supabase
      .from('chat_participants')
      .insert([
        { conversation_id: conv.id, user_id: userId1 },
        { conversation_id: conv.id, user_id: userId2 },
      ]);

    return conv.id;
  },

  /**
   * Отправить сообщение (шифрует контент перед сохранением)
   */
  async sendMessage(conversationId: string, senderId: string, content: string): Promise<IChatMessage> {
    // Проверяем что отправитель — участник
    const { data: participant } = await supabase
      .from('chat_participants')
      .select('id')
      .eq('conversation_id', conversationId)
      .eq('user_id', senderId)
      .single();

    if (!participant) {
      throw new Error('Not a participant of this conversation');
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
      .select('*')
      .single();

    if (error || !message) {
      throw new Error('Failed to send message');
    }

    // Обновляем updated_at диалога
    await supabase
      .from('chat_conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', conversationId);

    // Возвращаем с расшифрованным контентом для socket broadcast
    return { ...message, content: plainContent } as IChatMessage;
  },

  /**
   * Получить сообщения диалога (расшифровывает контент)
   */
  async getMessages(conversationId: string, userId: string, limit = 50, offset = 0): Promise<IChatMessage[]> {
    // Проверяем участие
    const { data: participant } = await supabase
      .from('chat_participants')
      .select('id')
      .eq('conversation_id', conversationId)
      .eq('user_id', userId)
      .single();

    if (!participant) {
      throw new Error('Not a participant');
    }

    const { data, error } = await supabase
      .from('chat_messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw new Error('Failed to fetch messages');

    return (data || []).map(msg => ({
      ...msg,
      content: decryptOrPassthrough(msg.content),
    })) as IChatMessage[];
  },

  /**
   * Получить список диалогов пользователя
   */
  async getConversations(userId: string): Promise<IChatConversation[]> {
    // Получаем conversation_ids пользователя
    const { data: participations } = await supabase
      .from('chat_participants')
      .select('conversation_id')
      .eq('user_id', userId);

    if (!participations || participations.length === 0) return [];

    const convIds = participations.map(p => p.conversation_id);

    // Получаем диалоги
    const { data: conversations } = await supabase
      .from('chat_conversations')
      .select('*')
      .in('id', convIds)
      .order('updated_at', { ascending: false });

    if (!conversations) return [];

    // Для каждого диалога: участники, последнее сообщение, непрочитанные
    const result: IChatConversation[] = await Promise.all(
      conversations.map(async (conv) => {
        // Участники
        const { data: parts } = await supabase
          .from('chat_participants')
          .select('user_id')
          .eq('conversation_id', conv.id);

        const participantIds = (parts || []).map(p => p.user_id);

        // Получаем имена
        const { data: profiles } = await supabase
          .from('user_profiles')
          .select('id, full_name')
          .in('id', participantIds);

        const participants = (profiles || []).map(p => ({
          user_id: p.id,
          full_name: p.full_name,
        }));

        // Последнее сообщение
        const { data: lastMsg } = await supabase
          .from('chat_messages')
          .select('content, sender_id, created_at')
          .eq('conversation_id', conv.id)
          .order('created_at', { ascending: false })
          .limit(1)
          .single();

        // Непрочитанные (не от текущего пользователя)
        const { count: unreadCount } = await supabase
          .from('chat_messages')
          .select('id', { count: 'exact', head: true })
          .eq('conversation_id', conv.id)
          .eq('is_read', false)
          .neq('sender_id', userId);

        return {
          id: conv.id,
          organization_id: conv.organization_id,
          created_at: conv.created_at,
          updated_at: conv.updated_at,
          participants,
          last_message: lastMsg ? {
            ...lastMsg,
            content: decryptOrPassthrough(lastMsg.content),
          } : null,
          unread_count: unreadCount || 0,
        };
      })
    );

    return result;
  },

  /**
   * Пометить сообщения как прочитанные
   */
  async markAsRead(conversationId: string, userId: string): Promise<void> {
    await supabase
      .from('chat_messages')
      .update({ is_read: true })
      .eq('conversation_id', conversationId)
      .eq('is_read', false)
      .neq('sender_id', userId);
  },

  /**
   * Получить общее количество непрочитанных сообщений для пользователя
   */
  async getUnreadCount(userId: string): Promise<number> {
    const { data: participations } = await supabase
      .from('chat_participants')
      .select('conversation_id')
      .eq('user_id', userId);

    if (!participations || participations.length === 0) return 0;

    const convIds = participations.map(p => p.conversation_id);

    const { count } = await supabase
      .from('chat_messages')
      .select('id', { count: 'exact', head: true })
      .in('conversation_id', convIds)
      .eq('is_read', false)
      .neq('sender_id', userId);

    return count || 0;
  },

  /**
   * Поиск пользователей для начала диалога
   */
  async searchUsers(query: string, organizationId: string, currentUserId: string): Promise<{ id: string; full_name: string | null }[]> {
    let dbQuery = supabase
      .from('user_profiles')
      .select('id, full_name')
      .eq('organization_id', organizationId)
      .neq('id', currentUserId)
      .order('full_name', { ascending: true })
      .limit(50);

    if (query && query.trim()) {
      dbQuery = dbQuery.ilike('full_name', `%${query.trim()}%`);
    }

    const { data } = await dbQuery;

    return (data || []).map(u => ({ id: u.id, full_name: u.full_name }));
  },
};
