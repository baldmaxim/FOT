/**
 * Скоуп на мутациях по прямому id (миграция 262): ДС, КС-2, КС-6 и закрепления.
 * Проверяется проводка контроллера: чужой объект → 403 и сервис/аудит не вызваны;
 * нет записи → 404; свой объект → 200 и сервис вызван. Сами предикаты скоупа —
 * в object-kpi-scope.service.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  tx: vi.fn(),
  audit: vi.fn(),
  isObjectInScope: vi.fn(),
  canManage: vi.fn(),
  loadAddendumObject: vi.fn(),
  loadKs2Object: vi.fn(),
  loadKs6Object: vi.fn(),
  updateKs2Entry: vi.fn(),
  deleteAddendum: vi.fn(),
  setKs2Status: vi.fn(),
  updateKs6Entry: vi.fn(),
  updateAssignment: vi.fn(),
  deleteAssignment: vi.fn(),
  createAssignment: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: h.tx,
}));
vi.mock('../services/audit.service.js', () => ({
  AUDIT_ACTIONS: new Proxy({}, { get: (_t, key) => String(key) }),
  auditService: { logFromRequestWithClient: h.audit, log: vi.fn(), logFromRequest: vi.fn() },
}));
vi.mock('./object-kpi.controller.js', () => ({
  respondWithError: (res: { status: (c: number) => { json: (b: unknown) => void } }, error: unknown) => {
    const known = (error as { __save?: { http: number; message: string; code?: string } }).__save;
    if (known) {
      res.status(known.http).json({ success: false, error: known.message, code: known.code });
      return;
    }
    res.status(500).json({ success: false, error: String(error) });
  },
  resolveActorName: vi.fn(async () => 'Актор'),
}));
// Модуль скоупа мокается целиком: внутренние вызовы (assert → isObjectInScope) через ESM-моки
// не проходят, поэтому assert-хелперы собираются здесь из тех же моков-предикатов.
vi.mock('../services/object-kpi-scope.service.js', () => {
  const deny = (http: number, code: string, message: string) =>
    Object.assign(new Error(message), { __save: { http, code, message } });
  return {
    isObjectInScope: h.isObjectInScope,
    canManageObjectKpiAssignments: h.canManage,
    assertObjectInScopeOr403: async (req: unknown, objectId: string) => {
      if (!(await h.isObjectInScope(req, objectId))) throw deny(403, 'object_out_of_scope', 'Объект вне вашего доступа');
    },
    assertCanManageAssignmentsOr403: async (req: unknown) => {
      if (!(await h.canManage(req))) throw deny(403, 'assignments_forbidden', 'Управление закреплениями доступно администратору и руководителю экономического отдела');
    },
  };
});
vi.mock('../services/object-kpi-plan.service.js', () => ({ fixMonthPlan: vi.fn(), revisePlan: vi.fn() }));
vi.mock('../services/object-kpi-plan-freezer.service.js', () => ({ runPlanFreezerOnce: vi.fn() }));
vi.mock('../services/object-kpi.service.js', () => ({
  createAddendum: vi.fn(),
  createContract: vi.fn(),
  createKs2Entry: vi.fn(),
  deleteAddendum: h.deleteAddendum,
  deleteKs2Entry: vi.fn(),
  getContractById: vi.fn(),
  loadObjectIdForAddendum: h.loadAddendumObject,
  loadObjectIdForKs2: h.loadKs2Object,
  setAddendumStatus: vi.fn(),
  setKs2Status: h.setKs2Status,
  updateAddendum: vi.fn(),
  updateContract: vi.fn(),
  updateKs2Entry: h.updateKs2Entry,
}));
vi.mock('../services/object-kpi-assignments.service.js', () => ({
  createAssignment: h.createAssignment,
  createGlobalRole: vi.fn(),
  deleteAssignment: h.deleteAssignment,
  revokeGlobalRole: vi.fn(),
  updateAssignment: h.updateAssignment,
}));
vi.mock('../services/object-kpi-ks6.service.js', () => ({
  createKs6Entry: vi.fn(),
  deleteKs6Entry: vi.fn(),
  listKs6Entries: vi.fn(),
  loadObjectIdForKs6: h.loadKs6Object,
  setKs6Status: vi.fn(),
  updateKs6Entry: h.updateKs6Entry,
}));

import { objectKpiEntriesController } from './object-kpi-entries.controller.js';
import { objectKpiKs6Controller } from './object-kpi-ks6.controller.js';

const OWN = '11111111-1111-1111-1111-111111111111';
const FOREIGN = '22222222-2222-2222-2222-222222222222';
const ENTRY = '99999999-9999-9999-9999-999999999999';

const makeRes = () => {
  const out: { status?: number; body?: Record<string, unknown> } = {};
  const res = {
    status(code: number) { out.status = code; return res; },
    json(body: Record<string, unknown>) { out.body = body; out.status = out.status ?? 200; return res; },
  };
  return { res: res as never, out };
};

const req = (over: Record<string, unknown> = {}) => ({
  params: { id: ENTRY },
  body: { version: 1, amount: '100.00' },
  query: { version: '1' },
  user: { id: 'user-1', employee_id: 500, is_admin: false, role_code: 'economist' },
  ...over,
}) as never;

beforeEach(() => {
  vi.clearAllMocks();
  h.tx.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => fn({ query: vi.fn() }));
  h.audit.mockResolvedValue(undefined);
  // Скоуп экономиста — только OWN.
  h.isObjectInScope.mockImplementation(async (_req: unknown, objectId: string) => objectId === OWN);
  h.canManage.mockResolvedValue(false);
  h.updateKs2Entry.mockResolvedValue({ id: ENTRY, version: 2 });
  h.setKs2Status.mockResolvedValue({ id: ENTRY, version: 2 });
  h.deleteAddendum.mockResolvedValue(undefined);
  h.updateKs6Entry.mockResolvedValue({ id: ENTRY, version: 2 });
  h.updateAssignment.mockResolvedValue({ id: ENTRY, version: 2 });
});

describe('мутации ДС/КС-2/КС-6 по прямому id — скоуп', () => {
  it('updateKs2: свой объект → 200, сервис и аудит вызваны', async () => {
    h.loadKs2Object.mockResolvedValue(OWN);
    const { res, out } = makeRes();
    await objectKpiEntriesController.updateKs2(req(), res);

    expect(out.status).toBe(200);
    expect(h.updateKs2Entry).toHaveBeenCalledTimes(1);
    expect(h.audit).toHaveBeenCalledTimes(1);
  });

  it('updateKs2: чужой объект → 403, сервис и аудит НЕ вызваны', async () => {
    h.loadKs2Object.mockResolvedValue(FOREIGN);
    const { res, out } = makeRes();
    await objectKpiEntriesController.updateKs2(req(), res);

    expect(out.status).toBe(403);
    expect(out.body).toMatchObject({ error: 'Объект вне вашего доступа' });
    expect(h.updateKs2Entry).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.tx).not.toHaveBeenCalled();
  });

  it('updateKs2: записи нет → 404, сервис НЕ вызван', async () => {
    h.loadKs2Object.mockResolvedValue(null);
    const { res, out } = makeRes();
    await objectKpiEntriesController.updateKs2(req(), res);

    expect(out.status).toBe(404);
    expect(h.updateKs2Entry).not.toHaveBeenCalled();
  });

  it('signKs2 / cancelKs2: чужой объект → 403 до транзакции', async () => {
    h.loadKs2Object.mockResolvedValue(FOREIGN);
    const { res, out } = makeRes();
    await objectKpiEntriesController.signKs2(req(), res);
    expect(out.status).toBe(403);

    const second = makeRes();
    await objectKpiEntriesController.cancelKs2(req(), second.res);
    expect(second.out.status).toBe(403);
    expect(h.setKs2Status).not.toHaveBeenCalled();
  });

  it('deleteAddendum: чужой объект → 403; свой → 200', async () => {
    h.loadAddendumObject.mockResolvedValue(FOREIGN);
    const { res, out } = makeRes();
    await objectKpiEntriesController.deleteAddendum(req(), res);
    expect(out.status).toBe(403);
    expect(h.deleteAddendum).not.toHaveBeenCalled();

    h.loadAddendumObject.mockResolvedValue(OWN);
    const second = makeRes();
    await objectKpiEntriesController.deleteAddendum(req(), second.res);
    expect(second.out.status).toBe(200);
    expect(h.deleteAddendum).toHaveBeenCalledTimes(1);
  });

  it('updateKs6: чужой объект → 403; нет записи → 404; свой → 200', async () => {
    h.loadKs6Object.mockResolvedValue(FOREIGN);
    let r = makeRes();
    await objectKpiKs6Controller.updateKs6(req({ body: { version: 1, doc_number: 'КС-6/1' } }), r.res);
    expect(r.out.status).toBe(403);

    h.loadKs6Object.mockResolvedValue(null);
    r = makeRes();
    await objectKpiKs6Controller.updateKs6(req({ body: { version: 1, doc_number: 'КС-6/1' } }), r.res);
    expect(r.out.status).toBe(404);
    expect(h.updateKs6Entry).not.toHaveBeenCalled();

    h.loadKs6Object.mockResolvedValue(OWN);
    r = makeRes();
    await objectKpiKs6Controller.updateKs6(req({ body: { version: 1, doc_number: 'КС-6/1' } }), r.res);
    expect(r.out.status).toBe(200);
    expect(h.updateKs6Entry).toHaveBeenCalledTimes(1);
  });

  it('админ/неограниченный скоуп: свой и чужой объект проходят', async () => {
    h.isObjectInScope.mockResolvedValue(true);
    h.loadKs2Object.mockResolvedValue(FOREIGN);
    const { res, out } = makeRes();
    await objectKpiEntriesController.updateKs2(req({ user: { id: 'a', employee_id: null, is_admin: true, role_code: 'admin' } }), res);
    expect(out.status).toBe(200);
  });
});

describe('закрепления — только админ и руководитель эк. отдела', () => {
  const assignmentBody = {
    skud_object_id: OWN,
    employee_id: 7,
    role_kind: 'object_economist',
    valid_from: '2026-09-01',
  };

  it('createAssignment: экономист (даже на свой объект) → 403, сервис не вызван', async () => {
    const { res, out } = makeRes();
    await objectKpiEntriesController.createAssignment(req({ body: assignmentBody }), res);

    expect(out.status).toBe(403);
    expect(out.body).toMatchObject({ code: 'assignments_forbidden' });
    expect(h.createAssignment).not.toHaveBeenCalled();
    expect(h.isObjectInScope).not.toHaveBeenCalled();
  });

  it('updateAssignment / deleteAssignment: экономист → 403', async () => {
    let r = makeRes();
    await objectKpiEntriesController.updateAssignment(req({ body: { version: 1, valid_to: '2026-12-31' } }), r.res);
    expect(r.out.status).toBe(403);
    expect(h.updateAssignment).not.toHaveBeenCalled();

    r = makeRes();
    await objectKpiEntriesController.deleteAssignment(req(), r.res);
    expect(r.out.status).toBe(403);
    expect(h.deleteAssignment).not.toHaveBeenCalled();
  });

  it('руководитель эк. отдела / админ: закрепление создаётся (в пределах скоупа)', async () => {
    h.canManage.mockResolvedValue(true);
    h.createAssignment.mockResolvedValue({ id: ENTRY, ...assignmentBody });
    const { res, out } = makeRes();
    await objectKpiEntriesController.createAssignment(req({ body: assignmentBody }), res);

    expect(out.status).toBe(201);
    expect(h.createAssignment).toHaveBeenCalledTimes(1);
  });
});
