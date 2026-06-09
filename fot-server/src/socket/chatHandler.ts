import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import * as Sentry from '@sentry/node';
import { env } from '../config/env.js';
import { chatService } from '../services/chat.service.js';
import { isChatError } from '../services/chat.errors.js';
import { dispatchChatMessage } from '../services/chat-delivery.service.js';
import { portalPresence } from '../services/portal-presence.service.js';
import type { JWTPayload } from '../types/index.js';

interface IAuthenticatedSocket extends Socket {
  userId?: string;
  employeeId?: number | null;
}

// Лимит одновременных сокетов на одного пользователя. Несколько вкладок и
// устройств — норма, поэтому 10 даёт запас. При превышении новые подключения
// отключаются — без этого фрагмент скомпрометированного фронта может открыть
// тысячи коннектов и положить процесс по дескрипторам.
const MAX_SOCKETS_PER_USER = Number(process.env.SOCKET_IO_MAX_PER_USER) || 10;

export const setupChatSocket = (io: Server) => {
  // JWT auth middleware
  io.use((socket: IAuthenticatedSocket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error('Authentication required'));
    }

    try {
      const decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }) as JWTPayload;
      if (!decoded.is_approved) {
        return next(new Error('Account not approved'));
      }
      socket.userId = decoded.sub;
      socket.employeeId = decoded.employee_id ?? null;
      const current = portalPresence.getCount(decoded.sub);
      if (current >= MAX_SOCKETS_PER_USER) {
        return next(new Error('Too many connections for this user'));
      }
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket: IAuthenticatedSocket) => {
    const userId = socket.userId!;
    const employeeId = socket.employeeId ?? null;

    // Онлайн-присутствие на портале: эмитим user_online только на переходе 0→1,
    // user_offline — на 1→0, чтобы несколько вкладок одного юзера не спамили.
    if (portalPresence.addConnection(userId, employeeId)) {
      portalPresence.emitOnline(userId, employeeId);
    }
    socket.on('disconnect', () => {
      if (portalPresence.removeConnection(userId)) {
        portalPresence.emitOffline(userId, employeeId);
      }
    });

    // Присоединяем к персональной комнате для получения уведомлений
    socket.join(`user:${userId}`);

    // Присоединение к диалогу
    socket.on('join_conversation', async (conversationId: string, callback?: (response: unknown) => void) => {
      try {
        await chatService.getConversationAccess(conversationId, userId);
        socket.join(`conv:${conversationId}`);
        if (callback) callback({ success: true });
      } catch (error) {
        if (!isChatError(error)) {
          Sentry.captureException(error, {
            tags: { socket_event: 'join_conversation' },
            user: { id: userId },
          });
        }
        if (callback) {
          callback({
            success: false,
            error: isChatError(error) ? error.message : 'Failed to join conversation',
            code: isChatError(error) ? error.code : 'CHAT_ACCESS_DENIED',
          });
        }
      }
    });

    // Выход из диалога
    socket.on('leave_conversation', (conversationId: string) => {
      socket.leave(`conv:${conversationId}`);
    });

    // Отправка сообщения
    socket.on('send_message', async (data: { conversationId: string; content: string }, callback?: (response: unknown) => void) => {
      try {
        const message = await chatService.sendMessage(data.conversationId, userId, data.content);

        // Emit в комнату диалога + персональные уведомления (общий код с REST-путём)
        await dispatchChatMessage(message, userId);

        if (callback) callback({ success: true, data: message });
      } catch (error) {
        if (!isChatError(error)) {
          Sentry.captureException(error, {
            tags: { socket_event: 'send_message' },
            user: { id: userId },
          });
        }
        if (callback) {
          callback({
            success: false,
            error: isChatError(error) ? error.message : 'Failed to send message',
            code: isChatError(error) ? error.code : 'CHAT_WRITE_FAILED',
          });
        }
      }
    });

    // Индикатор набора текста
    socket.on('typing', async (conversationId: string) => {
      try {
        const access = await chatService.getConversationAccess(conversationId, userId);
        if (!access.is_writable) return;

        socket.to(`conv:${conversationId}`).emit('user_typing', {
          conversationId,
          userId,
        });
      } catch {
        // ignore
      }
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
