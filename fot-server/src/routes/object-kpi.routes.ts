import { Router } from 'express';

import { authenticate, requireAdmin, requireAnyPageAccess, requirePageAccess } from '../middleware/auth.js';
import { noStore } from '../middleware/noStore.js';
import { objectKpiController } from '../controllers/object-kpi.controller.js';
import { objectKpiEntriesController } from '../controllers/object-kpi-entries.controller.js';
import { objectKpiKs6Controller } from '../controllers/object-kpi-ks6.controller.js';

const router = Router();

router.use(authenticate);

// no-store на весь модуль: глобальный дефолт `private, max-age=30` (app.ts) держал у
// браузера прошлый ответ, и удалённое закрепление «оживало» в модалке до перезагрузки.
// Денежные данные из кэша отдавать нечего — они меняются мутацией на соседнем экране.
router.use(noStore);

// Гарды именованными алиасами — их распознаёт `npm run audit:routes`.
// Вкладка «KPI объектов» (ввод и отчёт) и раздел ЛК «Мои объекты» (только чтение)
// разведены разными ключами: руководителю строительства чужие проценты не показываем.
const kpiView = requirePageAccess('/discipline/objects', 'view');
const kpiEdit = requirePageAccess('/discipline/objects', 'edit');
const reportView = requireAnyPageAccess(['/discipline/objects', '/employee/objects'], 'view');
const lkView = requirePageAccess('/employee/objects', 'view');

// ─── Чтение ──────────────────────────────────────────────────────────────────
// Статические пути объявлены до параметрических: иначе '/objects/:objectId/card'
// перехватил бы '/report/headcount' и подобные.
router.get('/report', reportView, objectKpiController.getReport);
router.get('/report/summary', reportView, objectKpiController.getReportSummary);
// Премия — только для вкладки экономиста: в ЛК руководителя своя ветка /my/objects.
router.get('/report/premium', kpiView, objectKpiController.getReportPremium);
router.get('/report/headcount', reportView, objectKpiController.getHeadcount);
router.get('/plans/fixation-info', reportView, objectKpiController.getFixationInfo);
router.get('/my/objects', lkView, objectKpiController.getMyObjects);
router.get('/assignments', kpiView, objectKpiController.listAssignments);
router.get('/employees/search', kpiEdit, objectKpiController.searchEmployees);
router.get('/global-roles', kpiView, objectKpiController.listGlobalRoles);
router.get('/objects', kpiView, objectKpiController.listObjects);
router.get('/objects/:objectId/card', reportView, objectKpiController.getObjectCard);
router.get('/objects/:objectId/plans', kpiView, objectKpiController.listPlans);
router.get('/objects/:objectId/history', kpiView, objectKpiController.getHistory);

// ─── Договор ─────────────────────────────────────────────────────────────────
router.post('/objects/:objectId/contract', kpiEdit, objectKpiEntriesController.createContract);
router.patch('/contracts/:id', kpiEdit, objectKpiEntriesController.updateContract);

// ─── Допсоглашения ───────────────────────────────────────────────────────────
router.post('/contracts/:id/addenda', kpiEdit, objectKpiEntriesController.createAddendum);
router.patch('/addenda/:id', kpiEdit, objectKpiEntriesController.updateAddendum);
router.post('/addenda/:id/sign', kpiEdit, objectKpiEntriesController.signAddendum);
router.post('/addenda/:id/cancel', kpiEdit, objectKpiEntriesController.cancelAddendum);
router.delete('/addenda/:id', kpiEdit, objectKpiEntriesController.deleteAddendum);

// ─── Акты КС-2 ───────────────────────────────────────────────────────────────
router.post('/contracts/:id/ks2', kpiEdit, objectKpiEntriesController.createKs2);
router.patch('/ks2/:id', kpiEdit, objectKpiEntriesController.updateKs2);
router.post('/ks2/:id/sign', kpiEdit, objectKpiEntriesController.signKs2);
router.post('/ks2/:id/cancel', kpiEdit, objectKpiEntriesController.cancelKs2);
router.delete('/ks2/:id', kpiEdit, objectKpiEntriesController.deleteKs2);

// ─── Записи КС-6 (справочные, в расчёт KPI не входят) ────────────────────────
// GET под kpiView, а не reportView: в ЛК руководителя реестра КС-6 нет.
router.get('/contracts/:id/ks6', kpiView, objectKpiKs6Controller.listKs6);
router.post('/contracts/:id/ks6', kpiEdit, objectKpiKs6Controller.createKs6);
router.patch('/ks6/:id', kpiEdit, objectKpiKs6Controller.updateKs6);
router.post('/ks6/:id/sign', kpiEdit, objectKpiKs6Controller.signKs6);
router.post('/ks6/:id/cancel', kpiEdit, objectKpiKs6Controller.cancelKs6);
router.delete('/ks6/:id', kpiEdit, objectKpiKs6Controller.deleteKs6);

// ─── План месяца ─────────────────────────────────────────────────────────────
router.post('/objects/:objectId/plans/:periodMonth/fix', kpiEdit, objectKpiEntriesController.fixPlan);
// Пересмотр закрытого месяца: гард страницы пропускает экономиста, а право
// «руководитель эк. отдела / админ» перепроверяется в БД внутри транзакции.
router.patch('/objects/:objectId/plans/:periodMonth', kpiEdit, objectKpiEntriesController.revisePlan);
router.post('/freezer/run', requireAdmin, objectKpiEntriesController.runFreezer);

// ─── Закрепления ─────────────────────────────────────────────────────────────
router.post('/assignments', kpiEdit, objectKpiEntriesController.createAssignment);
router.patch('/assignments/:id', kpiEdit, objectKpiEntriesController.updateAssignment);
router.delete('/assignments/:id', kpiEdit, objectKpiEntriesController.deleteAssignment);

// ─── Глобальные роли ─────────────────────────────────────────────────────────
// requireAdmin, а не kpiEdit: иначе экономист выдал бы сам себе право пересматривать
// зафиксированные месяцы.
router.post('/global-roles', requireAdmin, objectKpiEntriesController.createGlobalRole);
router.delete('/global-roles/:id', requireAdmin, objectKpiEntriesController.revokeGlobalRole);

export default router;
