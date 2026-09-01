import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  queryOne: vi.fn(),
  query: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
  resolveCompanyScope: vi.fn(),
  hasPageView: vi.fn(),
  hasPageEdit: vi.fn(),
  logFromRequest: vi.fn(),
  isDryRun: vi.fn(),
  bgConn: vi.fn(),
  delEmp: vi.fn(),
  updEmp: vi.fn(),
  createEmp: vi.fn(),
  assignCard: vi.fn(),
  replaceAP: vi.fn(),
  resolveAP: vi.fn(),
  enqueueRevoke: vi.fn(),
  applyDismissal: vi.fn(),
  insertDismissalHistory: vi.fn(),
  loadLifecycle: vi.fn(),
  empCacheInvalidate: vi.fn(),
  getContractorRootId: vi.fn(),
  createInductedPerson: vi.fn(),
  updateInductedPerson: vi.fn(),
  archiveInductedPerson: vi.fn(),
  listInductedByOrg: vi.fn(),
  listAllInducted: vi.fn(),
  countInductionByOrg: vi.fn(),
  getContractorOrgs: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  queryOne: h.queryOne,
  query: h.query,
  execute: h.execute,
  withTransaction: h.withTransaction,
}));
vi.mock('../services/data-scope.service.js', () => ({ resolveCompanyScope: h.resolveCompanyScope }));
vi.mock('../services/access-control.service.js', () => ({
  hasPageView: h.hasPageView,
  hasPageEdit: h.hasPageEdit,
}));
vi.mock('../services/audit.service.js', () => ({
  auditService: { logFromRequest: h.logFromRequest },
  AUDIT_ACTIONS: {
    CONTRACTOR_SUBMISSION_APPROVED: 'CONTRACTOR_SUBMISSION_APPROVED',
    CONTRACTOR_SUBMISSION_REJECTED: 'CONTRACTOR_SUBMISSION_REJECTED',
    CONTRACTOR_SUBMISSION_PASS_DECIDED: 'CONTRACTOR_SUBMISSION_PASS_DECIDED',
    CONTRACTOR_INDUCTION_CHANGED: 'CONTRACTOR_INDUCTION_CHANGED',
    CONTRACTOR_OT_TRAINING_CHANGED: 'CONTRACTOR_OT_TRAINING_CHANGED',
    CONTRACTOR_OT_PERSON_ARCHIVED: 'CONTRACTOR_OT_PERSON_ARCHIVED',
    CONTRACTOR_PASS_HOLDER_CHANGED: 'CONTRACTOR_PASS_HOLDER_CHANGED',
    CONTRACTOR_PASS_DOCUMENTS_UPDATED: 'CONTRACTOR_PASS_DOCUMENTS_UPDATED',
  },
}));
vi.mock('../services/contractor-induction.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/contractor-induction.service.js')>()),
  createInductedPerson: h.createInductedPerson,
  updateInductedPerson: h.updateInductedPerson,
  archiveInductedPerson: h.archiveInductedPerson,
  listInductedByOrg: h.listInductedByOrg,
  listAllInducted: h.listAllInducted,
  countInductionByOrg: h.countInductionByOrg,
}));
vi.mock('../config/contractor.js', () => ({
  isContractorSigurDryRun: h.isDryRun,
  getContractorRootId: h.getContractorRootId,
  CONTRACTOR_ROOT_NAME: 'подрядные организации',
}));
vi.mock('../services/sigur.service.js', () => ({ sigurService: { getBackgroundConnectionType: h.bgConn } }));
vi.mock('../services/sigur-live-employees-crud.service.js', () => ({
  deleteSigurEmployee: h.delEmp,
  updateSigurEmployee: h.updEmp,
  createSigurEmployee: h.createEmp,
}));
vi.mock('../services/sigur-live-cards.service.js', async () => ({
  assignSigurEmployeeCardBinding: h.assignCard,
  replaceSigurEmployeeAccessPoints: h.replaceAP,
  // Реальная утилита: статистика пропусков декодирует W26 из card_uid.
  deriveCardW26: (await import('../services/sigur-card-w26.util.js')).deriveCardW26,
}));
vi.mock('../services/contractor-access.service.js', () => ({
  resolveAccessPointNamesToIds: h.resolveAP,
}));
vi.mock('../services/contractor-scope.service.js', () => ({
  getContractorOrgs: h.getContractorOrgs,
  getOrgSigurDepartmentId: vi.fn(),
  getContractorUserIdsForOrg: vi.fn().mockResolvedValue([]),
  ContractorScopeError: class extends Error {
    constructor(public status: number, message: string) { super(message); }
  },
}));
vi.mock('../services/notification.service.js', () => ({
  notificationService: { createMany: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../services/push.service.js', () => ({
  pushService: { sendGenericNotification: vi.fn().mockResolvedValue([]) },
}));
vi.mock('../services/contractor-pool.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/contractor-pool.service.js')>()),
  enqueueRevoke: h.enqueueRevoke,
}));
vi.mock('./employee-lifecycle.controller.js', () => ({
  applyDismissalImmediately: h.applyDismissal,
  insertDismissalHistory: h.insertDismissalHistory,
  loadEmployeeLifecycleRow: h.loadLifecycle,
  getHttpErrorStatus: () => undefined,
  getHttpErrorCode: () => undefined,
  getErrorMessage: (_e: unknown, fallback: string) => fallback,
}));
vi.mock('../services/employee-cache.service.js', () => ({
  employeeCache: { invalidate: h.empCacheInvalidate },
}));

import { contractorAdminController } from './contractor-admin.controller.js';

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status: vi.fn(function (this: { statusCode: number }, c: number) { this.statusCode = c; return res; }),
    json: vi.fn(function (this: { body: unknown }, b: unknown) { this.body = b; return res; }),
  };
  return res;
};
const makeReq = () => ({
  user: { id: 'admin-1', company_scope: { roots: 'all' } },
  params: { id: 'sub-1' },
  ip: '127.0.0.1',
  headers: {},
  socket: {},
}) as never;

describe('contractorAdminController.approveSubmission', () => {
  beforeEach(() => {
    Object.values(h).forEach(fn => fn.mockReset());
    h.resolveCompanyScope.mockResolvedValue({ roots: 'all' });
    h.bgConn.mockResolvedValue('external');
    h.isDryRun.mockReturnValue(false);
    h.execute.mockResolvedValue(1);
    h.logFromRequest.mockResolvedValue(undefined);
    h.assignCard.mockResolvedValue({ card: { cardId: 10 }, previousSigurEmployeeId: null, reassigned: false });
    // withTransaction(fn) → выполняет fn с фейковым client.
    h.withTransaction.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) =>
      fn({ query: vi.fn().mockResolvedValue({ rows: [] }) }),
    );
  });

  it('409 если заявка уже обработана', async () => {
    h.queryOne.mockResolvedValueOnce({ id: 'sub-1', status: 'approved' });
    const res = makeRes();
    await contractorAdminController.approveSubmission(makeReq(), res as never);
    expect(res.statusCode).toBe(409);
  });

  it('порядок: удаление → переименование; успех → approved', async () => {
    h.queryOne.mockResolvedValueOnce({ id: 'sub-1', status: 'pending' });
    h.query.mockResolvedValueOnce([]); // induction pre-check: все прошли инструктаж
    // toRemove
    h.query.mockResolvedValueOnce([{ id: 'r-rm', sigur_employee_id: 100 }]);
    // toRename
    h.query.mockResolvedValueOnce([
      { pass_id: 'p1', pass_status: 'assigned', pass_sigur_id: 11, holder_name: 'Иванов И.', access_point_names: null, card_uid: '168,15956' },
    ]);
    const res = makeRes();
    await contractorAdminController.approveSubmission(makeReq(), res as never);

    expect(h.delEmp).toHaveBeenCalledWith(100, 'external');
    expect(h.updEmp).toHaveBeenCalledWith(11, { name: 'Иванов И.', blocked: false }, 'external');
    // delete вызван раньше rename
    expect(h.delEmp.mock.invocationCallOrder[0]).toBeLessThan(h.updEmp.mock.invocationCallOrder[0]);
    const body = res.body as { data: { status: string; applied: number } };
    expect(body.data.status).toBe('approved');
    expect(body.data.applied).toBe(2);
  });

  it('частичный сбой rename → partially_applied + apply_error', async () => {
    h.queryOne.mockResolvedValueOnce({ id: 'sub-1', status: 'pending' });
    h.query.mockResolvedValueOnce([]); // induction pre-check: все прошли инструктаж
    h.query.mockResolvedValueOnce([]); // нет удалений
    h.query.mockResolvedValueOnce([
      { pass_id: 'p1', pass_status: 'assigned', pass_sigur_id: 11, holder_name: 'A', access_point_names: null, card_uid: '168,15956' },
      { pass_id: 'p2', pass_status: 'assigned', pass_sigur_id: 12, holder_name: 'B', access_point_names: null, card_uid: '168,15956' },
    ]);
    h.updEmp.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Sigur 500'));
    const res = makeRes();
    await contractorAdminController.approveSubmission(makeReq(), res as never);

    const body = res.body as { data: { status: string; applied: number; failed: number; errors: string[] } };
    expect(body.data.status).toBe('partially_applied');
    expect(body.data.applied).toBe(1);
    expect(body.data.failed).toBe(1);
    expect(body.data.errors[0]).toContain('p2');
    // submission UPDATE получил partially_applied + текст ошибки
    const finalUpd = h.execute.mock.calls.find(c => String(c[0]).includes('UPDATE contractor_submissions'));
    expect(finalUpd?.[1]?.[0]).toBe('partially_applied');
    expect(String(finalUpd?.[1]?.[2])).toContain('Sigur 500');
  });

  it('идемпотентность: pass уже applied → пропускается (updateSigurEmployee не зовётся)', async () => {
    h.queryOne.mockResolvedValueOnce({ id: 'sub-1', status: 'partially_applied' });
    h.query.mockResolvedValueOnce([]); // induction pre-check: все прошли инструктаж
    h.query.mockResolvedValueOnce([]);
    h.query.mockResolvedValueOnce([
      { pass_id: 'p1', pass_status: 'applied', pass_sigur_id: 11, holder_name: 'A', access_point_names: null, card_uid: '168,15956' },
      { pass_id: 'p2', pass_status: 'assigned', pass_sigur_id: 12, holder_name: 'B', access_point_names: null, card_uid: '168,15956' },
    ]);
    const res = makeRes();
    await contractorAdminController.approveSubmission(makeReq(), res as never);

    expect(h.updEmp).toHaveBeenCalledTimes(1);
    expect(h.updEmp).toHaveBeenCalledWith(12, { name: 'B', blocked: false }, 'external');
    const body = res.body as { data: { status: string } };
    expect(body.data.status).toBe('approved');
  });

  it('Sigur "not found" при удалении трактуется как успех', async () => {
    h.queryOne.mockResolvedValueOnce({ id: 'sub-1', status: 'pending' });
    h.query.mockResolvedValueOnce([]); // induction pre-check: все прошли инструктаж
    h.query.mockResolvedValueOnce([{ id: 'r-rm', sigur_employee_id: 100 }]);
    h.query.mockResolvedValueOnce([]);
    h.delEmp.mockRejectedValueOnce(new Error('Employee not found (404)'));
    const res = makeRes();
    await contractorAdminController.approveSubmission(makeReq(), res as never);

    const body = res.body as { data: { status: string; applied: number } };
    expect(body.data.status).toBe('approved');
    expect(body.data.applied).toBe(1);
  });

  it('ЭТАП 2: объект на пропуске → бинд точек доступа, unmatched → warning (не блокирует)', async () => {
    h.queryOne.mockResolvedValueOnce({ id: 'sub-1', status: 'pending' });
    h.query.mockResolvedValueOnce([]); // induction pre-check: все прошли инструктаж
    h.query.mockResolvedValueOnce([]);
    h.query.mockResolvedValueOnce([
      { pass_id: 'p1', pass_status: 'assigned', pass_sigur_id: 11, holder_name: 'A', access_point_names: ['КПП 1', 'КПП X'], card_uid: '168,15956' },
    ]);
    h.resolveAP.mockResolvedValue({ accessPointIds: [7, 8], unmatchedNames: ['КПП X'] });
    const res = makeRes();
    await contractorAdminController.approveSubmission(makeReq(), res as never);

    expect(h.resolveAP).toHaveBeenCalledWith(['КПП 1', 'КПП X'], 'external');
    expect(h.replaceAP).toHaveBeenCalledWith(11, [7, 8], 'external');
    const body = res.body as { data: { status: string; applied: number; warnings: string[] } };
    expect(body.data.status).toBe('approved');
    expect(body.data.applied).toBe(1);
    expect(body.data.warnings[0]).toContain('КПП X');
  });

  it('ЭТАП 2: сбой бинда точек доступа → partially_applied, pass не applied', async () => {
    h.queryOne.mockResolvedValueOnce({ id: 'sub-1', status: 'pending' });
    h.query.mockResolvedValueOnce([]); // induction pre-check: все прошли инструктаж
    h.query.mockResolvedValueOnce([]);
    h.query.mockResolvedValueOnce([
      { pass_id: 'p1', pass_status: 'assigned', pass_sigur_id: 11, holder_name: 'A', access_point_names: ['КПП 1'], card_uid: '168,15956' },
    ]);
    h.resolveAP.mockResolvedValue({ accessPointIds: [7], unmatchedNames: [] });
    h.replaceAP.mockRejectedValueOnce(new Error('Sigur AP 500'));
    const res = makeRes();
    await contractorAdminController.approveSubmission(makeReq(), res as never);

    const body = res.body as { data: { status: string; failed: number; errors: string[] } };
    expect(body.data.status).toBe('partially_applied');
    expect(body.data.failed).toBe(1);
    expect(body.data.errors[0]).toContain('p1');
  });

  it('гейт по карте: провал привязки → pass не applied, updateSigurEmployee не зовётся', async () => {
    h.queryOne.mockResolvedValueOnce({ id: 'sub-1', status: 'pending' });
    h.query.mockResolvedValueOnce([]); // induction pre-check: все прошли инструктаж
    h.query.mockResolvedValueOnce([]);
    h.query.mockResolvedValueOnce([
      { pass_id: 'p1', pass_status: 'assigned', pass_sigur_id: 11, holder_name: 'A', access_point_names: null, card_uid: '168,15956' },
    ]);
    h.assignCard.mockRejectedValueOnce(new Error('Sigur card 400'));
    const res = makeRes();
    await contractorAdminController.approveSubmission(makeReq(), res as never);

    // привязка карты — раньше переименования, и при провале переименование не выполняется
    expect(h.assignCard).toHaveBeenCalledWith(11, ['168,15956'], undefined, 'external', true, { expectedHolderName: 'A', reassignPolicy: 'safe-only' });
    expect(h.updEmp).not.toHaveBeenCalled();
    const body = res.body as { data: { status: string; failed: number; errors: string[] } };
    expect(body.data.status).toBe('partially_applied');
    expect(body.data.failed).toBe(1);
    expect(body.data.errors[0]).toContain('p1');
  });

  it('гейт по карте: нет card_uid → pass не applied', async () => {
    h.queryOne.mockResolvedValueOnce({ id: 'sub-1', status: 'pending' });
    h.query.mockResolvedValueOnce([]); // induction pre-check: все прошли инструктаж
    h.query.mockResolvedValueOnce([]);
    h.query.mockResolvedValueOnce([
      { pass_id: 'p1', pass_status: 'assigned', pass_sigur_id: 11, holder_name: 'A', access_point_names: null, card_uid: null },
    ]);
    const res = makeRes();
    await contractorAdminController.approveSubmission(makeReq(), res as never);

    expect(h.assignCard).not.toHaveBeenCalled();
    expect(h.updEmp).not.toHaveBeenCalled();
    const body = res.body as { data: { status: string; failed: number } };
    expect(body.data.status).toBe('partially_applied');
    expect(body.data.failed).toBe(1);
  });
});

