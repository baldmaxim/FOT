import { Router } from 'express';
import { weekendApprovalsController } from '../controllers/weekend-approvals.controller.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { noStore } from '../middleware/noStore.js';

const router = Router();

router.use(authenticate);
router.use(requireAdmin);

// Сотрудники-кандидаты (whitelist-отделы, подходящие роли) и «Свободные».
router.get('/eligible', noStore, weekendApprovalsController.listEligible);

// Назначения конкретного ответственного.
router.get('/:responsibleId', noStore, weekendApprovalsController.getByResponsible);
router.put('/:responsibleId', weekendApprovalsController.setByResponsible);

export default router;
