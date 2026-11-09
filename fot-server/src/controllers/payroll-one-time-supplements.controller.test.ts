import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

// Файлы разовой доплаты (миграция 354): multipart-конверт, проверка по байтам, R2 до и после транзакции,
// аудит в транзакции, ссылка по клику. Сервис БД замокан — транзакционность проверяет PG-тест.

const registryScope = vi.hoisted(() => ({
  canWritePayrollRegistryEmployee: vi.fn(),
  resolvePayrollStaffScope: vi.fn(),
  isPayrollStaffEmployee: vi.fn(),
}));
vi.mock('../services/payroll/payroll-registry-scope.service.js', () => registryScope);

const supplements = vi.hoisted(() => ({
  getOneTimeSupplement: vi.fn(),
  addOneTimeSupplement: vi.fn(),
  updateOneTimeSupplement: vi.fn(),
  deleteOneTimeSupplement: vi.fn(),
  getOneTimeSupplementFile: vi.fn(),
  ONE_TIME_SUPPLEMENT_FILES_MAX: 10,
}));
vi.mock('../services/payroll/payroll-supplements.service.js', () => supplements);

const r2 = vi.hoisted(() => ({
  isEnabledAsync: vi.fn(),
  uploadObject: vi.fn(),
  deleteObject: vi.fn(),
  generateDownloadUrl: vi.fn(),
  generatePayrollSupplementKey: vi.fn(),
}));
vi.mock('../services/r2.service.js', () => ({ r2Service: r2 }));

const audit = vi.hoisted(() => ({ logFromRequestWithClient: vi.fn() }));
vi.mock('../services/audit.service.js', () => ({ auditService: audit }));

import { oneTimeSupplementHandlers as c } from './payroll-one-time-supplements.controller.js';

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  return res as unknown as Response & { statusCode: number; body: any };
};

const makeReq = (over: Record<string, unknown> = {}): AuthenticatedRequest => ({
  user: { id: 'user-1' }, params: {}, query: {}, body: {}, headers: {}, ...over,
} as unknown as AuthenticatedRequest);

/** Файл, как его отдаёт multer: имя — UTF-8 байты, прочитанные как latin1. */
const multerFile = (name: string, content: string | Buffer, mimetype: string) => {
  const buffer = typeof content === 'string' ? Buffer.from(content) : content;
  return {
    fieldname: 'files',
    originalname: Buffer.from(name, 'utf8').toString('latin1'),
    mimetype,
    size: buffer.length,
    buffer,
  } as Express.Multer.File;
};
const PDF = (name = 'Приказ.pdf') => multerFile(name, '%PDF-1.4 приказ', 'application/pdf');
const PNG = (name = 'Чек.png') => multerFile(
  name, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]), 'image/png',
);

const FIELDS = { month: '2026-10', amount: 3300, reason: 'Компенсация использования личного а/м' };
const multipart = (data: unknown, files: Express.Multer.File[], over: Record<string, unknown> = {}) => makeReq({
  body: { data: typeof data === 'string' ? data : JSON.stringify(data) },
  files,
  ...over,
});

const file = (id: number, name = `Файл ${id}.pdf`) => ({ id, file_name: name, file_size: 100, mime_type: 'application/pdf' });
const ROW = {
  id: 5, employee_id: 42, full_name: 'Сорокин Юрий Николаевич', month: '2026-10', amount: '3300.00',
  reason: FIELDS.reason, files: [file(7)],
};

let keySeq = 0;

beforeEach(() => {
  vi.resetAllMocks();
  keySeq = 0;
  registryScope.canWritePayrollRegistryEmployee.mockResolvedValue(true);
  registryScope.resolvePayrollStaffScope.mockResolvedValue({ contractorRootId: 'c', departmentIds: null });
  registryScope.isPayrollStaffEmployee.mockResolvedValue(true);
  r2.isEnabledAsync.mockResolvedValue(true);
  r2.uploadObject.mockResolvedValue(undefined);
  r2.deleteObject.mockResolvedValue(undefined);
  r2.generatePayrollSupplementKey.mockImplementation((employeeId: number, ext: string) => {
    keySeq += 1;
    return `payroll-supplements/${employeeId}/k${keySeq}${ext}`;
  });
  audit.logFromRequestWithClient.mockResolvedValue(undefined);
  supplements.getOneTimeSupplement.mockResolvedValue(ROW);
  // Сервис вызывает аудит внутри транзакции — как настоящий.
  supplements.addOneTimeSupplement.mockImplementation(async (_employeeId, _input, options) => {
    const created = { ...ROW, files: (options.files ?? []).map((f: { fileName: string }, i: number) => file(10 + i, f.fileName)) };
    await options.audit?.('tx', created);
    return created;
  });
});