describe('contractorAdminController.decideSubmission — срок действия', () => {
  const PASS_ID = '11111111-1111-1111-1111-111111111111';
  const makeDecideReq = (bodyObj: unknown) => ({
    user: { id: 'admin-1', company_scope: { roots: 'all' } },
    params: { id: 'sub-1' },
    ip: '127.0.0.1',
    headers: {},
    socket: {},
    body: bodyObj,
  }) as never;

  beforeEach(() => {
    Object.values(h).forEach(fn => fn.mockReset());
    h.resolveCompanyScope.mockResolvedValue({ roots: 'all' });
    h.bgConn.mockResolvedValue('external');
    h.isDryRun.mockReturnValue(false);
    h.execute.mockResolvedValue(1);
    h.logFromRequest.mockResolvedValue(undefined);
    h.assignCard.mockResolvedValue({ card: { cardId: 10 }, previousSigurEmployeeId: null, reassigned: false });
    h.resolveAP.mockResolvedValue({ accessPointIds: [], unmatchedNames: [] });
    // Поиск дублей (findDuplicatesForNames) делает доп. query() — по умолчанию пусто.
    h.query.mockResolvedValue([]);
    h.withTransaction.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) =>
      fn({ query: vi.fn().mockResolvedValue({ rows: [] }) }),
    );
  });

  it('expires_at прокидывается в привязку карты (ISO) и в UPDATE пропуска', async () => {
    h.queryOne
      .mockResolvedValueOnce({ id: 'sub-1', status: 'pending', org_department_id: 'org-1' }) // submission
      .mockResolvedValueOnce({ total: '1', pending: '0', approved: '1', rejected: '0' }); // counts
    h.query.mockResolvedValueOnce([
      { id: PASS_ID, status: 'submitted', sigur_employee_id: 11, holder_name: 'A',
        submission_id: 'sub-1', access_point_names: null, card_uid: '168,15956', induction_passed: true },
    ]);

    let txCalls: unknown[][] = [];
    h.withTransaction.mockImplementation(async (fn: (c: { query: ReturnType<typeof vi.fn> }) => unknown) => {
      const q = vi.fn().mockResolvedValue({ rows: [] });
      const r = await fn({ query: q });
      txCalls = txCalls.concat(q.mock.calls);
      return r;
    });

    const res = makeRes();
    await contractorAdminController.decideSubmission(
      makeDecideReq({ decisions: [{ pass_id: PASS_ID, decision: 'approved' }], expires_at: '2027-01-15' }),
      res as never,
    );

    const expIso = new Date('2027-01-15T23:59:59').toISOString();
    expect(h.assignCard).toHaveBeenCalledWith(11, ['168,15956'], expIso, 'external', true, { expectedHolderName: 'A', reassignPolicy: 'safe-only' });

    const passUpd = txCalls.find(c => String(c[0]).includes('UPDATE contractor_passes'));
    expect(passUpd).toBeTruthy();
    expect(String(passUpd?.[0])).toContain('expires_at = COALESCE');
    expect((passUpd?.[1] as unknown[])).toContain('2027-01-15');
  });

  it('без expires_at — серверный дефолт 31.12 текущего года (не раньше завтра)', async () => {
    h.queryOne
      .mockResolvedValueOnce({ id: 'sub-1', status: 'pending', org_department_id: 'org-1' })
      .mockResolvedValueOnce({ total: '1', pending: '0', approved: '1', rejected: '0' });
    h.query.mockResolvedValueOnce([
      { id: PASS_ID, status: 'submitted', sigur_employee_id: 11, holder_name: 'A',
        submission_id: 'sub-1', access_point_names: null, card_uid: '168,15956', induction_passed: true },
    ]);

    const res = makeRes();
    await contractorAdminController.decideSubmission(
      makeDecideReq({ decisions: [{ pass_id: PASS_ID, decision: 'approved' }] }),
      res as never,
    );

    const minDate = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); })();
    const eoy = `${new Date().getFullYear()}-12-31`;
    const def = eoy >= minDate ? eoy : minDate;
    const expIso = new Date(`${def}T23:59:59`).toISOString();
    expect(h.assignCard).toHaveBeenCalledWith(11, ['168,15956'], expIso, 'external', true, { expectedHolderName: 'A', reassignPolicy: 'safe-only' });
  });

  it('per-item expires_at приоритетнее общего', async () => {
    h.queryOne
      .mockResolvedValueOnce({ id: 'sub-1', status: 'pending', org_department_id: 'org-1' })
      .mockResolvedValueOnce({ total: '1', pending: '0', approved: '1', rejected: '0' });
    h.query.mockResolvedValueOnce([
      { id: PASS_ID, status: 'submitted', sigur_employee_id: 11, holder_name: 'A',
        submission_id: 'sub-1', access_point_names: null, card_uid: '168,15956', induction_passed: true },
    ]);

    const res = makeRes();
    await contractorAdminController.decideSubmission(
      makeDecideReq({
        decisions: [{ pass_id: PASS_ID, decision: 'approved', expires_at: '2028-03-03' }],
        expires_at: '2027-01-15',
      }),
      res as never,
    );

    const expIso = new Date('2028-03-03T23:59:59').toISOString();
    expect(h.assignCard).toHaveBeenCalledWith(11, ['168,15956'], expIso, 'external', true, { expectedHolderName: 'A', reassignPolicy: 'safe-only' });
  });

  it('срок раньше завтрашней даты → пропуск не активируется (failed)', async () => {
    h.queryOne
      .mockResolvedValueOnce({ id: 'sub-1', status: 'pending', org_department_id: 'org-1' })
      .mockResolvedValueOnce({ total: '1', pending: '1', approved: '0', rejected: '0' });
    h.query.mockResolvedValueOnce([
      { id: PASS_ID, status: 'submitted', sigur_employee_id: 11, holder_name: 'A',
        submission_id: 'sub-1', access_point_names: null, card_uid: '168,15956', induction_passed: true },
    ]);

    const res = makeRes();
    await contractorAdminController.decideSubmission(
      makeDecideReq({ decisions: [{ pass_id: PASS_ID, decision: 'approved', expires_at: '2000-01-01' }] }),
      res as never,
    );

    expect(h.assignCard).not.toHaveBeenCalled();
    const body = res.body as { data: { applied: number; failed: number } };
    expect(body.data.applied).toBe(0);
    expect(body.data.failed).toBe(1);
  });

  it('после активации возвращает batch_id и дубли; activated_sigur_ids сохранены', async () => {
    h.queryOne
      .mockResolvedValueOnce({ id: 'sub-1', status: 'pending', org_department_id: 'org-1' }) // submission
      .mockResolvedValueOnce({ total: '1', pending: '0', approved: '1', rejected: '0' })       // counts
      .mockResolvedValueOnce({ id: 'batch-1' });                                               // INSERT batch RETURNING
    h.query
      .mockResolvedValueOnce([ // passes заявки
        { id: PASS_ID, status: 'submitted', sigur_employee_id: 11, holder_name: 'A',
          submission_id: 'sub-1', access_point_names: null, card_uid: '168,15956', induction_passed: true },
      ])
      .mockResolvedValueOnce([ // findDuplicatesForNames: подрядный дубль (bigint строкой)
        { pass_id: 'p-old', sigur_employee_id: '22', full_name: 'A', pass_number: '0050',
          access_point_names: ['КПП 1'], card_uid: '1,2', place_name: 'ООО Рога', employee_id: 500 },
      ])
      .mockResolvedValueOnce([]); // empRows

    const res = makeRes();
    await contractorAdminController.decideSubmission(
      makeDecideReq({ decisions: [{ pass_id: PASS_ID, decision: 'approved', expires_at: '2027-01-15' }] }),
      res as never,
    );

    const body = res.body as { data: { batch_id: string; duplicates: Array<{ source: string; sigur_employee_id: number }> } };
    expect(body.data.batch_id).toBe('batch-1');
    expect(body.data.duplicates).toHaveLength(1);
    expect(body.data.duplicates[0].source).toBe('contractor_pass');
    expect(body.data.duplicates[0].sigur_employee_id).toBe(22);
    // INSERT батча получил activated_sigur_ids = [11]
    const insertCall = h.queryOne.mock.calls.find(c => String(c[0]).includes('contractor_activation_batches'));
    expect(insertCall?.[1]?.[2]).toEqual([11]);
  });

  it('пустой выбор точек → replaceAP вызван с [] (очистка всех точек)', async () => {
    h.queryOne
      .mockResolvedValueOnce({ id: 'sub-1', status: 'pending', org_department_id: 'org-1' })
      .mockResolvedValueOnce({ total: '1', pending: '0', approved: '1', rejected: '0' });
    h.query.mockResolvedValueOnce([
      { id: PASS_ID, status: 'submitted', sigur_employee_id: 11, holder_name: 'A',
        submission_id: 'sub-1', access_point_names: null, card_uid: '168,15956', induction_passed: true },
    ]);

    const res = makeRes();
    await contractorAdminController.decideSubmission(
      makeDecideReq({ decisions: [{ pass_id: PASS_ID, decision: 'approved', access_point_names: [], expires_at: '2027-01-15' }] }),
      res as never,
    );

    expect(h.resolveAP).not.toHaveBeenCalled();
    expect(h.replaceAP).toHaveBeenCalledWith(11, [], 'external');
    const body = res.body as { data: { applied: number } };
    expect(body.data.applied).toBe(1);
  });

  it('непустой выбор, всё не сопоставилось → replaceAP не вызван, текущие точки не снимаются', async () => {
    h.queryOne
      .mockResolvedValueOnce({ id: 'sub-1', status: 'pending', org_department_id: 'org-1' })
      .mockResolvedValueOnce({ total: '1', pending: '0', approved: '1', rejected: '0' });
    h.query.mockResolvedValueOnce([
      { id: PASS_ID, status: 'submitted', sigur_employee_id: 11, holder_name: 'A',
        submission_id: 'sub-1', access_point_names: null, card_uid: '168,15956', induction_passed: true },
    ]);
    h.resolveAP.mockResolvedValue({ accessPointIds: [], unmatchedNames: ['КПП X'] });

    const res = makeRes();
    await contractorAdminController.decideSubmission(
      makeDecideReq({ decisions: [{ pass_id: PASS_ID, decision: 'approved', access_point_names: ['КПП X'], expires_at: '2027-01-15' }] }),
      res as never,
    );

    expect(h.resolveAP).toHaveBeenCalledWith(['КПП X'], 'external');
    expect(h.replaceAP).not.toHaveBeenCalled();
    const body = res.body as { data: { applied: number; warnings: string[] } };
    expect(body.data.applied).toBe(1);
    expect(body.data.warnings.some(w => w.includes('КПП X'))).toBe(true);
  });
});

