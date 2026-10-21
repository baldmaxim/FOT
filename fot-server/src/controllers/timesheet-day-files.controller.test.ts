import { beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type Response } from 'express';
import request from 'supertest';

const { scopeMock, hrAdminMock } = vi.hoisted(() => ({
  scopeMock: vi.fn(async () => true),
  hrAdminMock: vi.fn(async () => true),
}));
vi.mock('../services/data-scope.service.js', () => ({ canWriteEmployeeInScope: scopeMock }));
vi.mock('../services/access-control.service.js', () => ({ canManageAsHrAdmin: hrAdminMock }));
vi.mock('../middleware/auth.js', () => ({
  requirePageAccess: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const { r2Mock } = vi.hoisted(() => ({
  r2Mock: {
    isEnabledAsync: vi.fn(async () => true),
    generateKey: vi.fn(() => 'documents/10/key.pdf'),
    uploadObject: vi.fn(async () => undefined),
    deleteObject: vi.fn(async () => undefined),
    generateDownloadUrl: vi.fn(async () => 'https://signed'),
  },
}));
vi.mock('../services/r2.service.js', () => ({ r2Service: r2Mock }));

const { auditMock } = vi.hoisted(() => ({ auditMock: vi.fn(async () => undefined) }));
vi.mock('../services/audit.service.js', () => ({
  auditService: { logFromRequest: auditMock },
  AUDIT_ACTIONS: {
    TIMESHEET_DAY_FILE_UPLOADED: 'TIMESHEET_DAY_FILE_UPLOADED',
    TIMESHEET_DAY_FILE_DELETED: 'TIMESHEET_DAY_FILE_DELETED',
  },
}));

const svc = vi.hoisted(() => ({
  employeeExists: vi.fn(async () => true),
  listDayFiles: vi.fn(),
  createDayFile: vi.fn(),
  loadDayFileLink: vi.fn(),
  deleteDayFile: vi.fn(),
}));
vi.mock('../services/timesheet-day-files.service.js', () => ({
  DAY_FILE_ENTITY_TYPE: 'timesheet_day',
  dayFileEntityId: (employeeId: number, workDate: string) => `${employeeId}|${workDate}`,
  ...svc,
}));

import { timesheetDayFilesController } from './timesheet-day-files.controller.js';
import dayFilesRouter from '../routes/timesheet-day-files.routes.js';

type ResMock = Response & { statusCode: number; body: unknown };
const makeRes = (): ResMock => {
  const res = {} as ResMock;
  res.statusCode = 200;
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; }) as never;
  res.json = vi.fn((payload: unknown) => { res.body = payload; return res; }) as never;
  return res;
};

const PDF = { originalname: 'служебка.pdf', mimetype: 'application/pdf', size: 100, buffer: Buffer.from('%PDF') };

const uploadReq = (body: Record<string, unknown>, file: unknown = PDF): never => ({
  body,
  file,
  user: { id: 'hr-user' },
  headers: {},
  socket: {},
} as never);

const CREATED = {
  id: 501, original_name: 'служебка.pdf', mime_type: 'application/pdf', file_size: 100,
  uploaded_at: '2026-10-21T09:00:00.000Z', uploader_name: null, r2_key: 'documents/10/key.pdf',
};

beforeEach(() => {
  vi.clearAllMocks();
  scopeMock.mockResolvedValue(true);
  hrAdminMock.mockResolvedValue(true);
  r2Mock.isEnabledAsync.mockResolvedValue(true);
  svc.employeeExists.mockResolvedValue(true);
});

describe('timesheetDayFilesController.upload', () => {
  it('грузит файл дня: R2 → документ → аудит', async () => {
    svc.createDayFile.mockResolvedValue(CREATED);
    const res = makeRes();
    await timesheetDayFilesController.upload(uploadReq({ employee_id: '10', work_date: '2026-10-18' }), res);

    expect(res.statusCode).toBe(200);
    expect(r2Mock.uploadObject).toHaveBeenCalledTimes(1);
    expect(svc.createDayFile.mock.calls[0][0]).toMatchObject({
      employeeId: 10, workDate: '2026-10-18', mimeType: 'application/pdf', uploadedBy: 'hr-user',
    });
    expect(auditMock).toHaveBeenCalledWith(expect.anything(), 'hr-user', 'TIMESHEET_DAY_FILE_UPLOADED', expect.objectContaining({
      entityType: 'timesheet_day', entityId: '10|2026-10-18',
    }));
    expect((res.body as { data: { id: number } }).data.id).toBe(501);
  });

  it('400 на несуществующую дату 2026-02-31 — R2 не трогаем', async () => {
    const res = makeRes();
    await timesheetDayFilesController.upload(uploadReq({ employee_id: '10', work_date: '2026-02-31' }), res);
    expect(res.statusCode).toBe(400);
    expect(r2Mock.uploadObject).not.toHaveBeenCalled();
  });

  it('400 на кривой employee_id', async () => {
    const res = makeRes();
    await timesheetDayFilesController.upload(uploadReq({ employee_id: '1.5', work_date: '2026-10-18' }), res);
    expect(res.statusCode).toBe(400);
  });

  it('400 на SVG', async () => {
    const res = makeRes();
    await timesheetDayFilesController.upload(
      uploadReq({ employee_id: '10', work_date: '2026-10-18' }, { ...PDF, originalname: 'a.svg', mimetype: 'image/svg+xml' }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(r2Mock.uploadObject).not.toHaveBeenCalled();
  });

  it('404, если сотрудника нет — до загрузки в R2', async () => {
    svc.employeeExists.mockResolvedValue(false);
    const res = makeRes();
    await timesheetDayFilesController.upload(uploadReq({ employee_id: '999999', work_date: '2026-10-18' }), res);
    expect(res.statusCode).toBe(404);
    expect(r2Mock.uploadObject).not.toHaveBeenCalled();
  });

  it('403 вне скоупа — до загрузки в R2', async () => {
    scopeMock.mockResolvedValue(false);
    const res = makeRes();
    await timesheetDayFilesController.upload(uploadReq({ employee_id: '10', work_date: '2026-10-18' }), res);
    expect(res.statusCode).toBe(403);
    expect(r2Mock.uploadObject).not.toHaveBeenCalled();
  });

  it('ошибка вставки → объект в R2 удаляется', async () => {
    svc.createDayFile.mockRejectedValue(new Error('db down'));
    const res = makeRes();
    await timesheetDayFilesController.upload(uploadReq({ employee_id: '10', work_date: '2026-10-18' }), res);
    expect(res.statusCode).toBe(500);
    expect(r2Mock.deleteObject).toHaveBeenCalledWith('documents/10/key.pdf');
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe('timesheetDayFilesController.list', () => {
  it('отдаёт файлы дня со ссылками', async () => {
    svc.listDayFiles.mockResolvedValue([CREATED]);
    const res = makeRes();
    await timesheetDayFilesController.list({ query: { employee_id: '10', work_date: '2026-10-18' }, user: { id: 'hr-user' } } as never, res);
    expect(res.statusCode).toBe(200);
    expect(svc.listDayFiles).toHaveBeenCalledWith(10, '2026-10-18');
    const data = (res.body as { data: Array<{ id: number; preview_url: string }> }).data;
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ id: 501, preview_url: 'https://signed' });
  });

  it('403 вне скоупа', async () => {
    scopeMock.mockResolvedValue(false);
    const res = makeRes();
    await timesheetDayFilesController.list({ query: { employee_id: '10', work_date: '2026-10-18' }, user: { id: 'hr-user' } } as never, res);
    expect(res.statusCode).toBe(403);
    expect(svc.listDayFiles).not.toHaveBeenCalled();
  });
});

describe('timesheetDayFilesController.remove', () => {
  const removeReq = (documentId: string): never => ({
    params: { documentId }, user: { id: 'hr-user' }, headers: {}, socket: {},
  } as never);

  it('удаляет: сначала БД, потом R2, потом аудит', async () => {
    svc.loadDayFileLink.mockResolvedValue({ employeeId: 10, workDate: '2026-10-18' });
    svc.deleteDayFile.mockResolvedValue({ deleted: true, r2Key: 'documents/10/key.pdf', fileName: 'служебка.pdf' });
    const res = makeRes();
    await timesheetDayFilesController.remove(removeReq('501'), res);
    expect(res.statusCode).toBe(200);
    expect(scopeMock).toHaveBeenCalledWith(expect.anything(), 10);
    expect(r2Mock.deleteObject).toHaveBeenCalledWith('documents/10/key.pdf');
    expect(auditMock).toHaveBeenCalledWith(expect.anything(), 'hr-user', 'TIMESHEET_DAY_FILE_DELETED', expect.objectContaining({
      entityId: '10|2026-10-18',
      details: { document_id: 501, file_name: 'служебка.pdf' },
    }));
  });

  it('404, если документ — не файл дня', async () => {
    svc.loadDayFileLink.mockResolvedValue(null);
    const res = makeRes();
    await timesheetDayFilesController.remove(removeReq('501'), res);
    expect(res.statusCode).toBe(404);
    expect(svc.deleteDayFile).not.toHaveBeenCalled();
  });

  it('403 вне скоупа — до удаления', async () => {
    svc.loadDayFileLink.mockResolvedValue({ employeeId: 10, workDate: '2026-10-18' });
    scopeMock.mockResolvedValue(false);
    const res = makeRes();
    await timesheetDayFilesController.remove(removeReq('501'), res);
    expect(res.statusCode).toBe(403);
    expect(svc.deleteDayFile).not.toHaveBeenCalled();
  });

  it('409, если у файла появилась чужая ссылка — R2 не трогаем', async () => {
    svc.loadDayFileLink.mockResolvedValue({ employeeId: 10, workDate: '2026-10-18' });
    svc.deleteDayFile.mockResolvedValue({ deleted: false, r2Key: null, fileName: null });
    const res = makeRes();
    await timesheetDayFilesController.remove(removeReq('501'), res);
    expect(res.statusCode).toBe(409);
    expect(r2Mock.deleteObject).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe('маршруты /day-files', () => {
  const makeApp = () => {
    const app = express();
    app.use((req, _res, next) => {
      (req as unknown as { user: unknown }).user = { id: 'hr-user' };
      next();
    });
    app.use('/day-files', dayFilesRouter);
    return app;
  };

  it('без права кадрового админа → 403, файл не принимается', async () => {
    hrAdminMock.mockResolvedValue(false);
    const res = await request(makeApp())
      .post('/day-files')
      .field('employee_id', '10')
      .field('work_date', '2026-10-18')
      .attach('file', Buffer.from('%PDF'), 'a.pdf');
    expect(res.status).toBe(403);
    expect(svc.createDayFile).not.toHaveBeenCalled();
  });

  it('список без права кадрового админа → 403', async () => {
    hrAdminMock.mockResolvedValue(false);
    const res = await request(makeApp()).get('/day-files?employee_id=10&work_date=2026-10-18');
    expect(res.status).toBe(403);
    expect(svc.listDayFiles).not.toHaveBeenCalled();
  });

  it('файл больше 25 МБ → 413', async () => {
    const res = await request(makeApp())
      .post('/day-files')
      .field('employee_id', '10')
      .field('work_date', '2026-10-18')
      .attach('file', Buffer.alloc(25 * 1024 * 1024 + 1), 'big.pdf');
    expect(res.status).toBe(413);
    expect(svc.createDayFile).not.toHaveBeenCalled();
  });

  it('обычная загрузка доходит до контроллера с полями формы', async () => {
    svc.createDayFile.mockResolvedValue(CREATED);
    const res = await request(makeApp())
      .post('/day-files')
      .field('employee_id', '10')
      .field('work_date', '2026-10-18')
      .attach('file', Buffer.from('%PDF-1.4'), { filename: 'a.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(200);
    expect(svc.createDayFile.mock.calls[0][0]).toMatchObject({ employeeId: 10, workDate: '2026-10-18' });
  });
});