describe('добавление с файлами', () => {
  it('multipart: файлы в R2 до транзакции, строки и аудит — в транзакции; кириллица в имени', async () => {
    const res = makeRes();
    await c.addOneTime(multipart({ employee_id: 42, ...FIELDS }, [PDF(), PNG()]), res);
    expect(res.statusCode).toBe(200);
    expect(r2.uploadObject.mock.calls.map(call => [call[0], call[2]])).toEqual([
      ['payroll-supplements/42/k1.pdf', 'application/pdf'],
      ['payroll-supplements/42/k2.png', 'image/png'],
    ]);
    expect(supplements.addOneTimeSupplement).toHaveBeenCalledWith(42, FIELDS, expect.objectContaining({
      files: [
        { r2Key: 'payroll-supplements/42/k1.pdf', fileName: 'Приказ.pdf', fileSize: PDF().size, mimeType: 'application/pdf' },
        { r2Key: 'payroll-supplements/42/k2.png', fileName: 'Чек.png', fileSize: 10, mimeType: 'image/png' },
      ],
    }));
    expect(audit.logFromRequestWithClient).toHaveBeenCalledWith(
      'tx', expect.anything(), 'user-1', 'PAYROLL_ONE_TIME_SUPPLEMENT_ADDED',
      expect.objectContaining({
        details: expect.objectContaining({
          files: [{ file_name: 'Приказ.pdf', file_size: 100 }, { file_name: 'Чек.png', file_size: 100 }],
        }),
      }),
    );
    expect(r2.deleteObject).not.toHaveBeenCalled();
  });

  it('HTML под именем .pdf и PNG с MIME pdf — 400, в R2 ничего не уходит', async () => {
    for (const bad of [multerFile('Приказ.pdf', '<html>', 'application/pdf'), PNG('Чек.pdf')]) {
      const res = makeRes();
      await c.addOneTime(multipart({ employee_id: 42, ...FIELDS }, [PDF('Ок.pdf'), bad]), res);
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toContain('допустимы PDF, JPG, PNG, WEBP, DOC, DOCX');
    }
    expect(r2.uploadObject).not.toHaveBeenCalled();
    expect(supplements.addOneTimeSupplement).not.toHaveBeenCalled();
  });

  it('упала загрузка второго файла — первый удалён, доплата не сохранена, 502', async () => {
    r2.uploadObject.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('R2 down'));
    const res = makeRes();
    await c.addOneTime(multipart({ employee_id: 42, ...FIELDS }, [PDF(), PNG()]), res);
    expect(res.statusCode).toBe(502);
    expect(res.body.error).toContain('Чек.png');
    expect(r2.deleteObject.mock.calls).toEqual([['payroll-supplements/42/k1.pdf']]);
    expect(supplements.addOneTimeSupplement).not.toHaveBeenCalled();
  });

  it('упала транзакция или аудит в ней — загруженное удалено, 500', async () => {
    supplements.addOneTimeSupplement.mockRejectedValueOnce(new Error('deadlock'));
    const failedTx = makeRes();
    await c.addOneTime(multipart({ employee_id: 42, ...FIELDS }, [PDF()]), failedTx);
    expect(failedTx.statusCode).toBe(500);
    expect(r2.deleteObject.mock.calls).toEqual([['payroll-supplements/42/k1.pdf']]);

    audit.logFromRequestWithClient.mockRejectedValueOnce(new Error('audit_logs недоступна'));
    const failedAudit = makeRes();
    await c.addOneTime(multipart({ employee_id: 42, ...FIELDS }, [PDF()]), failedAudit);
    expect(failedAudit.statusCode).toBe(500);
    expect(r2.deleteObject.mock.calls.at(-1)).toEqual(['payroll-supplements/42/k2.pdf']);
  });

  it('некорректный data — 400 без записи', async () => {
    for (const data of ['{не json', '[1,2]', 'null']) {
      const res = makeRes();
      await c.addOneTime(multipart(data, [PDF()]), res);
      expect(res.statusCode, data).toBe(400);
      expect(res.body.error).toBe('Некорректные данные формы');
    }
    const noData = makeRes();
    await c.addOneTime(makeReq({ body: {}, files: [] }), noData);
    expect(noData.statusCode).toBe(400);
    expect(r2.uploadObject).not.toHaveBeenCalled();
    expect(supplements.addOneTimeSupplement).not.toHaveBeenCalled();
  });

  it('R2 выключен: с файлами — 503 и ничего не сохранено; без файлов доплата добавляется', async () => {
    r2.isEnabledAsync.mockResolvedValue(false);
    const res = makeRes();
    await c.addOneTime(multipart({ employee_id: 42, ...FIELDS }, [PDF()]), res);
    expect(res.statusCode).toBe(503);
    expect(supplements.addOneTimeSupplement).not.toHaveBeenCalled();

    const plain = makeRes();
    await c.addOneTime(makeReq({ body: { employee_id: 42, ...FIELDS } }), plain);
    expect(plain.statusCode).toBe(200);
  });

  it('нет права на сотрудника — 403 до загрузки', async () => {
    registryScope.canWritePayrollRegistryEmployee.mockResolvedValue(false);
    const res = makeRes();
    await c.addOneTime(multipart({ employee_id: 42, ...FIELDS }, [PDF()]), res);
    expect(res.statusCode).toBe(403);
    expect(r2.uploadObject).not.toHaveBeenCalled();
  });
});

