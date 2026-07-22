/**
 * Гейт доступа к пулу пропусков: pool-контроллер подключает
 * ensureContractorSectionAccess отдельно от admin-контроллера, поэтому
 * раскладка view/edit проверяется здесь напрямую.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  resolveCompanyScope: vi.fn(),
  hasPageView: vi.fn(),
  hasPageEdit: vi.fn(),
  getPoolMatrix: vi.fn(),
  assignPoolPassesToContractor: vi.fn(),
  logFromRequest: vi.fn(),
}));

vi.mock('../services/data-scope.service.js', () => ({ resolveCompanyScope: h.resolveCompanyScope }));
vi.mock('../services/access-control.service.js', () => ({
  hasPageView: h.hasPageView,
  hasPageEdit: h.hasPageEdit,
}));
vi.mock('../services/contractor-pool.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/contractor-pool.service.js')>()),
  getPoolMatrix: h.getPoolMatrix,
  assignPoolPassesToContractor: h.assignPoolPassesToContractor,
}));
vi.mock('../services/audit.service.js', () => ({
  auditService: { logFromRequest: h.logFromRequest },
  AUDIT_ACTIONS: new Proxy({}, { get: (_t, p) => String(p) }),
}));
vi.mock('../services/contractor-pass-sync.scheduler.js', () => ({
  kickContractorPassSync: vi.fn(),
}));

import { contractorPoolController } from './contractor-pool.controller.js';

const SECTION = '/admin/contractor-approvals';

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
  user: { id: 'u-1', role_code: 'security', is_admin: false },
  params: {},
  query: {},
  body: {
    pass_ids: ['11111111-1111-1111-1111-111111111111'],
    org_department_id: '22222222-2222-2222-2222-222222222222',
  },
  ip: '127.0.0.1',
  headers: {},
  socket: {},
}) as never;

describe('contractorPoolController — доступ по гранту страницы', () => {
  beforeEach(() => {
    Object.values(h).forEach(fn => fn.mockReset());
    h.resolveCompanyScope.mockResolvedValue({ roots: [] });
    h.logFromRequest.mockResolvedValue(undefined);
    h.getPoolMatrix.mockResolvedValue({ cells: [], totals: { free: 0, occupied: 0, provisioning: 0, failed: 0 } });
    h.assignPoolPassesToContractor.mockResolvedValue({ assigned: [], failed: [] });
  });

  it('грант can_view: matrix отдаёт данные, assign закрыт', async () => {
    h.hasPageView.mockImplementation(async (_r: string, key: string) => key === SECTION);
    h.hasPageEdit.mockResolvedValue(false);

    const matrixRes = makeRes();
    await contractorPoolController.matrix(makeReq(), matrixRes as never);
    expect(matrixRes.statusCode).toBe(200);
    expect(h.getPoolMatrix).toHaveBeenCalled();

    const assignRes = makeRes();
    await contractorPoolController.assign(makeReq(), assignRes as never);
    expect(assignRes.statusCode).toBe(403);
    expect(h.assignPoolPassesToContractor).not.toHaveBeenCalled();
  });

  it('грант can_edit: assign проходит', async () => {
    h.hasPageView.mockImplementation(async (_r: string, key: string) => key === SECTION);
    h.hasPageEdit.mockImplementation(async (_r: string, key: string) => key === SECTION);

    const res = makeRes();
    await contractorPoolController.assign(makeReq(), res as never);
    expect(res.statusCode).toBe(200);
    expect(h.assignPoolPassesToContractor).toHaveBeenCalled();
  });

  it('компанийный админ: 403 на matrix', async () => {
    h.resolveCompanyScope.mockResolvedValue({ roots: ['root-1'] });
    h.hasPageView.mockResolvedValue(true);
    const req = { ...(makeReq() as object), user: { id: 'a-1', role_code: 'admin', is_admin: true } } as never;

    const res = makeRes();
    await contractorPoolController.matrix(req, res as never);
    expect(res.statusCode).toBe(403);
    expect(h.getPoolMatrix).not.toHaveBeenCalled();
  });
});
