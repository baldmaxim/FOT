import { Router } from 'express';
import { chatController } from '../controllers/chat.controller.js';
import { authenticate, requireAnyPageAccess } from '../middleware/auth.js';

const router = Router();

router.use(authenticate);
// Чат доступен любому пользователю, у которого есть «осмысленная» страница
// (личный кабинет работника или дашборд). Это отсекает «висящие» роли без
// активного UI и блокирует прямой доступ к API в обход фронта.
router.use(requireAnyPageAccess(['/employee', '/dashboard'], 'view'));

router.get('/conversations', chatController.getConversations);
router.post('/conversations', chatController.createConversation);
router.get('/conversations/:id/messages', chatController.getMessages);
router.post('/conversations/:id/messages', chatController.sendMessage);
router.patch('/conversations/:id/read', chatController.markAsRead);
router.get('/requests', chatController.getRequests);
router.post('/requests', chatController.createRequest);
router.patch('/requests/:id/approve', chatController.approveRequest);
router.patch('/requests/:id/reject', chatController.rejectRequest);
router.get('/unread-count', chatController.getUnreadCount);
router.get('/users/search', chatController.searchUsers);

export default router;
