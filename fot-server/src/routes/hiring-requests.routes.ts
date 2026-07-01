import { Router } from 'express';
import multer from 'multer';
import { hiringRequestsController as c } from '../controllers/hiring-requests.controller.js';
import { authenticate, requirePageAccess } from '../middleware/auth.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.use(authenticate);
// Доступ к вкладке: роль ∨ авто-доступ (рекрутер/руководитель отдела кадров/ответственный).
// Тонкие права (manage/work/author) проверяются в контроллере.
const guard = requirePageAccess('/staff-control/hiring', 'view');

// --- Статические пути ДО /:id ---
router.get('/recruiters', guard, c.listRecruiters);
router.post('/recruiters', guard, c.addRecruiter);
router.delete('/recruiters/:employeeId', guard, c.removeRecruiter);
router.get('/analytics', guard, c.analytics);

// --- Заявки ---
router.get('/', guard, c.list);
router.post('/', guard, c.create);
router.get('/:id', guard, c.getById);
router.patch('/:id', guard, c.updateFields);
router.patch('/:id/stage', guard, c.changeStage);
router.post('/:id/reject', guard, c.reject);
router.post('/:id/resubmit', guard, c.resubmit);
router.patch('/:id/urgent', guard, c.setUrgent);
router.post('/:id/finalize-selection', guard, c.finalizeSelection);
router.post('/:id/unfinalize', guard, c.unfinalize);

// --- Ответственные ---
router.get('/:id/assignees', guard, c.listAssignees);
router.post('/:id/assignees', guard, c.addAssignee);
router.patch('/:id/assignees/:employeeId/primary', guard, c.setPrimaryAssignee);
router.delete('/:id/assignees/:employeeId', guard, c.removeAssignee);

// --- Кандидаты (approve/verdict до :cid) ---
router.post('/:id/candidates', guard, c.addCandidate);
router.patch('/:id/candidates/:cid/approve', guard, c.approveCandidate);
router.patch('/:id/candidates/:cid/verdict', guard, c.verdictCandidate);
router.patch('/:id/candidates/:cid', guard, c.updateCandidate);
router.delete('/:id/candidates/:cid', guard, c.deleteCandidate);

// --- Комментарии / ссылки / файлы ---
router.post('/:id/comment', guard, c.addComment);
router.post('/:id/link', guard, c.addLink);
router.post('/:id/files', guard, upload.single('file'), c.uploadFile);
router.get('/:id/files/:fileId/download', guard, c.downloadFile);
router.delete('/:id/files/:fileId', guard, c.deleteFile);

export default router;
