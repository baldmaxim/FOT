import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { chatService } from '../services/chat.service.js';
import { pushService } from '../services/push.service.js';
import type { JWTPayload } from '../types/index.js';

interface IAuthenticatedSocket extends Socket {
  userId?: string;
}

export const setupChatSocket = (io: Server) => {
  // JWT auth middleware
  io.use((socket: IAuthenticatedSocket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error('Authentication required'));
    }

    try {
      const decoded = jwt.verify(token, env.JWT_SECRET) as JWTPayload;
      if (!decoded.is_approved) {
        return next(new Error('Account not approved'));
      }
      socket.userId = decoded.sub;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket: IAuthenticatedSocket) => {
    const userId = socket.userId!;

    // Присоединяем к персональной комнате для получения уведомлений
    socket.join(`user:${userId}`);

    // Присоединение к диалогу
    socket.on('join_conversation', (conversationId: string) => {
      socket.join(`conv:${conversationId}`);
    });

    // Выход из диалога
    socket.on('leave_conversation', (conversationId: string) => {
      socket.leave(`conv:${conversationId}`);
    });

    // Отправка сообщения
    socket.on('send_message', async (data: { conversationId: string; content: string }, callback?: (response: unknown) => void) => {
      try {
        const message = await chatService.sendMessage(data.conversationId, userId, data.content);

        // Отправляем всем в комнате диалога
        io.to(`conv:${data.conversationId}`).emit('new_message', message);

        // Уведомляем участников, которые не в комнате
        const conversations = await chatService.getConversations(userId);
        const conv = conversations.find(c => c.id === data.conversationId);
        if (conv) {
          const senderName = conv.participants.find(p => p.user_id === userId)?.full_name || 'Сообщение';
          const messagePreview = message.content.slice(0, 100);

          for (const p of conv.participants) {
            if (p.user_id !== userId) {
              io.to(`user:${p.user_id}`).emit('message_notification', {
                conversationId: data.conversationId,
                message,
              });
              // Web Push — доставит уведомление даже если вкладка закрыта
              pushService.sendChatNotification(p.user_id, {
                senderName,
                messagePreview,
                conversationId: data.conversationId,
              }).catch(() => undefined);
            }
          }
        }

        if (callback) callback({ success: true, data: message });
      } catch (error) {
        if (callback) callback({ success: false, error: 'Failed to send message' });
      }
    });

    // Индикатор набора текста
    socket.on('typing', (conversationId: string) => {
      socket.to(`conv:${conversationId}`).emit('user_typing', {
        conversationId,
        userId,
      });
    });

    // Пометить как прочитанное
    socket.on('mark_read', async (conversationId: string) => {
      try {
        await chatService.markAsRead(conversationId, userId);
        io.to(`conv:${conversationId}`).emit('messages_read', {
          conversationId,
          userId,
        });
      } catch {
        // ignore
      }
    });
  });
};
