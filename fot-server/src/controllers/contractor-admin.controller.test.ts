import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  queryOne: vi.fn(),
  query: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
  resolveCompanyScope: vi.fn(),
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
}));

vi.mock('../config/postgres.js', () => ({
  queryOne: h.queryOne,
  query: h.query,
  execute: h.execute,
  withTransaction: h.withTransaction,
}));
vi.mock('../services/data-scope.service.js', () => ({ resolveCompanyScope: h.resolveCompanyScope }));
vi.mock('../services/audit.service.js', () => ({
  auditService: { logFromRequest: h.logFromRequest },
  AUDIT_ACTIONS: {
    CONTRACTOR_SUBMISSION_APPROVED: 'CONTRACTOR_SUBMISSION_APPROVED',
    CONTRACTOR_SUBMISSION_REJECTED: 'CONTRACTOR_SUBMISSION_REJECTED',
    CONTRACTOR_SUBMISSION_PASS_DECIDED: 'CONTRACTOR_SUBMISSION_PASS_DECIDED',
  },
}));
vi.mock('../config/contractor.js', () => ({
  isContractorSigurDryRun: h.isDryRun,
  getContractorRootId: vi.fn(),
  CONTRACTOR_ROOT_NAME: 'подрядные организации',
}));
vi.mock('../services/sigur.service.js', () => ({ sigurService: { getBackgroundConnectionType: h.bgConn } }));
vi.mock('../services/sigur-live-employees-crud.service.js', () => ({
  deleteSigurEmployee: h.delEmp,
  updateSigurEmployee: h.updEmp,
  createSigurEmployee: h.createEmp,
}));
vi.mock('../services/sigur-live-cards.service.js', () => ({
  assignSigurEmployeeCardBinding: h.assignCard,
  replaceSigurEmployeeAccessPoints: h.replaceAP,
}));
vi.mock('../services/contractor-access.service.js', () => ({
  resolveAccessPointNamesToIds: h.resolveAP,
}));
vi.mock('../services/contractor-scope.service.js', () => ({
  getContractorOrgs: vi.fn(),
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
        submission_id: 'sub-1', access_point_names: null, card_uid: '168,15956' },
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
        submission_id: 'sub-1', access_point_names: null, card_uid: '168,15956' },
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
        submission_id: 'sub-1', access_point_names: null, card_uid: '168,15956' },
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
        submission_id: 'sub-1', access_point_names: null, card_uid: '168,15956' },
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
          submission_id: 'sub-1', access_point_names: null, card_uid: '168,15956' },
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
        submission_id: 'sub-1', access_point_names: null, card_uid: '168,15956' },
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
        submission_id: 'sub-1', access_point_names: null, card_uid: '168,15956' },
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

    expect(h.applyDismissal).toHaveBeenCalled();
    expect(h.insertDismissalHistory).toHaveBeenCalled();
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
