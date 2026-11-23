import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import * as Sentry from '@sentry/node';

// Файлы шаблона графика (миграция 376): контроллер с заглушками БД, R2 и аудита. Тип файла — настоящий.

const { r2Mock } = vi.hoisted(() => ({
  r2Mock: {
    isEnabledAsync: vi.fn(async () => true),
    generateWorkScheduleKey: vi.fn((scheduleId: string, ext: string) => `work-schedules/${scheduleId}/k${ext}`),
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
    WORK_SCHEDULE_FILE_UPLOADED: 'WORK_SCHEDULE_FILE_UPLOADED',
    WORK_SCHEDULE_FILE_DELETED: 'WORK_SCHEDULE_FILE_DELETED',
  },
}));

const { txClient } = vi.hoisted(() => ({ txClient: { tag: 'tx-client' } }));
vi.mock('../config/postgres.js', () => ({
  withTransaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn(txClient)),
}));

const svc = vi.hoisted(() => ({
  getScheduleFilesTarget: vi.fn(),
  lockScheduleForFiles: vi.fn(),
  listScheduleFiles: vi.fn(),
  getScheduleFileObject: vi.fn(),
  countScheduleFiles: vi.fn(),
  insertScheduleFile: vi.fn(),
  deleteScheduleFile: vi.fn(),
}));
vi.mock('../services/schedule-files.service.js', () => ({ SCHEDULE_FILES_MAX: 20, ...svc }));

import { scheduleFilesController as c } from './schedule-files.controller.js';

type ResMock = Response & { statusCode: number; body: unknown };
const makeRes = (): ResMock => {
  const res = {} as ResMock;
  res.statusCode = 200;
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; }) as never;
  res.json = vi.fn((payload: unknown) => { res.body = payload; return res; }) as never;
  return res;
};

const SCHEDULE_ID = '6f1c2d3e-4b5a-4c6d-8e7f-90a1b2c3d4e5';
const OTHER_ID = '11111111-2222-4333-8444-555555555555';

// multer отдаёт имя байтами UTF-8, прочитанными как latin1.
const multerName = (name: string): string => Buffer.from(name, 'utf8').toString('latin1');
const PDF_BYTES = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64)]);
const pdfFile = (name = 'Приказ.pdf') => ({
  originalname: multerName(name),
  mimetype: 'application/pdf',
  size: PDF_BYTES.length,
  buffer: PDF_BYTES,
});

const req = (params: Record<string, string>, extra: Record<string, unknown> = {}): never => ({
  params,
  query: {},
  body: {},
  user: { id: 'editor-user' },
  headers: {},
  socket: {},
  ...extra,
} as never);

const CREATED = {
  id: 7, file_name: 'Приказ.pdf', file_size: PDF_BYTES.length, mime_type: 'application/pdf',
  created_at: '2026-11-23T08:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  r2Mock.isEnabledAsync.mockResolvedValue(true);
  r2Mock.uploadObject.mockResolvedValue(undefined);
  r2Mock.deleteObject.mockResolvedValue(undefined);
  svc.getScheduleFilesTarget.mockResolvedValue('active');
  svc.lockScheduleForFiles.mockResolvedValue('active');
  svc.countScheduleFiles.mockResolvedValue(0);
  svc.insertScheduleFile.mockResolvedValue(CREATED);
});

