import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import * as XLSX from 'xlsx';

/**
 * Загрузка файла графика целиком: настоящий роутер, multer и контроллер; БД, R2 и аудит — заглушки.
 * Проверяет то, что юнит-тесты собирают руками: имя файла из multipart (кириллица) и тип по содержимому.
 */

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
vi.mock('../services/audit.service.js', () => ({
  auditService: { logFromRequestWithClient: vi.fn(async () => undefined) },
  AUDIT_ACTIONS: { WORK_SCHEDULE_FILE_UPLOADED: 'U', WORK_SCHEDULE_FILE_DELETED: 'D' },
}));
vi.mock('../config/postgres.js', () => ({
  withTransaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({})),
}));
const svc = vi.hoisted(() => ({
  getScheduleFilesTarget: vi.fn(async () => 'active'),
  lockScheduleForFiles: vi.fn(async () => 'active'),
  listScheduleFiles: vi.fn(async () => []),
  getScheduleFileObject: vi.fn(async () => null),
  countScheduleFiles: vi.fn(async () => 0),
  insertScheduleFile: vi.fn(async (_client: unknown, params: { fileName: string; fileSize: number; mimeType: string }) => ({
    id: 1, file_name: params.fileName, file_size: params.fileSize, mime_type: params.mimeType, created_at: '2026-11-23T08:00:00.000Z',
  })),
  deleteScheduleFile: vi.fn(async () => null),
}));
vi.mock('../services/schedule-files.service.js', () => ({ SCHEDULE_FILES_MAX: 20, ...svc }));

vi.mock('../middleware/auth.js', () => ({
  authenticate: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: 'editor' };
    next();
  },
  requireAnyPageAccess: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../middleware/cacheResponse.js', () => ({ invalidateCaches: vi.fn() }));
// Остальные маршруты роутера здесь не вызываются: любой обработчик — заглушка.
const { stub } = vi.hoisted(() => ({
  stub: new Proxy({}, { get: () => (_req: unknown, res: { status: (code: number) => { end: () => void } }) => res.status(501).end() }),
}));
vi.mock('../controllers/schedule.controller.js', () => ({ scheduleController: stub }));
vi.mock('../controllers/schedule-export.controller.js', () => ({ scheduleExportController: stub }));

import scheduleRoutes from '../routes/schedule.routes.js';

const app = express();
app.use('/api/schedules', scheduleRoutes);

const ID = '6f1c2d3e-4b5a-4c6d-8e7f-90a1b2c3d4e5';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const workbook = (): Buffer => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Смена', '09:00-18:00']]), 'График');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/schedules/:id/files — вся цепочка', () => {
  it('xlsx с кириллическим именем: имя сохранено как есть, тип — по содержимому', async () => {
    const res = await request(app)
      .post(`/api/schedules/${ID}/files`)
      .attach('file', workbook(), { filename: 'График сменности ноябрь.xlsx', contentType: 'application/octet-stream' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ file_name: 'График сменности ноябрь.xlsx', mime_type: XLSX_MIME });
    expect(r2Mock.uploadObject).toHaveBeenCalledWith(`work-schedules/${ID}/k.xlsx`, expect.any(Buffer), XLSX_MIME);
  });

  it('PDF-байты под именем .xlsx — 400, в R2 не уходит', async () => {
    const res = await request(app)
      .post(`/api/schedules/${ID}/files`)
      .attach('file', Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64)]), { filename: 'График.xlsx', contentType: XLSX_MIME });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('«График.xlsx»');
    expect(r2Mock.uploadObject).not.toHaveBeenCalled();
  });

  it('два файла в одном запросе — 400 от multer', async () => {
    const res = await request(app)
      .post(`/api/schedules/${ID}/files`)
      .attach('file', workbook(), 'a.xlsx')
      .attach('file', workbook(), 'b.xlsx');

    expect(res.status).toBe(400);
    expect(svc.insertScheduleFile).not.toHaveBeenCalled();
  });
});
