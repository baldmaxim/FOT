import { Router } from 'express';
import { weekendApprovalsController } from '../controllers/weekend-approvals.controller.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';

const router = Router();

router.use(authenticate);
router.use(requireAdmin);

// Сотрудники-кандидаты (whitelist-отделы, подходящие роли) и «Свободные».
router.get('/eligible', weekendApprovalsController.listEligible);

// Назначения конкретного ответственного.
router.get('/:responsibleId', weekendApprovalsController.getByResponsible);
router.put('/:responsibleId', weekendApprovalsController.setByResponsible);

export default router;
