import { Router } from 'express';
import { chatController } from '../controllers/chat.controller.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

router.use(authenticate);

router.get('/conversations', chatController.getConversations);
router.post('/conversations', chatController.createConversation);
router.get('/conversations/:id/messages', chatController.getMessages);
router.post('/conversations/:id/messages', chatController.sendMessage);
router.patch('/conversations/:id/read', chatController.markAsRead);
router.get('/unread-count', chatController.getUnreadCount);
router.get('/users/search', chatController.searchUsers);

export default router;
