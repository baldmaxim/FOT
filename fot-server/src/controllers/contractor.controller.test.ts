import { describe, it, expect, vi, beforeEach } from 'vitest';

// Моки внешних зависимостей контроллера подрядчика. Цель тестов — гард read-only
// документов в savePassDocuments: поданный пропуск (status='submitted') нельзя править,
// а 'assigned' и 'blocked' (смена владельца) — можно.
const h = vi.hoisted(() => ({
  resolveOrg: vi.fn(),
  withTransaction: vi.fn(),
  queryOne: vi.fn(),
  query: vi.fn(),
  execute: vi.fn(),
  findDup: vi.fn(),
  isDocsComplete: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: h.query,
  queryOne: h.queryOne,
  execute: h.execute,
  withTransaction: h.withTransaction,
}));
vi.mock('../services/contractor-scope.service.js', () => ({
  resolveContractorOrgForUser: h.resolveOrg,
}));
vi.mock('../services/audit.service.js', () => ({
  auditService: { logFromRequest: vi.fn() },
  AUDIT_ACTIONS: {},
}));
vi.mock('../services/contractor-roster.service.js', () => ({
  syncRosterFromSigur: vi.fn(),
  getRoster: vi.fn(),
  getPasses: vi.fn(),
}));
vi.mock('../services/sigur.service.js', () => ({
  sigurService: { getBackgroundConnectionType: vi.fn() },
}));
vi.mock('../config/contractor.js', () => ({
  isContractorSigurDryRun: vi.fn().mockReturnValue(true),
}));
vi.mock('../services/sigur-live-employees-crud.service.js', () => ({
  updateSigurEmployee: vi.fn(),
}));
vi.mock('../services/contractor-documents.service.js', () => ({
  deleteOrgDocument: vi.fn(),
  getOrgDocumentDownloadUrl: vi.fn(),
  listOrgDocuments: vi.fn(),
  uploadOrgDocument: vi.fn(),
}));
vi.mock('../services/contractor-docs.service.js', () => ({
  CONTRACTOR_DOCUMENT_DUPLICATE: 'CONTRACTOR_DOCUMENT_DUPLICATE',
  CONTRACTOR_DOCUMENTS_INCOMPLETE: 'CONTRACTOR_DOCUMENTS_INCOMPLETE',
  duplicateMessage: () => 'dup',
  findOrgDocDuplicate: h.findDup,
  isDocsComplete: h.isDocsComplete,
}));
vi.mock('../utils/multer-filename.utils.js', () => ({ decodeMulterFilename: (s: string) => s }));

import { contractorController } from './contractor.controller.js';

const ORG = '11111111-1111-1111-1111-111111111111';
const PASS = '22222222-2222-2222-2222-222222222222';

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status: vi.fn(function (this: typeof res, c: number) { this.statusCode = c; return this; }),
    json: vi.fn(function (this: typeof res, b: unknown) { this.body = b; return this; }),
  };
  return res;
};

const runSave = async (passRow: { status: string; approval_status: string }) => {
  const updateCalls: string[] = [];
  h.resolveOrg.mockResolvedValue(ORG);
  h.findDup.mockResolvedValue(null);
  h.isDocsComplete.mockReturnValue(true);
  h.withTransaction.mockImplementation(async (cb: (c: unknown) => Promise<unknown>) => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (/UPDATE contractor_passes/i.test(sql)) {
          updateCalls.push(sql);
          return { rows: [], rowCount: 1 };
        }
        return { rows: [{ id: PASS, ...passRow }], rowCount: 1 };
      }),
    };
    return cb(client);
  });

  const req = {
    user: { id: 'user-1' },
    params: { id: PASS },
    body: { passport_series_number: '1234 567890', citizenship: 'Россия', passport_issue_date: '2020-01-01', birth_date: '1990-01-01' },
  } as never;
  const res = makeRes();
  await contractorController.savePassDocuments(req, res as never);
  return { res, updateCalls };
};

describe('savePassDocuments — read-only гард по статусу', () => {
  beforeEach(() => vi.clearAllMocks());

  it('блокирует правку поданного пропуска (status=submitted) → 409, без UPDATE', async () => {
    const { res, updateCalls } = await runSave({ status: 'submitted', approval_status: 'pending' });
    expect(res.statusCode).toBe(409);
    expect((res.body as { error?: string }).error).toContain('на согласовании');
    expect(updateCalls).toHaveLength(0);
  });

  it('разрешает правку назначенного пропуска (status=assigned) → success + UPDATE', async () => {
    const { res, updateCalls } = await runSave({ status: 'assigned', approval_status: 'not_submitted' });
    expect(res.statusCode).toBe(200);
    expect((res.body as { success?: boolean }).success).toBe(true);
    expect(updateCalls).toHaveLength(1);
  });

  it('разрешает ввод документов при смене владельца (status=blocked) → success + UPDATE', async () => {
    const { res, updateCalls } = await runSave({ status: 'blocked', approval_status: 'pending' });
    expect(res.statusCode).toBe(200);
    expect((res.body as { success?: boolean }).success).toBe(true);
    expect(updateCalls).toHaveLength(1);
  });

  it('по-прежнему блокирует согласованный пропуск (approval_status=approved) → 409', async () => {
    const { res, updateCalls } = await runSave({ status: 'applied', approval_status: 'approved' });
    expect(res.statusCode).toBe(409);
    expect(updateCalls).toHaveLength(0);
  });
});