describe('scheduleFilesController.upload', () => {
  it('R2 → строка под блокировкой графика → аудит в той же транзакции', async () => {
    const res = makeRes();
    await c.upload(req({ id: SCHEDULE_ID }, { file: pdfFile() }), res);

    expect(res.statusCode).toBe(200);
    expect(r2Mock.uploadObject).toHaveBeenCalledWith(`work-schedules/${SCHEDULE_ID}/k.pdf`, PDF_BYTES, 'application/pdf');
    expect(svc.lockScheduleForFiles).toHaveBeenCalledWith(txClient, SCHEDULE_ID);
    expect(svc.insertScheduleFile).toHaveBeenCalledWith(txClient, {
      scheduleId: SCHEDULE_ID,
      r2Key: `work-schedules/${SCHEDULE_ID}/k.pdf`,
      fileName: 'Приказ.pdf',
      fileSize: PDF_BYTES.length,
      mimeType: 'application/pdf',
    });
    expect(auditMock).toHaveBeenCalledWith(txClient, expect.anything(), 'editor-user', 'WORK_SCHEDULE_FILE_UPLOADED', expect.objectContaining({
      entityType: 'work_schedule', entityId: SCHEDULE_ID,
    }));
    expect((res.body as { data: typeof CREATED }).data).toEqual(CREATED);
    expect(r2Mock.deleteObject).not.toHaveBeenCalled();
  });

  it('имя длиннее 200 символов: укорочено, расширение сохранено в нижнем регистре', async () => {
    const res = makeRes();
    await c.upload(req({ id: SCHEDULE_ID }, { file: pdfFile(`${'График смен '.repeat(25)}.PDF`) }), res);
    const fileName = svc.insertScheduleFile.mock.calls[0][1].fileName as string;
    expect(fileName.length).toBeLessThanOrEqual(200);
    expect(fileName.endsWith('.pdf')).toBe(true);
  });

  it('400 на некорректный UUID — файл не разбирается и в R2 не идёт', async () => {
    const res = makeRes();
    await c.upload(req({ id: 'not-a-uuid' }, { file: pdfFile() }), res);
    expect(res.statusCode).toBe(400);
    expect(svc.getScheduleFilesTarget).not.toHaveBeenCalled();
    expect(r2Mock.uploadObject).not.toHaveBeenCalled();
  });

  it('400 без файла', async () => {
    const res = makeRes();
    await c.upload(req({ id: SCHEDULE_ID }), res);
    expect(res.statusCode).toBe(400);
  });

  it('400: HTML под видом .pdf — с перечнем разрешённых типов', async () => {
    const res = makeRes();
    const html = { ...pdfFile(), buffer: Buffer.from('<html><script>alert(1)</script></html>'), size: 40 };
    await c.upload(req({ id: SCHEDULE_ID }, { file: html }), res);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toContain('PDF, JPG, PNG, WEBP, DOC, DOCX, XLS, XLSX');
    expect(r2Mock.uploadObject).not.toHaveBeenCalled();
  });

  it('503, если хранилище не настроено', async () => {
    r2Mock.isEnabledAsync.mockResolvedValue(false);
    const res = makeRes();
    await c.upload(req({ id: SCHEDULE_ID }, { file: pdfFile() }), res);
    expect(res.statusCode).toBe(503);
    expect(r2Mock.uploadObject).not.toHaveBeenCalled();
  });

  it('404 на несуществующий график — до R2', async () => {
    svc.getScheduleFilesTarget.mockResolvedValue('missing');
    const res = makeRes();
    await c.upload(req({ id: SCHEDULE_ID }, { file: pdfFile() }), res);
    expect(res.statusCode).toBe(404);
    expect(r2Mock.uploadObject).not.toHaveBeenCalled();
  });

  it('409 на архивный график — до R2', async () => {
    svc.getScheduleFilesTarget.mockResolvedValue('archived');
    const res = makeRes();
    await c.upload(req({ id: SCHEDULE_ID }, { file: pdfFile() }), res);
    expect(res.statusCode).toBe(409);
    expect(r2Mock.uploadObject).not.toHaveBeenCalled();
  });

  it('502, если R2 не принял файл — строки нет', async () => {
    r2Mock.uploadObject.mockRejectedValue(new Error('R2 timeout'));
    const res = makeRes();
    await c.upload(req({ id: SCHEDULE_ID }, { file: pdfFile() }), res);
    expect(res.statusCode).toBe(502);
    expect(svc.insertScheduleFile).not.toHaveBeenCalled();
  });

  it('график ушёл в архив, пока файл грузился в R2: 409 и объект удалён', async () => {
    svc.lockScheduleForFiles.mockResolvedValue('archived');
    const res = makeRes();
    await c.upload(req({ id: SCHEDULE_ID }, { file: pdfFile() }), res);
    expect(res.statusCode).toBe(409);
    expect(svc.insertScheduleFile).not.toHaveBeenCalled();
    expect(r2Mock.deleteObject).toHaveBeenCalledWith(`work-schedules/${SCHEDULE_ID}/k.pdf`);
  });

  it('20 файлов уже есть: 409 SCHEDULE_FILES_LIMIT и объект удалён', async () => {
    svc.countScheduleFiles.mockResolvedValue(20);
    const res = makeRes();
    await c.upload(req({ id: SCHEDULE_ID }, { file: pdfFile() }), res);
    expect(res.statusCode).toBe(409);
    expect((res.body as { code: string }).code).toBe('SCHEDULE_FILES_LIMIT');
    expect(svc.insertScheduleFile).not.toHaveBeenCalled();
    expect(r2Mock.deleteObject).toHaveBeenCalledTimes(1);
  });

  it('сбой вставки → объект R2 удалён, 500', async () => {
    svc.insertScheduleFile.mockRejectedValue(new Error('db down'));
    const res = makeRes();
    await c.upload(req({ id: SCHEDULE_ID }, { file: pdfFile() }), res);
    expect(res.statusCode).toBe(500);
    expect(r2Mock.deleteObject).toHaveBeenCalledWith(`work-schedules/${SCHEDULE_ID}/k.pdf`);
  });

  it('сбой аудита откатывает загрузку: объект R2 удалён', async () => {
    auditMock.mockRejectedValueOnce(new Error('audit down'));
    const res = makeRes();
    await c.upload(req({ id: SCHEDULE_ID }, { file: pdfFile() }), res);
    expect(res.statusCode).toBe(500);
    expect(r2Mock.deleteObject).toHaveBeenCalledTimes(1);
  });
});