describe('contractorAdminController.setPassInduction', () => {
  const PASS_ID = '33333333-3333-3333-3333-333333333333';
  const makeIndReq = (bodyObj: unknown) => ({
    user: { id: 'admin-1', role_code: 'admin' },
    params: { passId: PASS_ID },
    ip: '127.0.0.1',
    headers: {},
    socket: {},
    body: bodyObj,
  }) as never;

  beforeEach(() => {
    Object.values(h).forEach(fn => fn.mockReset());
    h.resolveCompanyScope.mockResolvedValue({ roots: 'all' });
    h.logFromRequest.mockResolvedValue(undefined);
  });

  it('ставит инструктаж (passed=true) → success + аудит', async () => {
    // prev-состояние
    h.queryOne.mockResolvedValueOnce({ induction_passed: false, pass_number: '001', holder_name: 'Иванов И.' });
    // UPDATE ... RETURNING id
    h.queryOne.mockResolvedValueOnce({ id: PASS_ID });
    const res = makeRes();
    await contractorAdminController.setPassInduction(makeIndReq({ passed: true }), res as never);

    const upd = h.queryOne.mock.calls[1];
    expect(String(upd[0])).toContain("approval_status = 'pending'");
    expect(upd[1]).toEqual([true, 'admin-1', PASS_ID]);
    expect(h.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'admin-1', 'CONTRACTOR_INDUCTION_CHANGED',
      expect.objectContaining({ entityType: 'contractor_pass', entityId: PASS_ID }),
    );
    const body = res.body as { success: boolean; data: { induction_passed: boolean } };
    expect(body.data.induction_passed).toBe(true);
  });

  it('пропуск уже не pending (rowCount=0) → 409, аудит не пишется', async () => {
    h.queryOne.mockResolvedValueOnce({ induction_passed: false, pass_number: '001', holder_name: 'A' });
    h.queryOne.mockResolvedValueOnce(null); // UPDATE ничего не затронул
    const res = makeRes();
    await contractorAdminController.setPassInduction(makeIndReq({ passed: true }), res as never);

    expect(res.statusCode).toBe(409);
    expect(h.logFromRequest).not.toHaveBeenCalled();
  });

  it('невалидное тело (passed не boolean) → 400', async () => {
    const res = makeRes();
    await contractorAdminController.setPassInduction(makeIndReq({ passed: 'yes' }), res as never);
    expect(res.statusCode).toBe(400);
  });

  it('снятие (passed=false) очищает *_at/_by (параметры UPDATE)', async () => {
    h.queryOne.mockResolvedValueOnce({ induction_passed: true, pass_number: '001', holder_name: 'A' });
    h.queryOne.mockResolvedValueOnce({ id: PASS_ID });
    const res = makeRes();
    await contractorAdminController.setPassInduction(makeIndReq({ passed: false }), res as never);

    const upd = h.queryOne.mock.calls[1];
    expect(upd[1]).toEqual([false, 'admin-1', PASS_ID]);
    expect(String(upd[0])).toContain('induction_passed_at = CASE WHEN $1 THEN now() ELSE NULL END');
  });
});

describe('contractorAdminController — enforcement вводного инструктажа', () => {
  const PASS_ID = '44444444-4444-4444-4444-444444444444';
  const makeReqP = (bodyObj?: unknown) => ({
    user: { id: 'admin-1', company_scope: { roots: 'all' } },
    params: { id: 'sub-1' },
    ip: '127.0.0.1',
    headers: {},
    socket: {},
    body: bodyObj,
  }) as never;

  beforeEach(() => {
    Object.values(h).forEach(fn => fn.mockReset());
    h.resolveCompanyScope.mockResolvedValue({ roots: 'all' });
    h.bgConn.mockResolvedValue('external');
    h.isDryRun.mockReturnValue(false);
    h.execute.mockResolvedValue(1);
    h.logFromRequest.mockResolvedValue(undefined);
    h.resolveAP.mockResolvedValue({ accessPointIds: [], unmatchedNames: [] });
    h.assignCard.mockResolvedValue({ card: { cardId: 10 }, previousSigurEmployeeId: null, reassigned: false });
    h.query.mockResolvedValue([]);
    h.withTransaction.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) =>
      fn({ query: vi.fn().mockResolvedValue({ rows: [] }) }),
    );
  });

  it('approveSubmission: есть без инструктажа → 422, Sigur не трогаем', async () => {
    h.queryOne.mockResolvedValueOnce({ id: 'sub-1', status: 'pending' });
    // notInducted pre-check вернул непустой список
    h.query.mockResolvedValueOnce([{ pass_number: '001', holder_name: 'Иванов И.' }]);
    const res = makeRes();
    await contractorAdminController.approveSubmission(makeReqP(), res as never);

    expect(res.statusCode).toBe(422);
    expect(h.delEmp).not.toHaveBeenCalled();
    expect(h.updEmp).not.toHaveBeenCalled();
    const body = res.body as { data: { without_induction: Array<{ pass_number: string }> } };
    expect(body.data.without_induction[0].pass_number).toBe('001');
  });

  it('decideSubmission: approved без инструктажа → 422, активации нет', async () => {
    h.queryOne.mockResolvedValueOnce({ id: 'sub-1', status: 'pending', org_department_id: 'org-1' });
    h.query.mockResolvedValueOnce([
      { id: PASS_ID, status: 'submitted', sigur_employee_id: 11, holder_name: 'A',
        submission_id: 'sub-1', access_point_names: null, card_uid: '168,15956',
        pass_number: '002', induction_passed: false },
    ]);
    const res = makeRes();
    await contractorAdminController.decideSubmission(
      makeReqP({ decisions: [{ pass_id: PASS_ID, decision: 'approved' }] }), res as never,
    );

    expect(res.statusCode).toBe(422);
    expect(h.assignCard).not.toHaveBeenCalled();
    const body = res.body as { data: { without_induction: Array<{ pass_number: string }> } };
    expect(body.data.without_induction[0].pass_number).toBe('002');
  });

  it('decideSubmission: rejected без инструктажа — разрешено (не 422)', async () => {
    h.queryOne
      .mockResolvedValueOnce({ id: 'sub-1', status: 'pending', org_department_id: 'org-1' })
      .mockResolvedValueOnce({ total: '1', pending: '0', approved: '0', rejected: '1' });
    h.query.mockResolvedValueOnce([
      { id: PASS_ID, status: 'submitted', sigur_employee_id: 11, holder_name: 'A',
        submission_id: 'sub-1', access_point_names: null, card_uid: '168,15956',
        pass_number: '003', induction_passed: false },
    ]);
    const res = makeRes();
    await contractorAdminController.decideSubmission(
      makeReqP({ decisions: [{ pass_id: PASS_ID, decision: 'rejected' }] }), res as never,
    );

    expect(res.statusCode).not.toBe(422);
    expect(h.assignCard).not.toHaveBeenCalled();
  });
});

