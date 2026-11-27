import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';

// Файлы компенсации аренды сотрудника (миграция 380): контроллер с заглушками БД, R2, аудита и охвата. Тип файла —
// настоящий. Охват: просмотр — список кадров (rosterEmployeeIds), запись — canWriteStay; файлы — только у сотрудника
// с компенсацией; чужой файл — 404.

const { r2Mock } = vi.hoisted(() => ({
  r2Mock: {
    isEnabledAsync: vi.fn(async () => true),
    generateCompensationFileKey: vi.fn((employeeId: number, ext: string) => `dormitory-compensation/${employeeId}/k${ext}`),
    uploadObject: vi.fn(async () => undefined),
    deleteObject: vi.fn(async () => undefined),
    generateDownloadUrl: vi.fn(async () => 'https://signed'),
  },
}));
vi.mock('../services/r2.service.js', () => ({ r2Service: r2Mock }));

const { auditMock } = vi.hoisted(() => ({ auditMock: vi.fn(async () => undefined) }));
vi.mock('../services/audit.service.js', () => ({
  auditService: { logFromRequestWithClient: auditMock },
  AUDIT_ACTIONS: {
    DORMITORY_COMPENSATION_FILE_UPLOADED: 'DORMITORY_COMPENSATION_FILE_UPLOADED',
    DORMITORY_COMPENSATION_FILE_DELETED: 'DORMITORY_COMPENSATION_FILE_DELETED',
  },
}));

const { axiosGet } = vi.hoisted(() => ({ axiosGet: vi.fn() }));
vi.mock('axios', () => ({ default: { get: axiosGet } }));

const { txClient } = vi.hoisted(() => ({ txClient: { tag: 'tx-client' } }));
vi.mock('../config/postgres.js', () => ({
  withTransaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn(txClient)),
}));

const lock = vi.hoisted(() => ({ lockPayrollEmployee: vi.fn(async () => undefined) }));
vi.mock('../services/payroll/payroll-terms.service.js', () => lock);

const access = vi.hoisted(() => ({ canWriteStay: vi.fn(), rosterEmployeeIds: vi.fn() }));
vi.mock('./dormitory-access.js', () => access);

const svc = vi.hoisted(() => ({
  hasCompensation: vi.fn(),
  listCompensationFiles: vi.fn(),
  getCompensationFileObject: vi.fn(),
  countEmployeeCompensationFiles: vi.fn(),
  insertCompensationFile: vi.fn(),
  deleteCompensationFile: vi.fn(),
}));
vi.mock('../services/dormitory-compensation-files.service.js', () => ({ COMPENSATION_FILES_MAX: 20, ...svc }));

import { dormitoryCompensationFilesController as c } from './dormitory-compensation-files.controller.js';

type ResMock = Response & { statusCode: number; body: unknown; headers: Record<string, string>; sent?: Buffer };
const makeRes = (): ResMock => {
  const res = { headers: {} } as ResMock;
  res.statusCode = 200;
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; }) as never;
  res.json = vi.fn((payload: unknown) => { res.body = payload; return res; }) as never;
  res.setHeader = vi.fn((name: string, value: string) => { res.headers[name] = value; return res; }) as never;
  res.end = vi.fn((chunk?: Buffer) => { res.sent = chunk; return res; }) as never;
  return res;
};

// multer отдаёт имя байтами UTF-8, прочитанными как latin1.
const multerName = (name: string): string => Buffer.from(name, 'utf8').toString('latin1');
const PDF_BYTES = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64)]);
const pdfFile = (name = 'Договор аренды.pdf') => ({
  originalname: multerName(name), mimetype: 'application/pdf', size: PDF_BYTES.length, buffer: PDF_BYTES,
});

const req = (params: Record<string, string>, extra: Record<string, unknown> = {}): never => ({
  params, query: {}, body: {}, user: { id: 'hr-user' }, headers: {}, socket: {}, ...extra,
} as never);

const CREATED = {
  id: 5, file_name: 'Договор аренды.pdf', file_size: PDF_BYTES.length, mime_type: 'application/pdf',
  created_at: '2026-11-26T08:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  r2Mock.isEnabledAsync.mockResolvedValue(true);
  access.rosterEmployeeIds.mockResolvedValue([822, 820]);
  access.canWriteStay.mockResolvedValue(true);
  svc.hasCompensation.mockResolvedValue(true);
  svc.countEmployeeCompensationFiles.mockResolvedValue(0);
  svc.insertCompensationFile.mockResolvedValue(CREATED);
});