describe('scheduleFilesController.list', () => {
  it('файлы графика в порядке прикрепления', async () => {
    const files = [CREATED, { ...CREATED, id: 8, file_name: 'График.xlsx' }];
    svc.listScheduleFiles.mockResolvedValue(files);
    const res = makeRes();
    await c.list(req({ id: SCHEDULE_ID }), res);
    expect(res.statusCode).toBe(200);
    expect((res.body as { data: unknown }).data).toEqual(files);
    expect(svc.listScheduleFiles).toHaveBeenCalledWith(SCHEDULE_ID);
  });

  it('архивный график — список отдаётся', async () => {
    svc.getScheduleFilesTarget.mockResolvedValue('archived');
    svc.listScheduleFiles.mockResolvedValue([CREATED]);
    const res = makeRes();
    await c.list(req({ id: SCHEDULE_ID }), res);
    expect(res.statusCode).toBe(200);
  });

  it('404 на несуществующий график, а не пустой список', async () => {
    svc.getScheduleFilesTarget.mockResolvedValue('missing');
    const res = makeRes();
    await c.list(req({ id: SCHEDULE_ID }), res);
    expect(res.statusCode).toBe(404);
    expect(svc.listScheduleFiles).not.toHaveBeenCalled();
  });

  it('400 на некорректный UUID', async () => {
    const res = makeRes();
    await c.list(req({ id: '1; DROP TABLE' }), res);
    expect(res.statusCode).toBe(400);
  });
});

describe('scheduleFilesController.fileUrl', () => {
  const OBJECT = { id: 7, file_name: 'Приказ.pdf', mime_type: 'application/pdf', r2_key: 'work-schedules/x/k.pdf' };

  it('inline — ссылка на 5 минут с именем файла', async () => {
    svc.getScheduleFileObject.mockResolvedValue(OBJECT);
    const res = makeRes();
    await c.fileUrl(req({ id: SCHEDULE_ID, fileId: '7' }, { query: { disposition: 'inline' } }), res);
    expect(res.statusCode).toBe(200);
    expect(svc.getScheduleFileObject).toHaveBeenCalledWith(SCHEDULE_ID, 7);
    expect(r2Mock.generateDownloadUrl).toHaveBeenCalledWith('work-schedules/x/k.pdf', 'Приказ.pdf', 'inline', 300);
    expect((res.body as { data: { url: string } }).data.url).toBe('https://signed');
  });

  it('без disposition — скачивание', async () => {
    svc.getScheduleFileObject.mockResolvedValue(OBJECT);
    const res = makeRes();
    await c.fileUrl(req({ id: SCHEDULE_ID, fileId: '7' }), res);
    expect(r2Mock.generateDownloadUrl).toHaveBeenCalledWith('work-schedules/x/k.pdf', 'Приказ.pdf', 'attachment', 300);
  });

  it('400 на неизвестный disposition и кривой fileId', async () => {
    const bad = makeRes();
    await c.fileUrl(req({ id: SCHEDULE_ID, fileId: '7' }, { query: { disposition: 'evil' } }), bad);
    expect(bad.statusCode).toBe(400);
    const badId = makeRes();
    await c.fileUrl(req({ id: SCHEDULE_ID, fileId: '1.5' }), badId);
    expect(badId.statusCode).toBe(400);
  });

  it('файл другого графика — 404', async () => {
    svc.getScheduleFileObject.mockResolvedValue(null);
    const res = makeRes();
    await c.fileUrl(req({ id: OTHER_ID, fileId: '7' }), res);
    expect(res.statusCode).toBe(404);
    expect(svc.getScheduleFileObject).toHaveBeenCalledWith(OTHER_ID, 7);
    expect(r2Mock.generateDownloadUrl).not.toHaveBeenCalled();
  });

  it('404 на несуществующий график', async () => {
    svc.getScheduleFilesTarget.mockResolvedValue('missing');
    const res = makeRes();
    await c.fileUrl(req({ id: SCHEDULE_ID, fileId: '7' }), res);
    expect(res.statusCode).toBe(404);
  });

  it('503, если хранилище не настроено', async () => {
    svc.getScheduleFileObject.mockResolvedValue(OBJECT);
    r2Mock.isEnabledAsync.mockResolvedValue(false);
    const res = makeRes();
    await c.fileUrl(req({ id: SCHEDULE_ID, fileId: '7' }), res);
    expect(res.statusCode).toBe(503);
  });
});