describe('правка: файлы', () => {
  const saved = (removedKeys: string[]) => ({ status: 'saved', before: ROW, after: ROW, changed: true, removedKeys });

  it('только снятие (JSON): R2 удаляется после коммита, загрузок нет', async () => {
    supplements.updateOneTimeSupplement.mockImplementation(async () => {
      expect(r2.deleteObject).not.toHaveBeenCalled();
      return saved(['payroll-supplements/42/old.pdf']);
    });
    const res = makeRes();
    await c.updateOneTime(makeReq({ params: { id: '5' }, body: { ...FIELDS, remove_file_ids: [7] } }), res);
    expect(res.statusCode).toBe(200);
    expect(supplements.updateOneTimeSupplement).toHaveBeenCalledWith(5, FIELDS, expect.objectContaining({
      addFiles: [], removeFileIds: [7],
    }));
    expect(r2.uploadObject).not.toHaveBeenCalled();
    expect(r2.deleteObject.mock.calls).toEqual([['payroll-supplements/42/old.pdf']]);
  });

  it('прежний клиент без remove_file_ids — как раньше', async () => {
    supplements.updateOneTimeSupplement.mockResolvedValue(saved([]));
    const res = makeRes();
    await c.updateOneTime(makeReq({ params: { id: '5' }, body: FIELDS }), res);
    expect(res.statusCode).toBe(200);
    expect(supplements.updateOneTimeSupplement).toHaveBeenCalledWith(5, FIELDS, expect.objectContaining({ removeFileIds: [] }));
  });

  it('дубли, не числа и больше 10 в remove_file_ids — 400', async () => {
    for (const ids of [[7, 7], ['7'], [0], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]]) {
      const res = makeRes();
      await c.updateOneTime(makeReq({ params: { id: '5' }, body: { ...FIELDS, remove_file_ids: ids } }), res);
      expect(res.statusCode, JSON.stringify(ids)).toBe(400);
    }
    expect(supplements.updateOneTimeSupplement).not.toHaveBeenCalled();
  });

  it('снимаемого файла уже нет — 409, загруженное в этом запросе удалено', async () => {
    supplements.updateOneTimeSupplement.mockResolvedValue({ status: 'stale' });
    const res = makeRes();
    await c.updateOneTime(multipart({ ...FIELDS, remove_file_ids: [7] }, [PDF()], { params: { id: '5' } }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('SUPPLEMENT_STALE');
    expect(r2.deleteObject.mock.calls).toEqual([['payroll-supplements/42/k1.pdf']]);
  });

  it('станет больше 10: заведомо — 400 до загрузки; по блокировке — 400 и загруженное удалено', async () => {
    supplements.getOneTimeSupplement.mockResolvedValueOnce({ ...ROW, files: Array.from({ length: 10 }, (_, i) => file(i + 1)) });
    const early = makeRes();
    await c.updateOneTime(multipart(FIELDS, [PDF()], { params: { id: '5' } }), early);
    expect(early.statusCode).toBe(400);
    expect(early.body.code).toBe('SUPPLEMENT_FILES_LIMIT');
    expect(r2.uploadObject).not.toHaveBeenCalled();

    supplements.updateOneTimeSupplement.mockResolvedValue({ status: 'too_many' });
    const raced = makeRes();
    await c.updateOneTime(multipart(FIELDS, [PDF()], { params: { id: '5' } }), raced);
    expect(raced.statusCode).toBe(400);
    expect(raced.body.code).toBe('SUPPLEMENT_FILES_LIMIT');
    expect(r2.deleteObject.mock.calls).toEqual([['payroll-supplements/42/k1.pdf']]);
  });

  it('аудит правки: добавленные и снятые файлы', async () => {
    const after = { ...ROW, files: [file(11, 'Новый.pdf')] };
    supplements.updateOneTimeSupplement.mockImplementation(async (_id, _input, options) => {
      await options.audit('tx', ROW, after);
      return { status: 'saved', before: ROW, after, changed: true, removedKeys: [] };
    });
    await c.updateOneTime(multipart({ ...FIELDS, remove_file_ids: [7] }, [PDF('Новый.pdf')], { params: { id: '5' } }), makeRes());
    expect(audit.logFromRequestWithClient).toHaveBeenCalledWith(
      'tx', expect.anything(), 'user-1', 'PAYROLL_ONE_TIME_SUPPLEMENT_UPDATED',
      expect.objectContaining({
        details: expect.objectContaining({
          files_added: [{ file_name: 'Новый.pdf', file_size: 100 }],
          files_removed: [{ file_name: 'Файл 7.pdf', file_size: 100 }],
        }),
      }),
    );
  });

  it('R2 выключен: снятие файла работает в БД', async () => {
    r2.isEnabledAsync.mockResolvedValue(false);
    r2.deleteObject.mockRejectedValue(new Error('R2 не настроен'));
    supplements.updateOneTimeSupplement.mockResolvedValue(saved(['payroll-supplements/42/old.pdf']));
    const res = makeRes();
    await c.updateOneTime(makeReq({ params: { id: '5' }, body: { ...FIELDS, remove_file_ids: [7] } }), res);
    expect(res.statusCode).toBe(200);
  });
});

describe('удаление доплаты', () => {
  it('файлы из R2 — после коммита; аудит — в транзакции со списком файлов', async () => {
    supplements.deleteOneTimeSupplement.mockImplementation(async (_id, options) => {
      await options.audit('tx', ROW);
      expect(r2.deleteObject).not.toHaveBeenCalled();
      return { deleted: ROW, r2Keys: ['payroll-supplements/42/a.pdf'] };
    });
    const res = makeRes();
    await c.removeOneTime(makeReq({ params: { id: '5' } }), res);
    expect(res.statusCode).toBe(200);
    expect(r2.deleteObject.mock.calls).toEqual([['payroll-supplements/42/a.pdf']]);
    expect(audit.logFromRequestWithClient).toHaveBeenCalledWith(
      'tx', expect.anything(), 'user-1', 'PAYROLL_ONE_TIME_SUPPLEMENT_DELETED',
      expect.objectContaining({ details: expect.objectContaining({ files: [{ file_name: 'Файл 7.pdf', file_size: 100 }] }) }),
    );
  });
});

describe('ссылка на файл', () => {
  const FILE = { employee_id: 42, r2_key: 'payroll-supplements/42/k.pdf', file_name: 'Приказ.pdf', mime_type: 'application/pdf' };

  it('по клику: inline на 5 минут', async () => {
    supplements.getOneTimeSupplementFile.mockResolvedValue(FILE);
    r2.generateDownloadUrl.mockResolvedValue('https://r2/signed');
    const res = makeRes();
    await c.fileUrl(makeReq({ params: { id: '5', fileId: '7' }, query: { disposition: 'inline' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({ url: 'https://r2/signed' });
    expect(supplements.getOneTimeSupplementFile).toHaveBeenCalledWith(5, 7);
    expect(r2.generateDownloadUrl).toHaveBeenCalledWith(FILE.r2_key, 'Приказ.pdf', 'inline', 300);
  });

  it('сотрудник вне охвата, чужой файл, кривой id — 404; disposition=foo — 400', async () => {
    supplements.getOneTimeSupplementFile.mockResolvedValue(FILE);
    registryScope.isPayrollStaffEmployee.mockResolvedValue(false);
    const outside = makeRes();
    await c.fileUrl(makeReq({ params: { id: '5', fileId: '7' } }), outside);
    expect(outside.statusCode).toBe(404);

    supplements.getOneTimeSupplementFile.mockResolvedValue(null);
    const foreign = makeRes();
    await c.fileUrl(makeReq({ params: { id: '6', fileId: '7' } }), foreign);
    expect(foreign.statusCode).toBe(404);

    const badId = makeRes();
    await c.fileUrl(makeReq({ params: { id: '5', fileId: 'abc' } }), badId);
    expect(badId.statusCode).toBe(404);

    const badDisposition = makeRes();
    await c.fileUrl(makeReq({ params: { id: '5', fileId: '7' }, query: { disposition: 'foo' } }), badDisposition);
    expect(badDisposition.statusCode).toBe(400);
    expect(r2.generateDownloadUrl).not.toHaveBeenCalled();
  });
});