describe('просмотр', () => {
  it('в охвате — список и ссылка; вне охвата — 403; без компенсации — 404; чужой файл — 404', async () => {
    svc.listCompensationFiles.mockResolvedValue([CREATED]);
    const listed = makeRes();
    await c.list(req({ employeeId: '822' }), listed);
    expect(listed.body).toEqual({ success: true, data: [CREATED] });

    svc.getCompensationFileObject.mockResolvedValueOnce({ id: 5, file_name: 'Договор аренды.pdf', mime_type: 'application/pdf', r2_key: 'k' });
    const url = makeRes();
    await c.fileUrl(req({ employeeId: '822', fileId: '5' }, { query: { disposition: 'inline' } }), url);
    expect(url.body).toEqual({ success: true, data: { url: 'https://signed' } });
    expect(svc.getCompensationFileObject).toHaveBeenCalledWith(822, 5);

    const foreign = makeRes();
    await c.list(req({ employeeId: '999' }), foreign);
    expect(foreign.statusCode).toBe(403);
    const foreignUrl = makeRes();
    await c.fileUrl(req({ employeeId: '999', fileId: '5' }), foreignUrl);
    expect(foreignUrl.statusCode).toBe(403);

    svc.hasCompensation.mockResolvedValueOnce(false);
    const noCompensation = makeRes();
    await c.list(req({ employeeId: '820' }), noCompensation);
    expect(noCompensation.statusCode).toBe(404);

    // Файл другого сотрудника: сервис ищет по паре (сотрудник, файл) — не нашёл.
    svc.getCompensationFileObject.mockResolvedValueOnce(null);
    const other = makeRes();
    await c.fileUrl(req({ employeeId: '822', fileId: '77' }), other);
    expect(other.statusCode).toBe(404);
    expect(r2Mock.generateDownloadUrl).toHaveBeenCalledTimes(1);

    const bad = makeRes();
    await c.list(req({ employeeId: 'abc' }), bad);
    expect(bad.statusCode).toBe(400);
  });

  it('файл для печати: байты своим доменом с типом и именем; вне охвата — 403 без R2; чужой файл — 404', async () => {
    svc.getCompensationFileObject.mockResolvedValueOnce({
      id: 5, file_name: 'Скан договора.pdf', mime_type: 'application/pdf', r2_key: 'dormitory-compensation/822/k.pdf',
    });
    axiosGet.mockResolvedValueOnce({ data: PDF_BYTES.buffer.slice(PDF_BYTES.byteOffset, PDF_BYTES.byteOffset + PDF_BYTES.length) });
    const res = makeRes();
    await c.content(req({ employeeId: '822', fileId: '5' }), res);
    expect(res.statusCode).toBe(200);
    expect(svc.getCompensationFileObject).toHaveBeenCalledWith(822, 5);
    expect(r2Mock.generateDownloadUrl).toHaveBeenCalledWith('dormitory-compensation/822/k.pdf', undefined, 'inline', 300);
    expect(axiosGet).toHaveBeenCalledWith('https://signed', expect.objectContaining({ responseType: 'arraybuffer' }));
    expect(res.sent?.equals(PDF_BYTES)).toBe(true);
    expect(res.headers).toEqual(expect.objectContaining({
      'Content-Type': 'application/pdf',
      'Content-Length': String(PDF_BYTES.length),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `inline; filename="file"; filename*=UTF-8''${encodeURIComponent('Скан договора.pdf')}`,
    }));

    const foreign = makeRes();
    await c.content(req({ employeeId: '999', fileId: '5' }), foreign);
    expect(foreign.statusCode).toBe(403);

    svc.getCompensationFileObject.mockResolvedValueOnce(null);
    const other = makeRes();
    await c.content(req({ employeeId: '822', fileId: '77' }), other);
    expect(other.statusCode).toBe(404);

    const bad = makeRes();
    await c.content(req({ employeeId: '822', fileId: 'x' }), bad);
    expect(bad.statusCode).toBe(400);
    expect(axiosGet).toHaveBeenCalledTimes(1);
    expect(r2Mock.generateDownloadUrl).toHaveBeenCalledTimes(1);
  });

  it('вся организация (охват null) — можно', async () => {
    access.rosterEmployeeIds.mockResolvedValue(null);
    svc.listCompensationFiles.mockResolvedValue([]);
    const res = makeRes();
    await c.list(req({ employeeId: '1265' }), res);
    expect(res.statusCode).toBe(200);
  });
});

