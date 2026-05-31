import { Router } from 'express';
import { contractorAdminController } from '../controllers/contractor-admin.controller.js';
import { contractorPoolController } from '../controllers/contractor-pool.controller.js';
import { authenticate, requirePageAccess, requireCritical2FA } from '../middleware/auth.js';

const router = Router();

router.use(authenticate);

// Все админские роуты подрядчика теперь сидят за одной страницей доступа
// /admin/contractor-approvals (переименована в UI «Пропуск подрядчика»).
// Существующие /skud-card-reader-роуты сохраняются для обратной совместимости
// прямого режима выпуска (issuePassBatch), который остаётся.
const passEdit = requirePageAccess('/skud-card-reader', 'edit');
const usersView = requirePageAccess('/admin/users', 'view');
const usersEdit = requirePageAccess('/admin/users', 'edit');
const apprView = requirePageAccess('/admin/contractor-approvals', 'view');
const apprEdit = requirePageAccess('/admin/contractor-approvals', 'edit');

router.get('/orgs', apprView, contractorAdminController.listOrgs);

// Заявки на удаление сотрудников (подрядчик пометил → админ одобряет = увольнение).
router.get('/removals', apprView, contractorAdminController.listRemovals);
router.get('/removals/count', apprView, contractorAdminController.removalsCount);
router.post('/removals/:rosterId/approve', apprEdit, requireCritical2FA, contractorAdminController.approveRemoval);
router.get('/objects', apprView, contractorAdminController.listObjects);
router.get('/objects/access-points', apprView, contractorAdminController.listObjectAccessPoints);
router.get('/orgs/:orgId/next-pass', apprView, contractorAdminController.getNextPassNumber);
router.get('/orgs/:orgId/documents', apprView, contractorAdminController.getOrgDocuments);
router.get('/documents/:id/download', apprView, contractorAdminController.getOrgDocumentDownloadUrl);
router.post('/passes/issue', passEdit, requireCritical2FA, contractorAdminController.issuePassBatch);

router.get('/users', usersView, contractorAdminController.listContractorUsers);
router.get('/users/:id/org', usersView, contractorAdminController.getUserOrg);
router.put('/users/:id/org', usersEdit, contractorAdminController.replaceUserOrg);

// Заявки на согласование.
router.get('/sigur-access-points', apprView, contractorAdminController.listSigurAccessPoints);
router.get('/submissions/pending/count', apprView, contractorAdminController.getPendingSubmissionsCount);
router.get('/submissions/pending', apprView, contractorAdminController.getPendingSubmissions);
router.get('/submissions/:id/export', apprView, contractorAdminController.exportSubmission);
router.get('/submissions/:id', apprView, contractorAdminController.getSubmissionDetail);
router.post('/submissions/:id/approve', apprEdit, requireCritical2FA, contractorAdminController.approveSubmission);
router.post('/submissions/:id/reject', apprEdit, contractorAdminController.rejectSubmission);
router.post('/submissions/:id/decide', apprEdit, requireCritical2FA, contractorAdminController.decideSubmission);

// Отправленные / мониторинг / история по пропуску.
router.get('/passes/sent', apprView, contractorAdminController.listSentPasses);
router.get('/passes/monitor', apprView, contractorAdminController.monitorPasses);
router.get('/passes/sync-failed', apprView, contractorPoolController.syncFailed);
router.get('/passes/:id/history', apprView, contractorAdminController.getPassHistoryAdmin);
router.post('/passes/:id/revoke', apprEdit, requireCritical2FA, contractorPoolController.revokePass);
router.post('/passes/:id/retry-sync', apprEdit, contractorPoolController.retrySync);

// Общий пул свободных пропусков.
router.get('/pool/settings', apprView, contractorPoolController.getSettings);
router.put('/pool/settings', apprEdit, contractorPoolController.setSettings);
router.get('/sigur-departments', apprView, contractorPoolController.listSigurDepartments);
router.get('/pool', apprView, contractorPoolController.list);
router.get('/pool/free', apprView, contractorPoolController.free);
router.get('/pool/ranges', apprView, contractorPoolController.getRanges);
router.get('/pool/matrix', apprView, contractorPoolController.matrix);
router.get('/pool/next-number', apprView, contractorPoolController.getNextNumber);
router.post('/pool/issue', apprEdit, requireCritical2FA, contractorPoolController.issueToPool);
router.post('/pool/assign', apprEdit, requireCritical2FA, contractorPoolController.assign);
router.post('/pool/assign-count', apprEdit, requireCritical2FA, contractorPoolController.assignCount);

export default router;
