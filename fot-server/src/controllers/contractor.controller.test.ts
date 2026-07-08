import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

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
const PATENT_SET = new Set(['УЗБЕКИСТАН', 'ТАДЖИКИСТАН', 'УКРАИНА', 'АЗЕРБАЙДЖАН', 'МОЛДОВА', 'ТУРКМЕНИСТАН']);
vi.mock('../services/contractor-docs.service.js', () => ({
  CONTRACTOR_DOCUMENT_DUPLICATE: 'CONTRACTOR_DOCUMENT_DUPLICATE',
  CONTRACTOR_DOCUMENTS_INCOMPLETE: 'CONTRACTOR_DOCUMENTS_INCOMPLETE',
  duplicateMessage: () => 'dup',
  findOrgDocDuplicate: h.findDup,
  isDocsComplete: h.isDocsComplete,
  citizenshipRequiresPatent: (c: string | null | undefined) => !!c && PATENT_SET.has(c.trim().toUpperCase()),
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

const runSave = async (
  passRow: { status: string; approval_status: string },
  bodyOverride?: Record<string, unknown>,
) => {
  const updateCalls: string[] = [];
  const updateParams: unknown[][] = [];
  h.resolveOrg.mockResolvedValue(ORG);
  h.findDup.mockResolvedValue(null);
  h.isDocsComplete.mockReturnValue(true);
  h.withTransaction.mockImplementation(async (cb: (c: unknown) => Promise<unknown>) => {
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (/UPDATE contractor_passes/i.test(sql)) {
          updateCalls.push(sql);
          updateParams.push(params ?? []);
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
    body: bodyOverride ?? { passport_series_number: '1234 567890', citizenship: 'Россия', passport_issue_date: '2020-01-01', birth_date: '1990-01-01' },
  } as never;
  const res = makeRes();
  await contractorController.savePassDocuments(req, res as never);
  return { res, updateCalls, updateParams };
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

// Порядок параметров UPDATE: $5 patent_number, $8 has_residence_permit, $9 residence_permit_number.
describe('savePassDocuments — ВНЖ / патент взаимоисключение', () => {
  beforeEach(() => vi.clearAllMocks());

  it('патентная страна + ВНЖ → has_residence_permit=true, номер сохранён, патент обнулён', async () => {
    const { res, updateParams } = await runSave(
      { status: 'assigned', approval_status: 'not_submitted' },
      { passport_series_number: '1234 567890', passport_issue_date: '2020-01-01', birth_date: '1990-01-01',
        citizenship: 'Узбекистан', patent_number: '77 №2600295204',
        has_residence_permit: true, residence_permit_number: '82№1234567' },
    );
    expect(res.statusCode).toBe(200);
    const p = updateParams[0];
    expect(p[4]).toBeNull();            // patent_number обнулён
    expect(p[7]).toBe(true);            // has_residence_permit
    expect(p[8]).toBe('82№1234567');    // residence_permit_number
  });

  it('смена гражданства на непатентное (Беларусь) сбрасывает ВНЖ (effHasVnzh)', async () => {
    const { res, updateParams } = await runSave(
      { status: 'assigned', approval_status: 'not_submitted' },
      { passport_series_number: '1234 567890', passport_issue_date: '2020-01-01', birth_date: '1990-01-01',
        citizenship: 'Беларусь', has_residence_permit: true, residence_permit_number: '82№1234567' },
    );
    expect(res.statusCode).toBe(200);
    const p = updateParams[0];
    expect(p[7]).toBe(false);           // has_residence_permit сброшен
    expect(p[8]).toBeNull();            // residence_permit_number обнулён
  });
});

// Регрессия: submit-гейт полноты должен видеть ВНЖ. Раньше SELECT eligibleRows не
// доставал has_residence_permit / residence_permit_number, и isDocsComplete для
// патентной страны требовал патент — держатель с ВНЖ не мог отправить заявку.
// Тест гоняет submit с НАСТОЯЩИМ isDocsComplete (не мок), чтобы проверить именно гейт.
describe('submit — гейт полноты учитывает ВНЖ', () => {
  type DocsModule = typeof import('../services/contractor-docs.service.js');
  let realIsDocsComplete: DocsModule['isDocsComplete'];

  beforeAll(async () => {
    const actual = await vi.importActual<DocsModule>('../services/contractor-docs.service.js');
    realIsDocsComplete = actual.isDocsComplete;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    h.isDocsComplete.mockImplementation((r: unknown) => realIsDocsComplete(r as never));
  });

  // Готовый к отправке пропуск: патентная страна + ВНЖ + номер, патент пустой.
  const vnzhRow = (residence_permit_number: string | null) => ({
    pass_number: '2857', holder_name: 'Розлован Генадие',
    passport_series_number: 'АР 0020125', passport_issue_date: '2023-04-13', birth_date: '1984-12-26',
    citizenship: 'Молдова',
    patent_number: null, patent_issue_date: null, patent_blank_number: null,
    has_residence_permit: true, residence_permit_number,
  });

  const runSubmit = async (rows: Array<Record<string, unknown>>) => {
    h.resolveOrg.mockResolvedValue(ORG);
    h.queryOne.mockResolvedValue(null);        // нет pending-заявки
    h.query.mockResolvedValue(rows);           // eligibleRows
    h.withTransaction.mockImplementation(async (cb: (c: unknown) => Promise<unknown>) => {
      const client = { query: vi.fn(async () => ({ rows: [{ id: 'sub-1' }], rowCount: 1 })) };
      return cb(client);
    });
    const req = { user: { id: 'user-1' }, params: {}, body: {} } as never;
    const res = makeRes();
    await contractorController.submit(req, res as never);
    return { res };
  };

  it('ВНЖ-пропуск с номером считается полным → заявка уходит (200)', async () => {
    const { res } = await runSubmit([vnzhRow('83 1242720')]);
    expect(res.statusCode).toBe(200);
    expect((res.body as { success?: boolean }).success).toBe(true);
    // Гард против регрессии SELECT: колонки ВНЖ обязаны попасть в выборку.
    const sql = h.query.mock.calls[0][0] as string;
    expect(sql).toContain('has_residence_permit');
    expect(sql).toContain('residence_permit_number');
  });

  it('ВНЖ отмечен, но номер пуст → комплект неполный, заявка отклонена (409)', async () => {
    const { res } = await runSubmit([vnzhRow(null)]);
    expect(res.statusCode).toBe(409);
    expect((res.body as { code?: string }).code).toBe('CONTRACTOR_DOCUMENTS_INCOMPLETE');
  });
});
