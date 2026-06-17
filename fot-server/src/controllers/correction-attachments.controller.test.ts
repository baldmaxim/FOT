import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';

const { accessMock } = vi.hoisted(() => ({
  accessMock: vi.fn(async () => true),
}));
vi.mock('../services/data-scope.service.js', () => ({
  canAccessEmployeeInScope: accessMock,
}));

const { r2Mock } = vi.hoisted(() => ({
  r2Mock: {
    isEnabledAsync: vi.fn(async () => true),
    generateKey: vi.fn(() => 'r2/key'),
    uploadObject: vi.fn(async () => undefined),
    deleteObject: vi.fn(async () => undefined),
    generateDownloadUrl: vi.fn(async () => 'https://signed'),
  },
}));
vi.mock('../services/r2.service.js', () => ({ r2Service: r2Mock }));

vi.mock('../utils/file-validation.utils.js', () => ({ sanitizeFileName: (s: string) => s }));
vi.mock('../utils/multer-filename.utils.js', () => ({ decodeMulterFilename: (s: string) => s }));

const { loadAdjustmentsByIdsMock, createForManyMock } = vi.hoisted(() => ({
  loadAdjustmentsByIdsMock: vi.fn(),
  createForManyMock: vi.fn(),
}));
vi.mock('../services/correction-attachments.service.js', () => ({
  createCorrectionAttachment: vi.fn(),
  createCorrectionAttachmentForMany: createForManyMock,
  deleteCorrectionAttachment: vi.fn(),
  listCorrectionAttachments: vi.fn(),
  loadAdjustmentsByIds: loadAdjustmentsByIdsMock,
  loadCorrectionAdjustmentById: vi.fn(),
  loadCorrectionDocumentEmployeeIds: vi.fn(),
}));

import { correctionAttachmentsController } from './correction-attachments.controller.js';

type ResMock = Response & { statusCode: number; body: unknown };
const makeRes = (): ResMock => {
  const res = {} as ResMock;
  res.statusCode = 200;
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; }) as never;
  res.json = vi.fn((payload: unknown) => { res.body = payload; return res; }) as never;
  return res;
};

const makeReq = (adjustmentIds: number[]): never => ({
  file: { originalname: 'Отпуск.jpg', mimetype: 'image/jpeg', size: 100, buffer: Buffer.from('x') },
  body: { adjustment_ids: JSON.stringify(adjustmentIds) },
  user: { id: 'mgr-user' },
} as never);

beforeEach(() => {
  vi.clearAllMocks();
  accessMock.mockResolvedValue(true);
  r2Mock.isEnabledAsync.mockResolvedValue(true);
});

describe('correctionAttachmentsController.uploadBulk', () => {
  it('400, если корректировки разных сотрудников', async () => {
    loadAdjustmentsByIdsMock.mockResolvedValue([
      { id: 1, employee_id: 10 },
      { id: 2, employee_id: 20 },
    ]);
    const res = makeRes();
    await correctionAttachmentsController.uploadBulk(makeReq([1, 2]), res);
    expect(res.statusCode).toBe(400);
    expect(createForManyMock).not.toHaveBeenCalled();
  });

  it('400, если часть корректировок не найдена', async () => {
    loadAdjustmentsByIdsMock.mockResolvedValue([{ id: 1, employee_id: 10 }]);
    const res = makeRes();
    await correctionAttachmentsController.uploadBulk(makeReq([1, 2]), res);
    expect(res.statusCode).toBe(400);
    expect(createForManyMock).not.toHaveBeenCalled();
  });

  it('403, если нет доступа к сотруднику', async () => {
    loadAdjustmentsByIdsMock.mockResolvedValue([
      { id: 1, employee_id: 10 },
      { id: 2, employee_id: 10 },
    ]);
    accessMock.mockResolvedValue(false);
    const res = makeRes();
    await correctionAttachmentsController.uploadBulk(makeReq([1, 2]), res);
    expect(res.statusCode).toBe(403);
    expect(createForManyMock).not.toHaveBeenCalled();
  });

  it('грузит один общий документ на все дни одного сотрудника', async () => {
    loadAdjustmentsByIdsMock.mockResolvedValue([
      { id: 1, employee_id: 10 },
      { id: 2, employee_id: 10 },
    ]);
    createForManyMock.mockResolvedValue({
      id: 777, source: 'adjustment', original_name: 'Отпуск.jpg',
      mime_type: 'image/jpeg', file_size: 100, uploaded_at: '2026-06-01T00:00:00Z',
      uploader_name: null, r2_key: 'r2/key',
    });
    const res = makeRes();
    await correctionAttachmentsController.uploadBulk(makeReq([1, 2]), res);

    expect(res.statusCode).toBe(200);
    expect(r2Mock.uploadObject).toHaveBeenCalledTimes(1);
    expect(createForManyMock).toHaveBeenCalledTimes(1);
    expect(createForManyMock.mock.calls[0][0]).toMatchObject({ adjustmentIds: [1, 2], employeeId: 10 });
    expect((res.body as { data: { id: number } }).data.id).toBe(777);
  });
});
