/**
 * Документы и роль «Заместитель» (deputy_head, миграция 292).
 *
 * Документы коллег (расчётные листки, справки, вложения отпусков) роли закрыты: её
 * заместительские отделы не дают доступа к кадровым данным. Исключение — вложения
 * заявления «Корректировка табеля», по которому она решает: при галочке «Заявления» и
 * праве вести табель сотрудника.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

const { pgQuery, pgQueryOne, pgExecute, h } = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  pgQueryOne: vi.fn(),
  pgExecute: vi.fn(),
  h: {
    records: vi.fn(async () => false),
    tsEdit: vi.fn(async () => true),
    rolePage: vi.fn(async () => true),
  },
}));

vi.mock('../config/postgres.js', () => ({ query: pgQuery, queryOne: pgQueryOne, execute: pgExecute }));
vi.mock('../services/r2.service.js', () => ({
  r2Service: {
    isEnabledAsync: vi.fn(async () => true),
    generateDownloadUrl: vi.fn(async () => 'https://r2/url'),
  },
}));
vi.mock('../services/data-scope.service.js', () => ({
  canAccessEmployeeRecordsInScope: h.records,
  canEditEmployeeTimesheetInScope: h.tsEdit,
  canWriteEmployeeInScope: vi.fn(async () => false),
  resolveScopedDepartmentId: vi.fn(async () => null),
}));
vi.mock('../services/access-control.service.js', () => ({
  hasPageView: vi.fn(async () => false),
  resolveRolePageAccess: h.rolePage,
}));
vi.mock('../services/ai-receipt-recognition.service.js', () => ({ aiReceiptRecognitionService: { enqueueRecognition: vi.fn() } }));
vi.mock('../services/image-trim.service.js', () => ({ trimWhiteBorders: vi.fn() }));

import { documentsController } from './documents.controller.js';

const makeRes = () => {
  const res = { statusCode: 200, body: undefined as unknown, status: vi.fn(), json: vi.fn() } as unknown as Response & { statusCode: number; body: unknown };
  (res.status as unknown as ReturnType<typeof vi.fn>).mockImplementation((code: number) => { res.statusCode = code; return res; });
  (res.json as unknown as ReturnType<typeof vi.fn>).mockImplementation((body: unknown) => { res.body = body; return res; });
  return res;
};

const COLLEAGUE = 555;
const roleReq = (extra: Record<string, unknown> = {}): AuthenticatedRequest =>
  ({ user: { id: 'u1', employee_id: 7, role_code: 'deputy_head', is_admin: false }, params: {}, query: {}, body: {}, ...extra } as unknown as AuthenticatedRequest);

/** Документ коллеги и (опционально) заявление, к которому он приложен. */
const mockDb = (doc: Record<string, unknown>, request: { request_type: string } | null) => {
  pgQueryOne.mockImplementation(async (sql: string) => {
    const text = String(sql);
    if (text.includes('FROM documents WHERE id')) return doc;
    if (text.includes('FROM document_links')) return null;
    if (text.includes('FROM leave_requests')) {
      return request ? { id: 90, employee_id: COLLEAGUE, request_type: request.request_type } : null;
    }
    return null;
  });
};

const baseDoc = {
  id: 5, employee_id: COLLEAGUE, leave_request_id: null, r2_key: 'k', file_name: 'f.pdf',
  category: 'payslip', deleted_at: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  pgQuery.mockResolvedValue([]);
  h.records.mockResolvedValue(false);
  h.tsEdit.mockResolvedValue(true);
  h.rolePage.mockResolvedValue(true);
});

describe('скачивание документа коллеги', () => {
  it('расчётный листок коллеги — 403', async () => {
    mockDb(baseDoc, null);
    const res = makeRes();
    await documentsController.getDownloadUrl(roleReq({ params: { id: '5' } }), res);
    expect(res.statusCode).toBe(403);
  });

  it('вложение «Корректировки табеля» — доступно ведущему табель', async () => {
    mockDb({ ...baseDoc, category: 'scan', leave_request_id: 90 }, { request_type: 'time_correction' });
    const res = makeRes();
    await documentsController.getDownloadUrl(roleReq({ params: { id: '5' } }), res);
    expect(res.statusCode).toBe(200);
    expect(h.rolePage).toHaveBeenCalledWith(expect.anything(), '/leave-requests', 'view');
  });

  it('без галочки «Заявления» — 403', async () => {
    h.rolePage.mockResolvedValue(false);
    mockDb({ ...baseDoc, category: 'scan', leave_request_id: 90 }, { request_type: 'time_correction' });
    const res = makeRes();
    await documentsController.getDownloadUrl(roleReq({ params: { id: '5' } }), res);
    expect(res.statusCode).toBe(403);
  });

  it('без права вести табель сотрудника — 403', async () => {
    h.tsEdit.mockResolvedValue(false);
    mockDb({ ...baseDoc, category: 'scan', leave_request_id: 90 }, { request_type: 'time_correction' });
    const res = makeRes();
    await documentsController.getDownloadUrl(roleReq({ params: { id: '5' } }), res);
    expect(res.statusCode).toBe(403);
  });

  it('вложение больничного — 403', async () => {
    mockDb({ ...baseDoc, category: 'scan', leave_request_id: 90 }, { request_type: 'sick_leave' });
    const res = makeRes();
    await documentsController.getDownloadUrl(roleReq({ params: { id: '5' } }), res);
    expect(res.statusCode).toBe(403);
  });

  it('свой документ — 200', async () => {
    h.records.mockResolvedValue(true);
    mockDb({ ...baseDoc, employee_id: 7 }, null);
    const res = makeRes();
    await documentsController.getDownloadUrl(roleReq({ params: { id: '5' } }), res);
    expect(res.statusCode).toBe(200);
  });
});

describe('документы заявления коллеги', () => {
  it('отпуск — 403, «Корректировка табеля» — 200', async () => {
    mockDb(baseDoc, { request_type: 'vacation' });
    const res = makeRes();
    await documentsController.getByLeaveRequest(roleReq({ params: { leaveRequestId: '90' } }), res);
    expect(res.statusCode).toBe(403);

    mockDb(baseDoc, { request_type: 'time_correction' });
    const res2 = makeRes();
    await documentsController.getByLeaveRequest(roleReq({ params: { leaveRequestId: '90' } }), res2);
    expect(res2.statusCode).toBe(200);
  });

  it('документы сотрудника (карточка) — 403', async () => {
    const res = makeRes();
    await documentsController.getByEmployee(roleReq({ params: { empId: String(COLLEAGUE) } }), res);
    expect(res.statusCode).toBe(403);
  });
});