describe('contractorAdminController.blockDuplicate', () => {
  const makeBlockReq = (bodyObj: unknown) => ({
    user: { id: 'admin-1', company_scope: { roots: 'all' } },
    params: {},
    ip: '127.0.0.1',
    headers: {},
    socket: {},
    body: bodyObj,
  }) as never;

  const BATCH = '22222222-2222-2222-2222-222222222222';

  beforeEach(() => {
    Object.values(h).forEach(fn => fn.mockReset());
    h.resolveCompanyScope.mockResolvedValue({ roots: 'all' });
    h.bgConn.mockResolvedValue('external');
    h.isDryRun.mockReturnValue(false);
    h.execute.mockResolvedValue(1);
    h.logFromRequest.mockResolvedValue(undefined);
    h.withTransaction.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) =>
      fn({ query: vi.fn().mockResolvedValue({ rows: [] }) }),
    );
  });

  const freshBatch = (over: Record<string, unknown>) => ({
    id: BATCH, created_by: 'admin-1', created_at: new Date().toISOString(),
    activated_sigur_ids: [11], candidates: [], ...over,
  });

  it('батч не найден → 404', async () => {
    h.queryOne.mockResolvedValueOnce(null);
    const res = makeRes();
    await contractorAdminController.blockDuplicate(makeBlockReq({ batch_id: BATCH, sigur_employee_id: 22 }), res as never);
    expect(res.statusCode).toBe(404);
  });

  it('чужой батч → 404', async () => {
    h.queryOne.mockResolvedValueOnce(freshBatch({ created_by: 'other' }));
    const res = makeRes();
    await contractorAdminController.blockDuplicate(makeBlockReq({ batch_id: BATCH, sigur_employee_id: 22 }), res as never);
    expect(res.statusCode).toBe(404);
  });

  it('просроченный батч → 410', async () => {
    h.queryOne.mockResolvedValueOnce(freshBatch({
      created_at: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
    }));
    const res = makeRes();
    await contractorAdminController.blockDuplicate(makeBlockReq({ batch_id: BATCH, sigur_employee_id: 22 }), res as never);
    expect(res.statusCode).toBe(410);
  });

  it('цель = только что активированный → 409', async () => {
    h.queryOne.mockResolvedValueOnce(freshBatch({ activated_sigur_ids: [22] }));
    const res = makeRes();
    await contractorAdminController.blockDuplicate(makeBlockReq({ batch_id: BATCH, sigur_employee_id: 22 }), res as never);
    expect(res.statusCode).toBe(409);
    expect(h.enqueueRevoke).not.toHaveBeenCalled();
  });

  it('цель не из allow-list → 409', async () => {
    h.queryOne.mockResolvedValueOnce(freshBatch({ candidates: [] }));
    const res = makeRes();
    await contractorAdminController.blockDuplicate(makeBlockReq({ batch_id: BATCH, sigur_employee_id: 22 }), res as never);
    expect(res.statusCode).toBe(409);
  });

  it('подрядный дубль с картой → возврат в пул (enqueueRevoke)', async () => {
    h.queryOne
      .mockResolvedValueOnce(freshBatch({
        candidates: [{ source: 'contractor_pass', sigur_employee_id: 22, pass_id: 'p1', card_uid: '1,2', employee_id: null }],
      }))
      .mockResolvedValueOnce({ status: 'applied', is_active: true, card_uid: '1,2', sigur_employee_id: '22' });
    const res = makeRes();
    await contractorAdminController.blockDuplicate(makeBlockReq({ batch_id: BATCH, sigur_employee_id: 22 }), res as never);

    expect(h.enqueueRevoke).toHaveBeenCalledWith({ passId: 'p1', userId: 'admin-1' });
    expect(h.delEmp).not.toHaveBeenCalled();
    const body = res.body as { data: { action: string } };
    expect(body.data.action).toBe('returned_to_pool');
  });

  it('подрядный дубль без карты → удаление профиля + revoked', async () => {
    h.queryOne
      .mockResolvedValueOnce(freshBatch({
        candidates: [{ source: 'contractor_pass', sigur_employee_id: 22, pass_id: 'p1', card_uid: null, employee_id: null }],
      }))
      .mockResolvedValueOnce({ status: 'applied', is_active: true, card_uid: null, sigur_employee_id: '22' });
    const res = makeRes();
    await contractorAdminController.blockDuplicate(makeBlockReq({ batch_id: BATCH, sigur_employee_id: 22 }), res as never);

    expect(h.delEmp).toHaveBeenCalledWith(22, 'external');
    expect(h.enqueueRevoke).not.toHaveBeenCalled();
    const body = res.body as { data: { action: string } };
    expect(body.data.action).toBe('deleted');
  });

  it('устаревшее состояние пропуска → 409, ничего не трогаем', async () => {
    h.queryOne
      .mockResolvedValueOnce(freshBatch({
        candidates: [{ source: 'contractor_pass', sigur_employee_id: 22, pass_id: 'p1', card_uid: '1,2', employee_id: null }],
      }))
      .mockResolvedValueOnce({ status: 'revoked', is_active: false, card_uid: '1,2', sigur_employee_id: '22' });
    const res = makeRes();
    await contractorAdminController.blockDuplicate(makeBlockReq({ batch_id: BATCH, sigur_employee_id: 22 }), res as never);

    expect(res.statusCode).toBe(409);
    expect(h.enqueueRevoke).not.toHaveBeenCalled();
    expect(h.delEmp).not.toHaveBeenCalled();
  });

  it('штатный дубль → увольнение (applyDismissalImmediately)', async () => {
    h.queryOne
      .mockResolvedValueOnce(freshBatch({
        candidates: [{ source: 'employee', sigur_employee_id: 22, pass_id: null, card_uid: null, employee_id: 500 }],
      }))
      .mockResolvedValueOnce({ id: 500 }); // employees by sigur_employee_id
    h.loadLifecycle.mockResolvedValueOnce({ employment_status: 'active', hire_date: '2020-01-01' });
    h.applyDismissal.mockResolvedValueOnce({ fromDepartmentId: 'dep-1' });
    const res = makeRes();
    await contractorAdminController.blockDuplicate(makeBlockReq({ batch_id: BATCH, sigur_employee_id: 22 }), res as never);

    expect(h.applyDismissal).toHaveBeenCalledWith(expect.objectContaining({ employeeId: 500, source: 'contractor_admin' }));
    // Событие истории пишет durable-операция увольнения (миграция 261), контроллер — нет.
    expect(h.insertDismissalHistory).not.toHaveBeenCalled();
    const body = res.body as { data: { action: string } };
    expect(body.data.action).toBe('dismissed');
  });

  it('штатный дубль уже уволен → 409', async () => {
    h.queryOne
      .mockResolvedValueOnce(freshBatch({
        candidates: [{ source: 'employee', sigur_employee_id: 22, pass_id: null, card_uid: null, employee_id: 500 }],
      }))
      .mockResolvedValueOnce({ id: 500 });
    h.loadLifecycle.mockResolvedValueOnce({ employment_status: 'fired', hire_date: '2020-01-01' });
    const res = makeRes();
    await contractorAdminController.blockDuplicate(makeBlockReq({ batch_id: BATCH, sigur_employee_id: 22 }), res as never);

    expect(res.statusCode).toBe(409);
    expect(h.applyDismissal).not.toHaveBeenCalled();
  });

  it('dry-run: штатный дубль не вызывает Sigur/увольнение', async () => {
    h.isDryRun.mockReturnValue(true);
    h.queryOne
      .mockResolvedValueOnce(freshBatch({
        candidates: [{ source: 'employee', sigur_employee_id: 22, pass_id: null, card_uid: null, employee_id: 500 }],
      }))
      .mockResolvedValueOnce({ id: 500 });
    h.loadLifecycle.mockResolvedValueOnce({ employment_status: 'active', hire_date: '2020-01-01' });
    const res = makeRes();
    await contractorAdminController.blockDuplicate(makeBlockReq({ batch_id: BATCH, sigur_employee_id: 22 }), res as never);

    expect(h.applyDismissal).not.toHaveBeenCalled();
    const body = res.body as { data: { action: string; dry_run: boolean } };
    expect(body.data.action).toBe('dismissed');
    expect(body.data.dry_run).toBe(true);
  });
});

describe('contractorAdminController.rejectSubmissionPasses', () => {
  const SUB = 'sub-1';
  const P_PENDING = '11111111-1111-1111-1111-111111111111';
  const P_APPLIED = '22222222-2222-2222-2222-222222222222';

  const makeRejReq = (bodyObj: unknown) => ({
    user: { id: 'admin-1', company_scope: { roots: 'all' } },
    params: { id: SUB },
    ip: '127.0.0.1',
    headers: {},
    socket: {},
    body: bodyObj,
  }) as never;

  type ReturnedRow = { id: string; pass_number: string; sigur_employee_id: number | null; old_status: string };

  // Прогон транзакции: client.query маршрутизируется по фрагменту SQL.
  // capturedTxCalls собирает все вызовы для ассертов (CTE-UPDATE, закрытие holders, recompute).
  let txCalls: unknown[][] = [];
  const wireTx = (returnedRows: ReturnedRow[], aggRow: Record<string, string>) => {
    h.withTransaction.mockImplementation(async (fn: (c: { query: ReturnType<typeof vi.fn> }) => unknown) => {
      const q = vi.fn(async (sql: string) => {
        if (String(sql).includes('WITH locked')) return { rows: returnedRows };
        if (String(sql).includes('LEFT JOIN contractor_passes')) return { rows: [aggRow] };
        return { rows: [] };
      });
      const r = await fn({ query: q });
      txCalls = txCalls.concat(q.mock.calls);
      return r;
    });
  };

  beforeEach(() => {
    Object.values(h).forEach(fn => fn.mockReset());
    txCalls = [];
    h.resolveCompanyScope.mockResolvedValue({ roots: 'all' });
    h.bgConn.mockResolvedValue('external');
    h.isDryRun.mockReturnValue(false);
    h.logFromRequest.mockResolvedValue(undefined);
  });

  it('409 если заявка уже обработана', async () => {
    h.queryOne.mockResolvedValueOnce({ id: SUB, status: 'approved' });
    const res = makeRes();
    await contractorAdminController.rejectSubmissionPasses(
      makeRejReq({ pass_ids: [P_PENDING] }), res as never,
    );
    expect(res.statusCode).toBe(409);
  });

  it('защита: holders закрываются ТОЛЬКО по id из RETURNING, не по входным pass_ids', async () => {
    h.queryOne
      .mockResolvedValueOnce({ id: SUB, status: 'pending' })       // submission
      .mockResolvedValueOnce({ status: 'rejected' });              // after-status
    // RETURNING вернул только pending-пропуск (DB-страж отфильтровал applied).
    wireTx(
      [{ id: P_PENDING, pass_number: '001', sigur_employee_id: 11, old_status: 'submitted' }],
      { current: 'pending', total: '0', pending: '0', approved: '0', rejected: '0' },
    );

    const res = makeRes();
    await contractorAdminController.rejectSubmissionPasses(
      // передаём и applied-id — он не должен попасть в закрытие holders
      makeRejReq({ pass_ids: [P_PENDING, P_APPLIED] }), res as never,
    );

    const holderCall = txCalls.find(c => String(c[0]).includes('contractor_pass_holders'));
    expect(holderCall).toBeTruthy();
    expect(holderCall?.[1]?.[0]).toEqual([P_PENDING]);       // только RETURNING-id
    expect(holderCall?.[1]?.[0]).not.toContain(P_APPLIED);
    const body = res.body as { data: { returned: number } };
    expect(body.data.returned).toBe(1);
  });

  it('первичная заявка (submitted): контейнер сохранён, Sigur не зовётся, заявка → rejected', async () => {
    h.queryOne
      .mockResolvedValueOnce({ id: SUB, status: 'pending' })
      .mockResolvedValueOnce({ status: 'rejected' });
    wireTx(
      [{ id: P_PENDING, pass_number: '001', sigur_employee_id: 11, old_status: 'submitted' }],
      { current: 'pending', total: '0', pending: '0', approved: '0', rejected: '0' },
    );

    const res = makeRes();
    await contractorAdminController.rejectSubmissionPasses(
      makeRejReq({ pass_ids: [P_PENDING] }), res as never,
    );

    // updateSigurEmployee НЕ вызван (профиль первички уже нейтрален).
    expect(h.updEmp).not.toHaveBeenCalled();
    // CTE-UPDATE НЕ обнуляет sigur_employee_id / card_uid.
    const updCall = txCalls.find(c => String(c[0]).includes('WITH locked'));
    expect(updCall).toBeTruthy();
    expect(String(updCall?.[0])).not.toMatch(/SET[\s\S]*?sigur_employee_id\s*=\s*NULL/);
    expect(String(updCall?.[0])).not.toContain('card_uid');
    const body = res.body as { data: { returned: number; status: string } };
    expect(body.data.returned).toBe(1);
    expect(body.data.status).toBe('rejected');
  });

  it('changeHolder (blocked): профиль-контейнер нейтрализован, sigur_employee_id сохранён', async () => {
    h.queryOne
      .mockResolvedValueOnce({ id: SUB, status: 'pending' })
      .mockResolvedValueOnce({ status: 'rejected' });
    wireTx(
      [{ id: P_PENDING, pass_number: '007', sigur_employee_id: 22, old_status: 'blocked' }],
      { current: 'pending', total: '0', pending: '0', approved: '0', rejected: '0' },
    );

    const res = makeRes();
    await contractorAdminController.rejectSubmissionPasses(
      makeRejReq({ pass_ids: [P_PENDING] }), res as never,
    );

    expect(h.updEmp).toHaveBeenCalledWith(22, { name: 'Пропуск 007', blocked: true }, 'external');
    // контейнер не обнуляется в БД.
    const updCall = txCalls.find(c => String(c[0]).includes('WITH locked'));
    expect(String(updCall?.[0])).not.toMatch(/SET[\s\S]*?sigur_employee_id\s*=\s*NULL/);
  });

  it('dry-run: Sigur не зовётся даже для changeHolder', async () => {
    h.isDryRun.mockReturnValue(true);
    h.queryOne
      .mockResolvedValueOnce({ id: SUB, status: 'pending' })
      .mockResolvedValueOnce({ status: 'rejected' });
    wireTx(
      [{ id: P_PENDING, pass_number: '007', sigur_employee_id: 22, old_status: 'blocked' }],
      { current: 'pending', total: '0', pending: '0', approved: '0', rejected: '0' },
    );

    const res = makeRes();
    await contractorAdminController.rejectSubmissionPasses(
      makeRejReq({ pass_ids: [P_PENDING] }), res as never,
    );

    expect(h.updEmp).not.toHaveBeenCalled();
  });
});

