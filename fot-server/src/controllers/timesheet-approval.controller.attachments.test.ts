import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * Служебка к подаче табеля: загрузка и удаление в открытом («Открыть табель») периоде.
 * Окончательное решение принимает сервис под блокировкой подачи — контроллер проверяет
 * доступ, переводит причину отказа в HTTP и не трогает R2/аудит при отказе.
 */

const DEPT = '3ad4aa9f-d988-4c49-bc52-abb74ef74bd9';

const { pgQueryOne, findOrCreateMock, createRecordMock, deleteRecordMock, r2Mock, auditMock } = vi.hoisted(() => ({
  pgQueryOne: vi.fn(),
  findOrCreateMock: vi.fn(),
  createRecordMock: vi.fn(),
  deleteRecordMock: vi.fn(),
  r2Mock: {
    isEnabledAsync: vi.fn(async () => true),
    uploadObject: vi.fn(async () => undefined),
    deleteObject: vi.fn(async () => undefined),
  },
  auditMock: vi.fn(async () => undefined),
}));

vi.mock('../config/postgres.js', async (importActual) => ({
  ...(await importActual<typeof import('../config/postgres.js')>()),
  query: vi.fn(async () => []),
  queryOne: pgQueryOne,
}));

vi.mock('../services/timesheet-approval-attachments.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/timesheet-approval-attachments.service.js')>()),
  findOrCreateDraftApproval: findOrCreateMock,
  createAttachmentRecord: createRecordMock,
  deleteAttachmentRecord: deleteRecordMock,
}));

vi.mock('../services/r2.service.js', () => ({ r2Service: r2Mock }));

vi.mock('../services/data-scope.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/data-scope.service.js')>()),
  resolveTimesheetEditableDepartmentIds: vi.fn(async () => [DEPT]),
}));

vi.mock('../services/audit.service.js', () => ({
  auditService: { logFromRequest: auditMock },
  AUDIT_ACTIONS: {
    TIMESHEET_APPROVAL_ATTACHMENT_UPLOADED: 'TIMESHEET_APPROVAL_ATTACHMENT_UPLOADED',
    TIMESHEET_APPROVAL_ATTACHMENT_DELETED: 'TIMESHEET_APPROVAL_ATTACHMENT_DELETED',
  },
}));
vi.mock('../services/realtime-broadcast.service.js', () => ({ emitDomainChange: vi.fn() }));
vi.mock('../middleware/cacheResponse.js', () => ({ invalidateCaches: vi.fn() }));

import { timesheetApprovalController } from './timesheet-approval.controller.js';

const UNLOCKED_AT = '2026-11-12T08:24:28.592Z';

const makeRes = () => {
  const res = { _status: 200, _json: undefined as unknown } as Record<string, unknown>;
  res.status = (code: number) => { res._status = code; return res; };
  res.json = (payload: unknown) => { res._json = payload; return res; };
  return res as unknown as { _status: number; _json: { success: boolean; error?: string } } & Parameters<
    typeof timesheetApprovalController.deleteAttachment
  >[1];
};

const user = { id: 'timekeeper-uuid', employee_id: 8954, is_admin: false, role_code: 'timekeeper' };

const makeUploadReq = () => ({
  params: {},
  query: {},
  body: { department_id: DEPT, start_date: '2026-10-16', end_date: '2026-10-31' },
  file: { originalname: 'Служебка.pdf', mimetype: 'application/pdf', size: 1234, buffer: Buffer.from('x') },
  user,
}) as unknown as Parameters<typeof timesheetApprovalController.uploadAttachment>[0];

const makeDeleteReq = (documentId = 900) => ({
  params: { document_id: String(documentId) },
  query: {},
  body: {},
  user,
}) as unknown as AuthenticatedRequest;

const approvalRow = (over: Record<string, unknown> = {}) => ({
  id: 2269,
  department_id: DEPT,
  manager_employee_id: null,
  start_date: '2026-10-16',
  end_date: '2026-10-31',
  status: 'approved',
  unlocked_at: UNLOCKED_AT,
  ...over,
});

const auditActions = () => auditMock.mock.calls.map(call => String((call as unknown[])[2]));

beforeEach(() => {
  vi.clearAllMocks();
  // loadApprovalById / link / org_departments для аудита — через queryOne.
  pgQueryOne.mockImplementation(async (sql: string) => {
    if (/FROM document_links/i.test(sql)) return { entity_id: '2269' };
    if (/FROM timesheet_approvals/i.test(sql)) return approvalRow();
    if (/FROM org_departments/i.test(sql)) return { name: 'бр.Мусоев М.Ш.' };
    return null;
  });
});