describe('scheduleFilesController.remove', () => {
  it('строка и аудит в транзакции под блокировкой, объект R2 — после', async () => {
    svc.deleteScheduleFile.mockResolvedValue({ r2Key: 'work-schedules/x/k.pdf', fileName: 'Приказ.pdf' });
    const res = makeRes();
    await c.remove(req({ id: SCHEDULE_ID, fileId: '7' }), res);
    expect(res.statusCode).toBe(200);
    expect(svc.lockScheduleForFiles).toHaveBeenCalledWith(txClient, SCHEDULE_ID);
    expect(svc.deleteScheduleFile).toHaveBeenCalledWith(txClient, SCHEDULE_ID, 7);
    expect(auditMock).toHaveBeenCalledWith(txClient, expect.anything(), 'editor-user', 'WORK_SCHEDULE_FILE_DELETED', expect.objectContaining({
      entityType: 'work_schedule', entityId: SCHEDULE_ID, details: { file_id: 7, file_name: 'Приказ.pdf' },
    }));
    expect(r2Mock.deleteObject).toHaveBeenCalledWith('work-schedules/x/k.pdf');
  });

  it('сбой удаления в R2 после коммита — 200, лог и Sentry', async () => {
    svc.deleteScheduleFile.mockResolvedValue({ r2Key: 'work-schedules/x/k.pdf', fileName: 'Приказ.pdf' });
    r2Mock.deleteObject.mockRejectedValue(new Error('R2 down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = makeRes();
    await c.remove(req({ id: SCHEDULE_ID, fileId: '7' }), res);
    expect(res.statusCode).toBe(200);
    expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({
      tags: { area: 'work-schedule-files' },
    }));
    warn.mockRestore();
  });

  it('файл другого графика — 404, R2 не трогаем', async () => {
    svc.deleteScheduleFile.mockResolvedValue(null);
    const res = makeRes();
    await c.remove(req({ id: OTHER_ID, fileId: '7' }), res);
    expect(res.statusCode).toBe(404);
    expect(auditMock).not.toHaveBeenCalled();
    expect(r2Mock.deleteObject).not.toHaveBeenCalled();
  });

  it('409 на архивный график', async () => {
    svc.lockScheduleForFiles.mockResolvedValue('archived');
    const res = makeRes();
    await c.remove(req({ id: SCHEDULE_ID, fileId: '7' }), res);
    expect(res.statusCode).toBe(409);
    expect(svc.deleteScheduleFile).not.toHaveBeenCalled();
  });

  it('404 на несуществующий график', async () => {
    svc.lockScheduleForFiles.mockResolvedValue('missing');
    const res = makeRes();
    await c.remove(req({ id: SCHEDULE_ID, fileId: '7' }), res);
    expect(res.statusCode).toBe(404);
  });

  it('400 на кривые id', async () => {
    const badSchedule = makeRes();
    await c.remove(req({ id: 'x', fileId: '7' }), badSchedule);
    expect(badSchedule.statusCode).toBe(400);
    const badFile = makeRes();
    await c.remove(req({ id: SCHEDULE_ID, fileId: '0' }), badFile);
    expect(badFile.statusCode).toBe(400);
  });
});