describe('contractorAdminController.clearPassHolder', () => {
  const PASS = '55555555-5555-5555-5555-555555555555';

  type PassRow = {
    id: string; pass_number: string; status: string; is_active: boolean;
    holder_name: string | null; sigur_employee_id: number | null;
    submission_id: string | null; has_open_holder: boolean;
  };

  const makeClearReq = () => ({
    user: { id: 'admin-1', company_scope: { roots: 'all' } },
    params: { id: PASS },
    ip: '127.0.0.1',
    headers: {},
    socket: {},
  }) as never;

  // Транзакция: маршрутизируем client.query по фрагменту SQL. clientQuery доступен снаружи
  // (даже если fn бросил) — для ассертов, что БД не тронута при сбое Sigur.
  let clientQuery: ReturnType<typeof vi.fn>;
  const wireTx = (passRow: PassRow | null, aggRow?: Record<string, string>) => {
    h.withTransaction.mockImplementation(async (fn: (c: { query: ReturnType<typeof vi.fn> }) => unknown) => {
      clientQuery = vi.fn(async (sql: string) => {
        if (String(sql).includes('FOR UPDATE')) return { rows: passRow ? [passRow] : [] };
        if (String(sql).includes('LEFT JOIN contractor_passes')) return { rows: aggRow ? [aggRow] : [] };
        return { rows: [] };
      });
      return fn({ query: clientQuery });
    });
  };

  const basePass = (over: Partial<PassRow>): PassRow => ({
    id: PASS, pass_number: '1124', status: 'applied', is_active: true,
    holder_name: 'Жумабаев Б.', sigur_employee_id: 11, submission_id: null,
    has_open_holder: true, ...over,
  });

  const findCall = (frag: string) => clientQuery.mock.calls.find(c => String(c[0]).includes(frag));

  beforeEach(() => {
    Object.values(h).forEach(fn => fn.mockReset());
    h.resolveCompanyScope.mockResolvedValue({ roots: 'all' });
    h.bgConn.mockResolvedValue('external');
    h.isDryRun.mockReturnValue(false);
    h.logFromRequest.mockResolvedValue(undefined);
  });

  it('data-safety: Sigur упал → БД не тронута (нет UPDATE), история не закрыта, 502', async () => {
    wireTx(basePass({}));
    h.updEmp.mockRejectedValueOnce(new Error('Sigur down'));

    const res = makeRes();
    await contractorAdminController.clearPassHolder(makeClearReq(), res as never);

    expect(res.statusCode).toBe(502);
    // После SELECT FOR UPDATE никаких UPDATE не выполнено.
    expect(findCall('UPDATE contractor_passes')).toBeUndefined();
    expect(findCall('UPDATE contractor_pass_holders')).toBeUndefined();
    expect(h.logFromRequest).not.toHaveBeenCalled();
  });

  it('успех (applied): Sigur заблокирован ПЕРЕД UPDATE; чистятся ФИО, документы, выдача', async () => {
    wireTx(basePass({}));
    h.updEmp.mockResolvedValueOnce(undefined);

    const res = makeRes();
    await contractorAdminController.clearPassHolder(makeClearReq(), res as never);

    expect(res.statusCode).toBe(200);
    expect((res.body as { success: boolean }).success).toBe(true);

    // Sigur вызван с нейтрализацией профиля.
    expect(h.updEmp).toHaveBeenCalledWith(11, { name: 'Пропуск 1124', blocked: true }, 'external');

    const upd = findCall('UPDATE contractor_passes');
    expect(upd).toBeTruthy();
    const sql = String(upd?.[0]);
    // ФИО + статус + персональные документы + параметры выдачи очищаются.
    expect(sql).toContain("status='assigned'");
    expect(sql).toContain('holder_name=NULL');
    expect(sql).toContain('citizenship=NULL');
    expect(sql).toContain('has_residence_permit=false');
    expect(sql).toContain('object_ids=NULL');
    expect(sql).toContain('access_point_names=NULL');
    expect(sql).toContain('expires_at=NULL');
    // Контейнер слота (карта/профиль) НЕ трогаем.
    expect(sql).not.toContain('card_uid');
    expect(sql).not.toContain('sigur_employee_id');

    // Sigur — раньше UPDATE.
    const updIdx = clientQuery.mock.calls.findIndex(c => String(c[0]).includes('UPDATE contractor_passes'));
    expect(h.updEmp.mock.invocationCallOrder[0]).toBeLessThan(clientQuery.mock.invocationCallOrder[updIdx]);

    // История закрыта.
    const holderClose = findCall('UPDATE contractor_pass_holders');
    expect(holderClose).toBeTruthy();
    expect(holderClose?.[1]?.[0]).toBe(PASS);

    // Audit после commit.
    expect(h.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'admin-1', 'CONTRACTOR_PASS_HOLDER_CHANGED',
      expect.objectContaining({ entityType: 'contractor_pass', entityId: PASS }),
    );
  });

  it('освобождение сохраняет последний комплект документов в историю (source=clear_holder)', async () => {
    wireTx({
      ...basePass({}),
      org_department_id: '77777777-7777-7777-7777-777777777777',
      passport_series_number: 'AB 1234567', passport_issue_date: '2020-01-01',
      birth_date: '1990-01-01', citizenship: 'УЗБЕКИСТАН',
      patent_number: '77 №2600295204', patent_issue_date: '2025-06-01',
      patent_blank_number: 'ПР8048893', has_residence_permit: false, residence_permit_number: null,
    } as unknown as PassRow);
    h.updEmp.mockResolvedValueOnce(undefined);

    const res = makeRes();
    await contractorAdminController.clearPassHolder(makeClearReq(), res as never);

    expect(res.statusCode).toBe(200);
    const hist = findCall('contractor_pass_document_history');
    expect(hist).toBeTruthy();
    const hp = hist?.[1] as unknown[];
    expect(hp[8]).toBe('77 №2600295204');   // прежний patent_number
    expect(hp[15]).toBe('clear_holder');    // changed_source
    // Снапшот — ДО очищающего UPDATE.
    const histIdx = clientQuery.mock.calls.findIndex(c => String(c[0]).includes('contractor_pass_document_history'));
    const updIdx = clientQuery.mock.calls.findIndex(c => String(c[0]).includes('UPDATE contractor_passes'));
    expect(histIdx).toBeGreaterThanOrEqual(0);
    expect(histIdx).toBeLessThan(updIdx);
  });

  it('guard: revoked → 409, Sigur и БД не трогаются', async () => {
    wireTx(basePass({ status: 'revoked', is_active: false }));

    const res = makeRes();
    await contractorAdminController.clearPassHolder(makeClearReq(), res as never);

    expect(res.statusCode).toBe(409);
    expect(h.updEmp).not.toHaveBeenCalled();
    expect(findCall('UPDATE contractor_passes')).toBeUndefined();
  });

  it('идемпотентность: нет ФИО и нет открытой истории → 409', async () => {
    wireTx(basePass({ status: 'assigned', is_active: false, holder_name: null, has_open_holder: false }));

    const res = makeRes();
    await contractorAdminController.clearPassHolder(makeClearReq(), res as never);

    expect(res.statusCode).toBe(409);
    expect(findCall('UPDATE contractor_passes')).toBeUndefined();
  });

  it('guard: активный пропуск без Sigur-профиля → 409, БД не тронута, история не закрыта', async () => {
    wireTx(basePass({ status: 'applied', is_active: true, sigur_employee_id: null }));

    const res = makeRes();
    await contractorAdminController.clearPassHolder(makeClearReq(), res as never);

    expect(res.statusCode).toBe(409);
    expect(h.updEmp).not.toHaveBeenCalled();
    expect(findCall('UPDATE contractor_passes')).toBeUndefined();
    expect(findCall('UPDATE contractor_pass_holders')).toBeUndefined();
    expect(h.logFromRequest).not.toHaveBeenCalled();
  });

  it('dry-run: активный без Sigur-профиля — guard не срабатывает, БД чистится, Sigur не зовётся', async () => {
    h.isDryRun.mockReturnValue(true);
    wireTx(basePass({ status: 'applied', is_active: true, sigur_employee_id: null }));

    const res = makeRes();
    await contractorAdminController.clearPassHolder(makeClearReq(), res as never);

    expect(res.statusCode).toBe(200);
    expect(h.updEmp).not.toHaveBeenCalled();
    expect(findCall('UPDATE contractor_passes')).toBeTruthy();
  });

  it('привязка к заявке: пересчёт статуса строго по pending/partially_applied', async () => {
    wireTx(
      basePass({ status: 'submitted', is_active: false, submission_id: 'sub-9' }),
      { current: 'pending', total: '0', pending: '0', approved: '0', rejected: '0' },
    );
    h.updEmp.mockResolvedValueOnce(undefined);

    const res = makeRes();
    await contractorAdminController.clearPassHolder(makeClearReq(), res as never);

    expect(res.statusCode).toBe(200);
    const subUpd = findCall('UPDATE contractor_submissions');
    expect(subUpd).toBeTruthy();
    expect(String(subUpd?.[0])).toContain("status IN ('pending', 'partially_applied')");
  });
});

