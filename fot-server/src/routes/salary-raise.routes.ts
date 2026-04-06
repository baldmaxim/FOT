import { Router } from 'express';
import { salaryRaiseController } from '../controllers/salary-raise.controller.js';
import { authenticate, requireMinPosition } from '../middleware/auth.js';

const router = Router();

router.use(authenticate);

// POST /api/salary-raise — создать заявку (worker+)
router.post('/', requireMinPosition('worker'), salaryRaiseController.create);

// GET /api/salary-raise/my — мои заявки (worker+)
router.get('/my', requireMinPosition('worker'), salaryRaiseController.getMy);

// GET /api/salary-raise/pending — на рассмотрении (header+)
router.get('/pending', requireMinPosition('header'), salaryRaiseController.getPending);

// GET /api/salary-raise — все заявки (hr+)
router.get('/', requireMinPosition('hr'), salaryRaiseController.getAll);

// GET /api/salary-raise/:id — одна заявка (worker+)
router.get('/:id', requireMinPosition('worker'), salaryRaiseController.getById);

// PUT /api/salary-raise/:id — обновить черновик (worker+)
router.put('/:id', requireMinPosition('worker'), salaryRaiseController.update);

// PATCH /api/salary-raise/:id/submit — отправить (worker+)
router.patch('/:id/submit', requireMinPosition('worker'), salaryRaiseController.submit);

// PATCH /api/salary-raise/:id/cancel — отменить (worker+)
router.patch('/:id/cancel', requireMinPosition('worker'), salaryRaiseController.cancel);

// PATCH /api/salary-raise/:id/supervisor-review — рецензия руководителя (header+)
router.patch('/:id/supervisor-review', requireMinPosition('header'), salaryRaiseController.supervisorReview);

// PATCH /api/salary-raise/:id/hr-review — рецензия HR (hr+)
router.patch('/:id/hr-review', requireMinPosition('hr'), salaryRaiseController.hrReview);

// PATCH /api/salary-raise/:id/finance-review — рецензия финансов (admin+)
router.patch('/:id/finance-review', requireMinPosition('admin'), salaryRaiseController.financeReview);

// POST /api/salary-raise/:id/upload-url — presigned URL для загрузки (worker+)
router.post('/:id/upload-url', requireMinPosition('worker'), salaryRaiseController.getUploadUrl);

// POST /api/salary-raise/:id/attachments — подтвердить загрузку (worker+)
router.post('/:id/attachments', requireMinPosition('worker'), salaryRaiseController.confirmAttachment);

// GET /api/salary-raise/:id/attachments — список вложений (worker+)
router.get('/:id/attachments', requireMinPosition('worker'), salaryRaiseController.getAttachments);

// DELETE /api/salary-raise/:id/attachments/:aid — удалить вложение (worker+)
router.delete('/:id/attachments/:aid', requireMinPosition('worker'), salaryRaiseController.deleteAttachment);

export default router;
