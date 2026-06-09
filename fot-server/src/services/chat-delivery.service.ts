import { getIo } from '../socket/io-instance.js';
import { chatService, type IChatMessage } from './chat.service.js';
import { pushService } from './push.service.js';
import { notificationService } from './notification.service.js';

// Доставка нового сообщения: emit в комнату диалога + персональные уведомления
// (socket message_notification, Web Push, запись в БД). Общий код для socket-пути
// (send_message) и REST-пути (отправка с файлом).
export const dispatchChatMessage = async (message: IChatMessage, senderId: string): Promise<void> => {
  const io = getIo();
  if (io) io.to(`conv:${message.conversation_id}`).emit('new_message', message);

  const conversations = await chatService.getConversations(senderId);
  const conv = conversations.find(c => c.id === message.conversation_id);
  if (!conv) return;

  const senderName = conv.participants.find(p => p.user_id === senderId)?.full_name || 'Сообщение';
  const messagePreview = message.content?.slice(0, 100)
    || (message.attachment ? `📎 ${message.attachment.name}` : '');

  for (const p of conv.participants) {
    if (p.user_id === senderId) continue;

    if (io) {
      io.to(`user:${p.user_id}`).emit('message_notification', {
        conversationId: message.conversation_id,
        message,
      });
    }
    // Web Push — доставит уведомление даже если вкладка закрыта
    pushService.sendChatNotification(p.user_id, {
      senderName,
      messagePreview,
      conversationId: message.conversation_id,
    }).catch(() => undefined);

    notificationService.createMany([{
      userId: p.user_id,
      type: 'chat_message',
      title: senderName,
      body: messagePreview,
      metadata: { conversationId: message.conversation_id },
    }]).catch(() => undefined);
  }
};