/**
 * Админская правка документов держателя (замена патента по письму подрядчика).
 * Схема/нормализация/история — настоящие (contractor-docs.service не мокается
 * в этом файле); маршрутизация client.query — по фрагментам SQL.
 */
describe('contractorAdminController.updatePassDocumentsAdmin', () => {
  const PASS = '66666666-6666-6666-6666-666666666666';
  const ORG = '77777777-7777-7777-7777-777777777777';
  const UPDATED_AT = '2026-08-01T10:00:00.000Z';

  const basePass = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: PASS, pass_number: '90', status: 'applied', approval_status: 'approved',
    updated_at: new Date(UPDATED_AT),
    org_department_id: ORG, holder_name: 'Носиров Озод Орифович',
    passport_series_number: 'AB 1234567', passport_issue_date: '2020-01-01',
    birth_date: '1990-01-01', citizenship: 'УЗБЕКИСТАН',
    patent_number: '77 №2600295204', patent_issue_date: '2025-06-01',
    patent_blank_number: 'ПР8048893', has_residence_permit: false, residence_permit_number: null,
    ...over,
  });

  // Новый патент поверх старого; expected_updated_at совпадает с БД.
  const validBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    passport_series_number: 'AB 1234567', passport_issue_date: '2020-01-01', birth_date: '1990-01-01',
    citizenship: 'УЗБЕКИСТАН', patent_number: '78 №9999999999', patent_issue_date: '2026-07-01',
    patent_blank_number: 'ПР0000001', has_residence_permit: false, residence_permit_number: null,
    expected_updated_at: UPDATED_AT,
    ...over,
  });

  const makeDocsReq = (body: Record<string, unknown>, passId = PASS) => ({
    user: { id: 'admin-1', company_scope: { roots: 'all' } },
    params: { id: passId },
    body,
    ip: '127.0.0.1',
    headers: {},
    socket: {},
  }) as never;

  let clientQuery: ReturnType<typeof vi.fn>;
  const wireTx = (rows: Array<Record<string, unknown>>, dupRows: Array<Record<string, unknown>> = []) => {
    h.withTransaction.mockImplementation(async (fn: (c: { query: ReturnType<typeof vi.fn> }) => unknown) => {
      clientQuery = vi.fn(async (sql: string) => {
        const s = String(sql);
        if (s.includes('FOR UPDATE')) return { rows };
        // Дубль-детектор (findOrgDocDuplicate): FROM contractor_passes p + JOIN holders.
        if (s.includes('LEFT JOIN contractor_pass_holders')) return { rows: dupRows };
        return { rows: [], rowCount: 1 };
      });
      return fn({ query: clientQuery });
    });
  };

  const findCall = (frag: string) => clientQuery?.mock.calls.find(c => String(c[0]).includes(frag));

  beforeEach(() => {
    Object.values(h).forEach(fn => fn.mockReset());
    h.resolveCompanyScope.mockResolvedValue({ roots: 'all' });
    h.logFromRequest.mockResolvedValue(undefined);
  });

  it('невалидный uuid → 400, транзакция не открывается', async () => {
    const res = makeRes();
    await contractorAdminController.updatePassDocumentsAdmin(makeDocsReq(validBody(), 'not-a-uuid'), res as never);
    expect(res.statusCode).toBe(400);
    expect(h.withTransaction).not.toHaveBeenCalled();
  });

  it('view-only роль (грант без edit) → 403', async () => {
    h.resolveCompanyScope.mockResolvedValue({ roots: [] });
    h.hasPageView.mockResolvedValue(true);
    h.hasPageEdit.mockResolvedValue(false);
    const req = {
      user: { id: 'u-1', role_code: 'security', is_admin: false },
      params: { id: PASS }, body: validBody(), ip: '127.0.0.1', headers: {}, socket: {},
    } as never;
    const res = makeRes();
    await contractorAdminController.updatePassDocumentsAdmin(req, res as never);
    expect(res.statusCode).toBe(403);
    expect(h.withTransaction).not.toHaveBeenCalled();
  });

  it('пропуск не найден → 404', async () => {
    wireTx([]);
    const res = makeRes();
    await contractorAdminController.updatePassDocumentsAdmin(makeDocsReq(validBody()), res as never);
    expect(res.statusCode).toBe(404);
  });

  it.each(['in_pool', 'revoked'])('status=%s → 409, без UPDATE', async status => {
    wireTx([basePass({ status, approval_status: 'not_submitted' })]);
    const res = makeRes();
    await contractorAdminController.updatePassDocumentsAdmin(makeDocsReq(validBody()), res as never);
    expect(res.statusCode).toBe(409);
    expect(findCall('UPDATE contractor_passes')).toBeUndefined();
  });

  it('stale expected_updated_at (запись изменил другой) → 409, без UPDATE и истории', async () => {
    wireTx([basePass()]);
    const res = makeRes();
    await contractorAdminController.updatePassDocumentsAdmin(
      makeDocsReq(validBody({ expected_updated_at: '2026-08-01T09:00:00.000Z' })), res as never,
    );
    expect(res.statusCode).toBe(409);
    expect((res.body as { error?: string }).error).toContain('другим пользователем');
    expect(findCall('UPDATE contractor_passes')).toBeUndefined();
    expect(findCall('contractor_pass_document_history')).toBeUndefined();
  });

  it('approved нельзя оставить с неполным комплектом (патентная страна без патента) → 409', async () => {
    wireTx([basePass()]);
    const res = makeRes();
    await contractorAdminController.updatePassDocumentsAdmin(
      makeDocsReq(validBody({ patent_number: null, patent_issue_date: null, patent_blank_number: null })),
      res as never,
    );
    expect(res.statusCode).toBe(409);
    expect((res.body as { code?: string }).code).toBe('CONTRACTOR_DOCUMENTS_INCOMPLETE');
    expect(findCall('UPDATE contractor_passes')).toBeUndefined();
  });

  it('дубль патента внутри организации → 409 CONTRACTOR_DOCUMENT_DUPLICATE', async () => {
    wireTx([basePass()], [{ field: 'patent', holder_name: 'Другой Держатель', pass_number: '91' }]);
    const res = makeRes();
    await contractorAdminController.updatePassDocumentsAdmin(makeDocsReq(validBody()), res as never);
    expect(res.statusCode).toBe(409);
    expect((res.body as { code?: string }).code).toBe('CONTRACTOR_DOCUMENT_DUPLICATE');
    expect(findCall('UPDATE contractor_passes')).toBeUndefined();
  });

  it('успех: замена патента у действующего пропуска → UPDATE + снапшот старого патента + audit', async () => {
    wireTx([basePass()]);
    const res = makeRes();
    await contractorAdminController.updatePassDocumentsAdmin(makeDocsReq(validBody()), res as never);

    expect(res.statusCode).toBe(200);
    const body = res.body as { success: boolean; data: { changed_fields: string[] } };
    expect(body.success).toBe(true);
    expect(body.data.changed_fields.sort()).toEqual(['patent_blank_number', 'patent_issue_date', 'patent_number']);

    // Снапшот прежних значений: старый патент, источник admin.
    const hist = findCall('contractor_pass_document_history');
    expect(hist).toBeTruthy();
    const hp = hist?.[1] as unknown[];
    expect(hp[8]).toBe('77 №2600295204');          // прежний patent_number
    expect(hp[15]).toBe('admin');                  // changed_source
    expect((hp[13] as string[]).sort()).toEqual(['patent_blank_number', 'patent_issue_date', 'patent_number']);

    // Новые значения ушли в UPDATE.
    const upd = findCall('UPDATE contractor_passes');
    expect(upd).toBeTruthy();
    expect((upd?.[1] as unknown[])[4]).toBe('78 №9999999999');

    expect(h.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'admin-1', 'CONTRACTOR_PASS_DOCUMENTS_UPDATED',
      expect.objectContaining({ entityType: 'contractor_pass', entityId: PASS }),
    );
  });

  it('сохранение без изменений → 200, истории нет', async () => {
    wireTx([basePass()]);
    const res = makeRes();
    await contractorAdminController.updatePassDocumentsAdmin(
      makeDocsReq(validBody({
        patent_number: '77 №2600295204', patent_issue_date: '2025-06-01', patent_blank_number: 'ПР8048893',
      })),
      res as never,
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as { data: { changed_fields: string[] } }).data.changed_fields).toEqual([]);
    expect(findCall('contractor_pass_document_history')).toBeUndefined();
  });

  it('первичное заполнение пустого комплекта → 200 + UPDATE, но истории нет', async () => {
    wireTx([basePass({
      status: 'applied', approval_status: 'approved',
      passport_series_number: null, passport_issue_date: null, birth_date: null, citizenship: null,
      patent_number: null, patent_issue_date: null, patent_blank_number: null,
      has_residence_permit: false, residence_permit_number: null,
    })]);
    const res = makeRes();
    await contractorAdminController.updatePassDocumentsAdmin(makeDocsReq(validBody()), res as never);
    expect(res.statusCode).toBe(200);
    expect(findCall('UPDATE contractor_passes')).toBeTruthy();
    expect(findCall('contractor_pass_document_history')).toBeUndefined();
  });
});

/**
 * Доступ к разделу для не-админских ролей (см. contractor-access-gate.ts):
 * роль с грантом на /admin/contractor-approvals (например «Отдел безопасности»)
 * работает со всем разделом; узкая роль ОТиТБ остаётся при своих вкладках;
 * компанийный админ (is_admin + ограниченный scope) — по-прежнему 403.
 */
