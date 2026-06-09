import { Response } from 'express';
import { z } from 'zod';
import { chatService, type IChatAttachment } from '../services/chat.service.js';
import { dispatchChatMessage } from '../services/chat-delivery.service.js';
import { isChatError } from '../services/chat.errors.js';
import { r2Service } from '../services/r2.service.js';
import { sanitizeFileName } from '../utils/file-validation.utils.js';
import { decodeMulterFilename } from '../utils/multer-filename.utils.js';
import type { AuthenticatedRequest } from '../types/index.js';

type MulterRequest = AuthenticatedRequest & { file?: Express.Multer.File };

const createConversationSchema = z.object({
  participantId: z.string().uuid(),
});

const sendMessageSchema = z.object({
  content: z.string().min(1).max(5000),
});

const createRequestSchema = z.object({
  targetUserId: z.string().uuid(),
  message: z.string().trim().max(1000).optional().nullable(),
});

const requestsQuerySchema = z.object({
  box: z.enum(['inbox', 'outbox']).default('inbox'),
});

const respondWithChatError = (res: Response, error: unknown, fallbackMessage: string): void => {
  if (error instanceof z.ZodError) {
    res.status(400).json({ success: false, error: error.errors[0].message });
    return;
  }

  if (isChatError(error)) {
    res.status(error.status).json({ success: false, error: error.message, code: error.code });
    return;
  }

  console.error(fallbackMessage, error);
  res.status(500).json({ success: false, error: fallbackMessage });
};

export const chatController = {
  /**
   * GET /api/chat/conversations
   */
  async getConversations(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const conversations = await chatService.getConversations(req.user.id);
      res.json({ success: true, data: conversations });
    } catch (error) {
      respondWithChatError(res, error, 'Failed to fetch conversations');
    }
  },

  /**
   * POST /api/chat/conversations
   * Body: { participantId: string }
   */
  async createConversation(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { participantId } = createConversationSchema.parse(req.body);

      if (participantId === req.user.id) {
        res.status(400).json({ success: false, error: 'Cannot create conversation with yourself' });
        return;
      }

      const conversationId = await chatService.getOrCreateConversation(req.user.id, participantId);
      res.json({ success: true, data: { id: conversationId } });
    } catch (error) {
      respondWithChatError(res, error, 'Failed to create conversation');
    }
  },

  /**
   * GET /api/chat/conversations/:id/messages
   */
  async getMessages(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
      const offset = parseInt(req.query.offset as string) || 0;

      const messages = await chatService.getMessages(id, req.user.id, limit, offset);
      res.json({ success: true, data: messages });
    } catch (error) {
      respondWithChatError(res, error, 'Failed to fetch messages');
    }
  },

  /**
   * POST /api/chat/conversations/:id/messages
   * Текст: JSON { content }. С файлом: multipart (file + опц. content).
   * Сообщения с файлом всегда идут через REST; emit делаем здесь же.
   */
  async sendMessage(req: MulterRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const file = req.file;

      // Без файла — прежний контракт (валидация content 1..5000).
      if (!file) {
        const { content } = sendMessageSchema.parse(req.body);
        const message = await chatService.sendMessage(id, req.user.id, content);
        res.json({ success: true, data: message });
        return;
      }

      // С файлом: content опционален (0..5000).
      const content = typeof req.body.content === 'string' ? req.body.content : '';
      if (content.length > 5000) {
        res.status(400).json({ success: false, error: 'Сообщение слишком длинное' });
        return;
      }
      if (!(await r2Service.isEnabledAsync())) {
        res.status(503).json({ success: false, error: 'Файловое хранилище не настроено' });
        return;
      }

      const safeName = sanitizeFileName(decodeMulterFilename(file.originalname));
      const mime = file.mimetype || 'application/octet-stream';
      const key = r2Service.generateChatKey(id, safeName);
      await r2Service.uploadObject(key, file.buffer, mime);

      const attachment: IChatAttachment = { key, name: safeName, size: file.size, mime };

      let message;
      try {
        message = await chatService.sendMessage(id, req.user.id, content, attachment);
      } catch (err) {
        try { await r2Service.deleteObject(key); } catch { /* best-effort */ }
        throw err;
      }

      await dispatchChatMessage(message, req.user.id);
      res.json({ success: true, data: message });
    } catch (error) {
      respondWithChatError(res, error, 'Failed to send message');
    }
  },

  /**
   * PATCH /api/chat/conversations/:id/read
   */
  async markAsRead(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      await chatService.markAsRead(id, req.user.id);
      res.json({ success: true });
    } catch (error) {
      respondWithChatError(res, error, 'Failed to mark as read');
    }
  },

  /**
   * GET /api/chat/unread-count
   */
  async getUnreadCount(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const count = await chatService.getUnreadCount(req.user.id);
      res.json({ success: true, data: { count } });
    } catch (error) {
      respondWithChatError(res, error, 'Failed to get unread count');
    }
  },

  /**
   * GET /api/chat/users/search?q=...
   */
  async searchUsers(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const q = (req.query.q as string || '').trim();

      const users = await chatService.searchUsers(q, req.user.id);
      res.json({ success: true, data: users });
    } catch (error) {
      respondWithChatError(res, error, 'Failed to search users');
    }
  },

  async getRequests(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { box } = requestsQuerySchema.parse(req.query);
      const requests = await chatService.listContactRequests(req.user.id, box);
      res.json({ success: true, data: requests });
    } catch (error) {
      respondWithChatError(res, error, 'Failed to fetch contact requests');
    }
  },

  async createRequest(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { targetUserId, message } = createRequestSchema.parse(req.body);
      const request = await chatService.createContactRequest(req.user.id, targetUserId, message);
      res.status(201).json({ success: true, data: request });
    } catch (error) {
      respondWithChatError(res, error, 'Failed to create contact request');
    }
  },

  async approveRequest(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const result = await chatService.approveContactRequest(id, req.user.id);
      res.json({ success: true, data: result });
    } catch (error) {
      respondWithChatError(res, error, 'Failed to approve contact request');
    }
  },

  async rejectRequest(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const request = await chatService.rejectContactRequest(id, req.user.id);
      res.json({ success: true, data: request });
    } catch (error) {
      respondWithChatError(res, error, 'Failed to reject contact request');
    }
  },
};
