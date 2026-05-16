import { Router } from 'express';
import { contractorAdminController } from '../controllers/contractor-admin.controller.js';
import { authenticate, requirePageAccess, requireCritical2FA } from '../middleware/auth.js';

const router = Router();

router.use(authenticate);

const passView = requirePageAccess('/skud-card-reader', 'view');
const passEdit = requirePageAccess('/skud-card-reader', 'edit');
const usersView = requirePageAccess('/admin/users', 'view');
const usersEdit = requirePageAccess('/admin/users', 'edit');
const apprView = requirePageAccess('/admin/contractor-approvals', 'view');
const apprEdit = requirePageAccess('/admin/contractor-approvals', 'edit');

router.get('/orgs', passView, contractorAdminController.listOrgs);
router.post('/passes/issue', passEdit, requireCritical2FA, contractorAdminController.issuePassBatch);

router.get('/users', usersView, contractorAdminController.listContractorUsers);
router.get('/users/:id/org', usersView, contractorAdminController.getUserOrg);
router.put('/users/:id/org', usersEdit, contractorAdminController.replaceUserOrg);

router.get('/submissions/pending', apprView, contractorAdminController.getPendingSubmissions);
router.get('/submissions/:id', apprView, contractorAdminController.getSubmissionDetail);
router.post('/submissions/:id/approve', apprEdit, requireCritical2FA, contractorAdminController.approveSubmission);
router.post('/submissions/:id/reject', apprEdit, contractorAdminController.rejectSubmission);

export default router;