describe('contractorAdminController — доступ по гранту страницы', () => {
  const SECTION = '/admin/contractor-approvals';
  const SUBMISSIONS = '/admin/contractor-approvals/submissions';
  const OTITB = '/admin/contractor-approvals/otitb';

  const makeAccessReq = (isAdmin: boolean, roleCode: string) => ({
    user: { id: 'u-1', role_code: roleCode, is_admin: isAdmin },
    params: { id: 'sub-1' },
    query: { org_department_id: '11111111-1111-1111-1111-111111111111' },
    body: {},
    ip: '127.0.0.1',
    headers: {},
    socket: {},
  }) as never;

  /** Гранты по ключам: can_view и can_edit одновременно. */
  const grantKeys = (keys: string[]) => {
    h.hasPageView.mockImplementation(async (_r: string, key: string) => keys.includes(key));
    h.hasPageEdit.mockImplementation(async (_r: string, key: string) => keys.includes(key));
  };

  beforeEach(() => {
    Object.values(h).forEach(fn => fn.mockReset());
    h.logFromRequest.mockResolvedValue(undefined);
    h.query.mockResolvedValue([]);
    h.isDryRun.mockReturnValue(false);
  });

  it('security (основной грант): monitorPasses отдаёт данные', async () => {
    h.resolveCompanyScope.mockResolvedValue({ roots: [] });
    grantKeys([SECTION]);
    const res = makeRes();
    await contractorAdminController.monitorPasses(makeAccessReq(false, 'security'), res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true });
  });

  it('security (основной грант): rejectSubmission проходит гейт edit', async () => {
    h.resolveCompanyScope.mockResolvedValue({ roots: [] });
    grantKeys([SECTION]);
    h.queryOne.mockResolvedValueOnce(null); // заявки нет → 404, но гейт уже пройден
    const res = makeRes();
    await contractorAdminController.rejectSubmission(makeAccessReq(false, 'security'), res as never);
    expect(res.statusCode).toBe(404);
  });

  it('security (основной грант): getPendingSubmissions и listInductionOrgs открыты', async () => {
    h.resolveCompanyScope.mockResolvedValue({ roots: [] });
    grantKeys([SECTION]);
    const subsRes = makeRes();
    await contractorAdminController.getPendingSubmissions(makeAccessReq(false, 'security'), subsRes as never);
    expect(subsRes.statusCode).toBe(200);

    const scopeSvc = await import('../services/contractor-scope.service.js');
    vi.mocked(scopeSvc.getContractorOrgs).mockResolvedValue([]);
    const otitbRes = makeRes();
    await contractorAdminController.listInductionOrgs(makeAccessReq(false, 'security'), otitbRes as never);
    expect(otitbRes.statusCode).toBe(200);
  });

  it('узкая роль ОТиТБ: заявки открыты, мониторинг закрыт', async () => {
    h.resolveCompanyScope.mockResolvedValue({ roots: [] });
    grantKeys([SUBMISSIONS, OTITB]);

    const subsRes = makeRes();
    await contractorAdminController.getPendingSubmissions(makeAccessReq(false, 'otitb'), subsRes as never);
    expect(subsRes.statusCode).toBe(200);

    const monitorRes = makeRes();
    await contractorAdminController.monitorPasses(makeAccessReq(false, 'otitb'), monitorRes as never);
    expect(monitorRes.statusCode).toBe(403);
  });

  it('компанийный админ корня подрядчиков: monitorPasses отдаёт данные', async () => {
    h.resolveCompanyScope.mockResolvedValue({ roots: ['contractor-root'] });
    h.getContractorRootId.mockResolvedValue('contractor-root');
    const res = makeRes();
    await contractorAdminController.monitorPasses(makeAccessReq(true, 'admin'), res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true });
  });

  it('компанийный админ другого корня: 403', async () => {
    h.resolveCompanyScope.mockResolvedValue({ roots: ['su10-root'] });
    h.getContractorRootId.mockResolvedValue('contractor-root');
    const res = makeRes();
    await contractorAdminController.monitorPasses(makeAccessReq(true, 'admin'), res as never);
    expect(res.statusCode).toBe(403);
  });
});

