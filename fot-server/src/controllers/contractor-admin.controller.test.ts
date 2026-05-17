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
  AUDIT_ACTIONS: { CONTRACTOR_SUBMISSION_APPROVED: 'CONTRACTOR_SUBMISSION_APPROVED' },
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
      { pass_id: 'p1', pass_status: 'assigned', pass_sigur_id: 11, holder_name: 'Иванов И.', access_point_names: null },
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
      { pass_id: 'p1', pass_status: 'assigned', pass_sigur_id: 11, holder_name: 'A', access_point_names: null },
      { pass_id: 'p2', pass_status: 'assigned', pass_sigur_id: 12, holder_name: 'B', access_point_names: null },
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
      { pass_id: 'p1', pass_status: 'applied', pass_sigur_id: 11, holder_name: 'A', access_point_names: null },
      { pass_id: 'p2', pass_status: 'assigned', pass_sigur_id: 12, holder_name: 'B', access_point_names: null },
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
      { pass_id: 'p1', pass_status: 'assigned', pass_sigur_id: 11, holder_name: 'A', access_point_names: ['КПП 1', 'КПП X'] },
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
      { pass_id: 'p1', pass_status: 'assigned', pass_sigur_id: 11, holder_name: 'A', access_point_names: ['КПП 1'] },
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
});
