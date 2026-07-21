import { Router } from 'express';
import { adaptiveTestingController } from '../controllers/adaptive-testing.controller.js';
import { authenticate, requirePageAccess } from '../middleware/auth.js';
import { adaptiveTestingLimiter, adaptiveHealthcheckLimiter } from '../middleware/rateLimit.js';

const router = Router();

router.use(authenticate);

const EMPLOYEE = '/employee/testing';
const REVIEW = '/testing-review';
const SETTINGS = '/admin/settings';

// ---- Сотрудник (GET — view; мутации — edit + rate limit) ----
router.get('/availability', requirePageAccess(EMPLOYEE, 'view'), adaptiveTestingController.getAvailability);
router.post('/sessions', requirePageAccess(EMPLOYEE, 'edit'), adaptiveTestingLimiter, adaptiveTestingController.startSession);
router.get('/sessions/current', requirePageAccess(EMPLOYEE, 'view'), adaptiveTestingController.getCurrent);
router.post('/sessions/current/retry', requirePageAccess(EMPLOYEE, 'edit'), adaptiveTestingLimiter, adaptiveTestingController.retrySession);
router.post('/sessions/current/cancel', requirePageAccess(EMPLOYEE, 'edit'), adaptiveTestingLimiter, adaptiveTestingController.cancelSession);
router.post('/sessions/:sessionId/answer', requirePageAccess(EMPLOYEE, 'edit'), adaptiveTestingLimiter, adaptiveTestingController.submitAnswer);
// Ключ отдаётся только по уже отвеченному вопросу — гейт в сервисе.
router.get('/sessions/:sessionId/questions/:questionId/reveal', requirePageAccess(EMPLOYEE, 'view'), adaptiveTestingController.getAnswerReveal);
router.get('/results/my', requirePageAccess(EMPLOYEE, 'view'), adaptiveTestingController.listMyResults);
router.get('/results/my/:sessionId', requirePageAccess(EMPLOYEE, 'view'), adaptiveTestingController.getMyResultDetail);

// ---- Руководитель / админ (данные сужаются data-scope в контроллере) ----
router.get('/results', requirePageAccess(REVIEW, 'view'), adaptiveTestingController.listResults);
router.get('/results/:sessionId', requirePageAccess(REVIEW, 'view'), adaptiveTestingController.getResultDetail);
router.get('/coverage', requirePageAccess(REVIEW, 'edit'), adaptiveTestingController.getCoverage);

// ---- Skill-профили (только админ: edit на /testing-review) ----
router.get('/skill-profiles', requirePageAccess(REVIEW, 'edit'), adaptiveTestingController.listProfiles);
router.post('/skill-profiles', requirePageAccess(REVIEW, 'edit'), adaptiveTestingController.createProfile);
router.put('/skill-profiles/:profileId', requirePageAccess(REVIEW, 'edit'), adaptiveTestingController.updateProfile);

// ---- Настройки LLM (страница «Система») ----
router.get('/settings', requirePageAccess(SETTINGS, 'view'), adaptiveTestingController.getSettings);
router.put('/settings', requirePageAccess(SETTINGS, 'edit'), adaptiveTestingController.putSettings);
router.post('/settings/health-check', requirePageAccess(SETTINGS, 'edit'), adaptiveHealthcheckLimiter, adaptiveTestingController.healthCheck);

export default router;