describe('загрузка и удаление', () => {
  it('загрузка: R2, строка и аудит в транзакции под замком сотрудника', async () => {
    const res = makeRes();
    await c.upload(req({ employeeId: '822' }, { file: pdfFile() }), res);
    expect(res.statusCode).toBe(200);
    expect(r2Mock.uploadObject).toHaveBeenCalledWith('dormitory-compensation/822/k.pdf', PDF_BYTES, 'application/pdf');
    expect(lock.lockPayrollEmployee).toHaveBeenCalledWith(txClient, 822);
    expect(svc.insertCompensationFile).toHaveBeenCalledWith(txClient, expect.objectContaining({
      employeeId: 822, r2Key: 'dormitory-compensation/822/k.pdf', fileName: 'Договор аренды.pdf',
    }));
    expect(auditMock).toHaveBeenCalledWith(txClient, expect.anything(), 'hr-user', 'DORMITORY_COMPENSATION_FILE_UPLOADED',
      expect.objectContaining({ entityType: 'employee', entityId: '822' }));
  });

  it('нет права на сотрудника — 403 без R2; без компенсации — 404; 20 файлов — 409 и объект R2 удалён', async () => {
    access.canWriteStay.mockResolvedValueOnce(false);
    const foreign = makeRes();
    await c.upload(req({ employeeId: '822' }, { file: pdfFile() }), foreign);
    expect(foreign.statusCode).toBe(403);
    expect(r2Mock.uploadObject).not.toHaveBeenCalled();

    svc.hasCompensation.mockResolvedValueOnce(false);
    const missing = makeRes();
    await c.upload(req({ employeeId: '822' }, { file: pdfFile() }), missing);
    expect(missing.statusCode).toBe(404);
    expect(r2Mock.uploadObject).not.toHaveBeenCalled();

    svc.countEmployeeCompensationFiles.mockResolvedValueOnce(20);
    const limit = makeRes();
    await c.upload(req({ employeeId: '822' }, { file: pdfFile() }), limit);
    expect(limit.statusCode).toBe(409);
    expect(limit.body).toEqual(expect.objectContaining({ code: 'COMPENSATION_FILES_LIMIT' }));
    expect(svc.insertCompensationFile).not.toHaveBeenCalled();
    expect(r2Mock.deleteObject).toHaveBeenCalledWith('dormitory-compensation/822/k.pdf');
  });

  it('не тот тип — 400; пустой — 400', async () => {
    const exe = makeRes();
    await c.upload(req({ employeeId: '822' }, {
      file: { originalname: 'virus.exe', mimetype: 'application/octet-stream', size: 4, buffer: Buffer.from('MZ\u0090\u0000') },
    }), exe);
    expect(exe.statusCode).toBe(400);
    const empty = makeRes();
    await c.upload(req({ employeeId: '822' }, {}), empty);
    expect(empty.statusCode).toBe(400);
    expect(r2Mock.uploadObject).not.toHaveBeenCalled();
  });

  it('удаление: свой файл — строка, аудит, объект R2 после коммита; чужой — 404; без права — 403', async () => {
    svc.deleteCompensationFile.mockResolvedValueOnce({ r2Key: 'dormitory-compensation/822/k.pdf', fileName: 'Договор аренды.pdf' });
    const res = makeRes();
    await c.remove(req({ employeeId: '822', fileId: '5' }), res);
    expect(res.statusCode).toBe(200);
    expect(svc.deleteCompensationFile).toHaveBeenCalledWith(txClient, 822, 5);
    expect(auditMock).toHaveBeenCalledWith(txClient, expect.anything(), 'hr-user', 'DORMITORY_COMPENSATION_FILE_DELETED',
      expect.objectContaining({ entityId: '822' }));
    expect(r2Mock.deleteObject).toHaveBeenCalledWith('dormitory-compensation/822/k.pdf');

    svc.deleteCompensationFile.mockResolvedValueOnce(null);
    const other = makeRes();
    await c.remove(req({ employeeId: '822', fileId: '77' }), other);
    expect(other.statusCode).toBe(404);

    access.canWriteStay.mockResolvedValueOnce(false);
    const foreign = makeRes();
    await c.remove(req({ employeeId: '822', fileId: '5' }), foreign);
    expect(foreign.statusCode).toBe(403);
    expect(svc.deleteCompensationFile).toHaveBeenCalledTimes(2);
  });
});