describe('contractorAdminController — реестр обучения по ОТ', () => {
  const ORG = '11111111-1111-1111-1111-111111111111';
  const PERSON = '33333333-3333-3333-3333-333333333333';

  const req = (body: unknown, params: Record<string, string> = {}) => ({
    user: { id: 'u-1', role_code: 'otitb', is_admin: false },
    params,
    query: { org_department_id: ORG },
    body,
    ip: '127.0.0.1',
    headers: {},
    socket: {},
  }) as never;

  beforeEach(() => {
    Object.values(h).forEach(fn => fn.mockReset());
    h.logFromRequest.mockResolvedValue(undefined);
    h.query.mockResolvedValue([]);
    h.resolveCompanyScope.mockResolvedValue({ roots: [] });
    h.getContractorRootId.mockResolvedValue('contractor-root');
    h.getContractorOrgs.mockResolvedValue([{ id: ORG, name: 'ООО Подрядчик', sigur_department_id: 1 }]);
    h.listInductedByOrg.mockResolvedValue([]);
    h.countInductionByOrg.mockResolvedValue(new Map());
    h.listAllInducted.mockResolvedValue([]);
    // Роль ОТиТБ: гранты на техническую вкладку.
    h.hasPageView.mockImplementation(async (_r: string, key: string) =>
      key === '/admin/contractor-approvals/otitb');
    h.hasPageEdit.mockImplementation(async (_r: string, key: string) =>
      key === '/admin/contractor-approvals/otitb');
  });

  it('каталог видов отдаётся без программы А (она только для ИТР)', async () => {
    const res = makeRes();
    await contractorAdminController.otTrainingCatalog(req({}), res as never);

    expect(res.statusCode).toBe(200);
    const kinds = (res.body as { data: Array<{ kind: string }> }).data.map(d => d.kind);
    expect(kinds).toContain('introductory');
    expect(kinds).not.toContain('program_a');
  });

  it('без гранта — 403 на каталог и PATCH', async () => {
    h.hasPageView.mockResolvedValue(false);
    h.hasPageEdit.mockResolvedValue(false);

    const catalogRes = makeRes();
    await contractorAdminController.otTrainingCatalog(req({}), catalogRes as never);
    expect(catalogRes.statusCode).toBe(403);

    const patchRes = makeRes();
    await contractorAdminController.updateInductedPersonHandler(
      req({ trainings: {}, expected_updated_at: 'r1' }, { id: PERSON }),
      patchRes as never,
    );
    expect(patchRes.statusCode).toBe(403);
    expect(h.updateInductedPerson).not.toHaveBeenCalled();
  });

  it('back-compat: старое тело { inducted_on } создаёт вид introductory', async () => {
    h.createInductedPerson.mockResolvedValue({ id: PERSON, diff: {} });
    const res = makeRes();

    await contractorAdminController.addInductedPerson(
      req({ org_department_id: ORG, full_name: 'Иванов И.И.', inducted_on: '2026-07-01' }),
      res as never,
    );

    expect(res.statusCode).toBe(200);
    expect(h.createInductedPerson).toHaveBeenCalledWith(
      expect.objectContaining({ trainings: { introductory: '2026-07-01' } }),
    );
  });

  it('inducted_on и trainings.introductory с разными датами — 400, а не тихий выбор одной', async () => {
    const res = makeRes();

    await contractorAdminController.addInductedPerson(
      req({
        org_department_id: ORG,
        full_name: 'Иванов И.И.',
        inducted_on: '2026-07-01',
        trainings: { introductory: '2026-07-02' },
      }),
      res as never,
    );

    expect(res.statusCode).toBe(400);
    expect(h.createInductedPerson).not.toHaveBeenCalled();
  });

  it('дата обучения в будущем — 400, сервис не вызывается', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-24T12:00:00+03:00'));
    const res = makeRes();

    await contractorAdminController.addInductedPerson(
      req({ org_department_id: ORG, full_name: 'Иванов И.И.', trainings: { introductory: '2026-07-25' } }),
      res as never,
    );

    expect(res.statusCode).toBe(400);
    expect(h.createInductedPerson).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('вид, который ведут кадры по своим сотрудникам, в подрядчицком payload — 400', async () => {
    for (const kind of ['workplace', 'program_a', 'cross_profession']) {
      const res = makeRes();

      await contractorAdminController.addInductedPerson(
        req({ org_department_id: ORG, full_name: 'Иванов И.И.', trainings: { [kind]: '2026-07-01' } }),
        res as never,
      );

      expect(res.statusCode).toBe(400);
    }
    expect(h.createInductedPerson).not.toHaveBeenCalled();
  });

  it('устаревшая ревизия — 409 с понятным текстом', async () => {
    h.updateInductedPerson.mockResolvedValue({ status: 'conflict' });
    const res = makeRes();

    await contractorAdminController.updateInductedPersonHandler(
      req({ trainings: { introductory: '2026-07-01' }, expected_updated_at: 'r1' }, { id: PERSON }),
      res as never,
    );

    expect(res.statusCode).toBe(409);
    expect(h.logFromRequest).not.toHaveBeenCalled();
  });

  it('PATCH без изменений — 200 без записи в аудит', async () => {
    h.updateInductedPerson.mockResolvedValue({ status: 'ok', diff: {}, nameFrom: null });
    const res = makeRes();

    await contractorAdminController.updateInductedPersonHandler(
      req({ trainings: { introductory: '2026-07-01' }, expected_updated_at: 'r1' }, { id: PERSON }),
      res as never,
    );

    expect(res.statusCode).toBe(200);
    expect(h.logFromRequest).not.toHaveBeenCalled();
  });

  it('DELETE архивирует и пишет полный снимок в аудит', async () => {
    h.archiveInductedPerson.mockResolvedValue({
      id: PERSON,
      full_name: 'Иванов И.И.',
      org_department_id: ORG,
      trainings: { introductory: '2026-07-01' },
    });
    const res = makeRes();

    await contractorAdminController.deleteInductedPerson(req({}, { id: PERSON }), res as never);

    expect(res.statusCode).toBe(200);
    expect(h.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'u-1', 'CONTRACTOR_OT_PERSON_ARCHIVED',
      expect.objectContaining({
        entityId: PERSON,
        details: expect.objectContaining({ trainings: { introductory: '2026-07-01' } }),
      }),
    );
  });

  it('архивирование чужой записи — 404', async () => {
    h.archiveInductedPerson.mockResolvedValue(null);
    const res = makeRes();

    await contractorAdminController.deleteInductedPerson(req({}, { id: PERSON }), res as never);

    expect(res.statusCode).toBe(404);
    expect(h.logFromRequest).not.toHaveBeenCalled();
  });

  it('счётчики организаций включают «есть замечания»', async () => {
    h.countInductionByOrg.mockResolvedValue(new Map([[ORG, { total: 4, alert: 2, warning: 1 }]]));
    const res = makeRes();

    await contractorAdminController.listInductionOrgs(req({}), res as never);

    expect(res.body).toMatchObject({
      data: [expect.objectContaining({ id: ORG, inducted_count: 4, alert_count: 2, warning_count: 1 })],
    });
  });
});

describe('contractorAdminController — статистика пропусков (период + детализация)', () => {
  const ORG = '11111111-1111-1111-1111-111111111111';

  const statsReq = (query: Record<string, string> = {}) => ({
    user: { id: 'admin-1', company_scope: { roots: 'all' } },
    params: {},
    query,
    ip: '127.0.0.1',
    headers: {},
    socket: {},
  }) as never;

  /** makeRes + setHeader/send для xlsx-экспорта. */
  const makeExportRes = () => {
    const res = {
      statusCode: 200,
      body: null as unknown,
      sent: null as Buffer | null,
      headersSent: false,
      status: vi.fn(function (this: { statusCode: number }, c: number) { this.statusCode = c; return res; }),
      json: vi.fn(function (this: { body: unknown }, b: unknown) { this.body = b; return res; }),
      setHeader: vi.fn(),
      send: vi.fn(function (this: { sent: Buffer | null }, b: Buffer) { this.sent = b; return res; }),
    };
    return res;
  };

  const statRow = (over: Partial<Record<string, unknown>> = {}) => ({
    org_department_id: ORG, issued_new: 3, active_new: 2, old_total: 1, old_used: 0, ...over,
  });

  beforeEach(() => {
    Object.values(h).forEach(fn => fn.mockReset());
    h.resolveCompanyScope.mockResolvedValue({ roots: 'all' });
    h.getContractorOrgs.mockResolvedValue([{ id: ORG, name: 'АЛЬФА ООО', sigur_department_id: 1 }]);
    h.query.mockResolvedValue([]);
  });

  it('passStats без периода: параметры [orgIds, 14, null, null], SQL с независимыми границами', async () => {
    h.query.mockResolvedValueOnce([statRow()]);
    const res = makeRes();
    await contractorAdminController.passStats(statsReq(), res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: [expect.objectContaining({ issued_new: 3 })] });
    const [sql, params] = h.query.mock.calls[0];
    expect(params).toEqual([[ORG], 14, null, null]);
    expect(sql).toContain("$3::date IS NULL OR (h.approved_at AT TIME ZONE 'Europe/Moscow')::date >= $3::date");
    expect(sql).toContain("$4::date IS NULL OR (h.approved_at AT TIME ZONE 'Europe/Moscow')::date <= $4::date");
  });

  it('passStats с периодом и односторонними границами: даты уходят в SQL-параметры', async () => {
    const res1 = makeRes();
    await contractorAdminController.passStats(
      statsReq({ date_from: '2026-07-01', date_to: '2026-07-31' }), res1 as never);
    expect(h.query.mock.calls[0][1]).toEqual([[ORG], 14, '2026-07-01', '2026-07-31']);

    const res2 = makeRes();
    await contractorAdminController.passStats(statsReq({ date_from: '2026-07-01' }), res2 as never);
    expect(h.query.mock.calls[1][1]).toEqual([[ORG], 14, '2026-07-01', null]);

    const res3 = makeRes();
    await contractorAdminController.passStats(statsReq({ date_to: '2026-07-31' }), res3 as never);
    expect(h.query.mock.calls[2][1]).toEqual([[ORG], 14, null, '2026-07-31']);
  });

  it('passStats: 400 на несуществующую дату, год 0000 и from > to', async () => {
    for (const query of [
      { date_from: '2026-02-31' },
      { date_to: '0000-01-01' },
      { date_from: '2026-08-01', date_to: '2026-07-01' },
      { date_from: '31.07.2026' },
    ]) {
      const res = makeRes();
      await contractorAdminController.passStats(statsReq(query), res as never);
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({ error: 'Некорректный период' });
    }
    expect(h.query).not.toHaveBeenCalled();
  });

  it('passStatsDetails: 400 без организации и при неверном периоде', async () => {
    const noOrg = makeRes();
    await contractorAdminController.passStatsDetails(statsReq(), noOrg as never);
    expect(noOrg.statusCode).toBe(400);
    expect(noOrg.body).toMatchObject({ error: 'Некорректная организация' });

    const badPeriod = makeRes();
    await contractorAdminController.passStatsDetails(
      statsReq({ org_department_id: ORG, date_from: '2026-13-01' }), badPeriod as never);
    expect(badPeriod.statusCode).toBe(400);
    expect(badPeriod.body).toMatchObject({ error: 'Некорректный период' });
  });

  it('passStatsDetails: w26 из card_uid, null без карты; без периода параметры [orgIds, null, null]', async () => {
    h.query.mockResolvedValueOnce([
      { pass_id: 'p1', org_name: 'АЛЬФА ООО', pass_number: '101', holder_name: 'Иванов И.', card_uid: '168,15956', issued_on: '2026-07-10' },
      { pass_id: 'p2', org_name: 'АЛЬФА ООО', pass_number: '102', holder_name: 'Петров П.', card_uid: null, issued_on: '2026-07-11' },
    ]);
    const res = makeRes();
    await contractorAdminController.passStatsDetails(statsReq({ org_department_id: ORG }), res as never);
    expect(res.statusCode).toBe(200);
    expect(h.query.mock.calls[0][1]).toEqual([[ORG], null, null]);
    expect(res.body).toMatchObject({
      success: true,
      data: [
        { pass_id: 'p1', pass_number: '101', holder_name: 'Иванов И.', w26: '168,15956', issued_on: '2026-07-10' },
        { pass_id: 'p2', pass_number: '102', holder_name: 'Петров П.', w26: null, issued_on: '2026-07-11' },
      ],
    });
  });

  it('exportPassStats: 400 при неверном периоде (текст отличается от организации)', async () => {
    const res = makeExportRes();
    await contractorAdminController.exportPassStats(
      statsReq({ date_from: '2026-02-31' }), res as never);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'Некорректный период' });
  });

  it('exportPassStats: детализация на том же листе через пустую строку, active_new>0 при issued_new=0 не отфильтровывается', async () => {
    // 1-й query — сводка, 2-й — точки доступа, 3-й — детализация.
    h.query
      .mockResolvedValueOnce([statRow({ issued_new: 0, active_new: 5, old_total: 0, old_used: 0 })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { pass_id: 'p1', org_name: 'АЛЬФА ООО', pass_number: '101', holder_name: 'Иванов И.', card_uid: '168,15956', issued_on: '2026-07-10' },
      ]);
    const res = makeExportRes();
    await contractorAdminController.exportPassStats(
      statsReq({ date_from: '2026-07-01', date_to: '2026-07-31' }), res as never);

    expect(res.statusCode).toBe(200);
    expect(h.query.mock.calls[0][1]).toEqual([[ORG], 14, '2026-07-01', '2026-07-31']);
    expect(h.query.mock.calls[1][1]).toEqual([[ORG]]);
    expect(h.query.mock.calls[2][1]).toEqual([[ORG], '2026-07-01', '2026-07-31']);
    // Период в имени файла.
    const disposition = res.setHeader.mock.calls
      .find(c => c[0] === 'Content-Disposition')?.[1] as string;
    expect(decodeURIComponent(disposition)).toContain('_2026-07-01_2026-07-31.xlsx');

    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.sent as Buffer as never);
    expect(wb.worksheets.map(ws => ws.name)).toEqual(['Статистика']);
    const stat = wb.getWorksheet('Статистика')!;
    // Сводка: подрядчик с active_new=5 и issued_new=0 присутствует.
    expect(stat.getRow(2).getCell(1).value).toBe('АЛЬФА ООО');
    expect(stat.getRow(2).getCell(3).value).toBe(5);
    // Через пустую строку — шапка детализации и строки: ФИО / № ФОТ / W26 / дата.
    expect(stat.getRow(3).values).toEqual([]);
    expect(stat.getRow(4).values).toEqual(
      [undefined, 'Подрядчик', 'ФИО', '№ пропуска ФОТ', '№ Sigur (W26)', 'Дата выдачи']);
    expect(stat.getRow(5).values).toEqual(
      [undefined, 'АЛЬФА ООО', 'Иванов И.', '101', '168,15956', '2026-07-10']);
  });

  const apRow = (over: Partial<Record<string, unknown>> = {}) => ({
    org_department_id: ORG,
    active_total: 160,
    points: [
      { access_point_name: 'кпп ASTERUS', passes_count: 160 },
      { access_point_name: 'ЗилАрт Штаб', passes_count: 13 },
      { access_point_name: null, passes_count: 7 },
    ],
    ...over,
  });

  it('passAccessPointStats: разбивка по точкам, база — is_active, btrim + count(DISTINCT)', async () => {
    h.query.mockResolvedValueOnce([apRow()]);
    const res = makeRes();
    await contractorAdminController.passAccessPointStats(
      statsReq({ org_department_id: ORG }), res as never);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      data: [{
        org_department_id: ORG,
        active_total: 160,
        points: [
          { access_point_name: 'кпп ASTERUS', passes_count: 160 },
          { access_point_name: 'ЗилАрт Штаб', passes_count: 13 },
          { access_point_name: null, passes_count: 7 },
        ],
      }],
    });
    const [sql, params] = h.query.mock.calls[0];
    expect(params).toEqual([[ORG]]);
    // База совпадает с active_new в сводке; период не участвует.
    expect(sql).toContain('AND p.is_active');
    expect(sql).not.toContain('Europe/Moscow');
    // Нормализация имён и защита от двойного счёта одного пропуска.
    expect(sql).toContain('SELECT DISTINCT btrim(u.name)');
    expect(sql).toContain('count(DISTINCT pass_id)::int AS passes_count');
    // Разбивка считается по каждому подрядчику отдельно.
    expect(sql).toContain('GROUP BY oid, access_point_name');
    // «Без точек» всегда последним — сортировка внутри jsonb_agg.
    expect(sql).toContain('ORDER BY (g.access_point_name IS NULL), g.passes_count DESC');
  });

  it('passAccessPointStats: без org — по всем подрядчикам из getContractorOrgs', async () => {
    h.query.mockResolvedValueOnce([apRow()]);
    const res = makeRes();
    await contractorAdminController.passAccessPointStats(statsReq(), res as never);
    expect(res.statusCode).toBe(200);
    expect(h.getContractorOrgs).toHaveBeenCalled();
    expect(h.query.mock.calls[0][1]).toEqual([[ORG]]);
  });

  it('passAccessPointStats: подрядчик без активных пропусков — 200 с пустым data', async () => {
    // Организации без активных пропусков в выдачу SQL не попадают вовсе.
    h.query.mockResolvedValueOnce([]);
    const res = makeRes();
    await contractorAdminController.passAccessPointStats(
      statsReq({ org_department_id: ORG }), res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: [] });
  });

  it('passAccessPointStats: 400 при невалидном org_department_id', async () => {
    const res = makeRes();
    await contractorAdminController.passAccessPointStats(
      statsReq({ org_department_id: 'not-a-uuid' }), res as never);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'Некорректная организация' });
    expect(h.query).not.toHaveBeenCalled();
  });

  it('exportPassStats: точки доступа — свёрнутая группа строк под подрядчиком, в обоих режимах', async () => {
    const points = [
      { access_point_name: 'кпп ASTERUS', passes_count: 2 },
      { access_point_name: null, passes_count: 1 },
    ];
    h.query
      .mockResolvedValueOnce([statRow({ issued_new: 2, active_new: 2 })])
      .mockResolvedValueOnce([apRow({ active_total: 2, points })])
      .mockResolvedValueOnce([]);
    const withOrg = makeExportRes();
    await contractorAdminController.exportPassStats(
      statsReq({ org_department_id: ORG }), withOrg as never);
    expect(withOrg.statusCode).toBe(200);

    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(withOrg.sent as Buffer as never);
    const stat = wb.getWorksheet('Статистика')!;
    // «+» рисуется у родительской строки (она выше группы), а не под ней.
    expect(stat.properties.outlineProperties?.summaryBelow).toBe(false);
    expect(stat.getRow(2).getCell(1).value).toBe('АЛЬФА ООО');
    // Точки — под строкой подрядчика: имя с отступом в A, число активных в C.
    expect(String(stat.getRow(3).getCell(1).value).trim()).toBe('кпп ASTERUS');
    expect(stat.getRow(3).getCell(3).value).toBe(2);
    expect(stat.getRow(3).outlineLevel).toBe(1);
    expect(stat.getRow(3).hidden).toBe(true);
    expect(String(stat.getRow(4).getCell(1).value).trim()).toBe('Без точек');
    expect(stat.getRow(4).getCell(3).value).toBe(1);
    expect(stat.getRow(4).outlineLevel).toBe(1);
    expect(String(stat.getRow(5).getCell(1).value)).toContain('раскрываются кнопкой «+»');

    // Режим «все подрядчики» — точки запрашиваются по всем организациям, а не пропускаются.
    h.query
      .mockResolvedValueOnce([statRow()])
      .mockResolvedValueOnce([apRow({ active_total: 2, points })])
      .mockResolvedValueOnce([]);
    const allOrgs = makeExportRes();
    await contractorAdminController.exportPassStats(statsReq(), allOrgs as never);
    expect(allOrgs.statusCode).toBe(200);
    expect(h.query.mock.calls[4][1]).toEqual([[ORG]]);
  });
});