describe('uploadAttachment — служебка в открытом табеле', () => {
  it('согласованный и открытый период: файл сохранён, аудит записан', async () => {
    findOrCreateMock.mockResolvedValue({ id: 2269, status: 'approved', unlocked_at: UNLOCKED_AT });
    createRecordMock.mockResolvedValue({
      ok: true,
      attachment: { document_id: 900, file_name: 'Служебка.pdf' },
    });
    const res = makeRes();

    await timesheetApprovalController.uploadAttachment(makeUploadReq(), res);

    expect(res._status).toBe(200);
    expect(r2Mock.uploadObject).toHaveBeenCalledTimes(1);
    expect(r2Mock.deleteObject).not.toHaveBeenCalled();
    expect(auditActions()).toEqual(['TIMESHEET_APPROVAL_ATTACHMENT_UPLOADED']);
  });

  it('согласованный и не открытый: 409 до загрузки в R2', async () => {
    findOrCreateMock.mockResolvedValue({ id: 2269, status: 'approved', unlocked_at: null });
    const res = makeRes();

    await timesheetApprovalController.uploadAttachment(makeUploadReq(), res);

    expect(res._status).toBe(409);
    expect(r2Mock.uploadObject).not.toHaveBeenCalled();
    expect(createRecordMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('табель закрыли, пока файл грузился: объект удалён из R2, 409, аудита нет', async () => {
    findOrCreateMock.mockResolvedValue({ id: 2269, status: 'approved', unlocked_at: UNLOCKED_AT });
    createRecordMock.mockResolvedValue({ ok: false, reason: 'period_closed' });
    const res = makeRes();

    await timesheetApprovalController.uploadAttachment(makeUploadReq(), res);

    expect(res._status).toBe(409);
    expect(r2Mock.uploadObject).toHaveBeenCalledTimes(1);
    const uploadedKey = (r2Mock.uploadObject.mock.calls[0] as unknown[])[0];
    expect(r2Mock.deleteObject).toHaveBeenCalledWith(uploadedKey);
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe('deleteAttachment — решение сервиса под блокировкой', () => {
  it('файл после открытия, удаляет другой пользователь с доступом: 200 и аудит', async () => {
    deleteRecordMock.mockResolvedValue({ ok: true, r2Key: 'documents/x', approvalId: 2269 });
    const res = makeRes();

    await timesheetApprovalController.deleteAttachment(makeDeleteReq(), res);

    expect(res._status).toBe(200);
    expect(deleteRecordMock).toHaveBeenCalledWith(900);
    expect(auditActions()).toEqual(['TIMESHEET_APPROVAL_ATTACHMENT_DELETED']);
  });

  it('табель закрыт: 409 «Табель закрыт», аудита нет', async () => {
    deleteRecordMock.mockResolvedValue({ ok: false, reason: 'period_closed' });
    const res = makeRes();

    await timesheetApprovalController.deleteAttachment(makeDeleteReq(), res);

    expect(res._status).toBe(409);
    expect(res._json.error).toBe('Табель закрыт — удаление недоступно');
    expect(r2Mock.deleteObject).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('служебка до открытия: 409 со своим текстом, аудита нет', async () => {
    deleteRecordMock.mockResolvedValue({ ok: false, reason: 'uploaded_before_unlock' });
    const res = makeRes();

    await timesheetApprovalController.deleteAttachment(makeDeleteReq(), res);

    expect(res._status).toBe(409);
    expect(res._json.error).toBe('Служебку, приложенную до открытия табеля, удалить нельзя');
    expect(r2Mock.deleteObject).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('документ исчез между проверкой доступа и транзакцией: 404', async () => {
    deleteRecordMock.mockResolvedValue({ ok: false, reason: 'not_found' });
    const res = makeRes();

    await timesheetApprovalController.deleteAttachment(makeDeleteReq(), res);

    expect(res._status).toBe(404);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('без права на отдел: 403, сервис удаления не вызывается', async () => {
    pgQueryOne.mockImplementation(async (sql: string) => {
      if (/FROM document_links/i.test(sql)) return { entity_id: '2269' };
      if (/FROM timesheet_approvals/i.test(sql)) return approvalRow({ department_id: 'other-dept' });
      return null;
    });
    const res = makeRes();

    await timesheetApprovalController.deleteAttachment(makeDeleteReq(), res);

    expect(res._status).toBe(403);
    expect(deleteRecordMock).not.toHaveBeenCalled();
  });
});
