/**
 * Общий Documents API не должен отдавать/удалять сканы кадрового профиля (hr_*)
 * ни одним путём: /my, /employee/:id, /leave-request/:id, download по id, delete по id,
 * upload с категорией hr_*.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

const { pgQuery, pgQueryOne, pgExecute } = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  pgQueryOne: vi.fn(),
  pgExecute: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({ query: pgQuery, queryOne: pgQueryOne, execute: pgExecute }));
vi.mock('../services/r2.service.js', () => ({
  r2Service: {
    isEnabledAsync: vi.fn(async () => true),
    generateKey: vi.fn(() => 'k'),
    uploadObject: vi.fn(async () => undefined),
    deleteObject: vi.fn(async () => undefined),
    generateDownloadUrl: vi.fn(async () => 'https://r2/url'),
  },
}));
vi.mock('../services/data-scope.service.js', () => ({
  canAccessEmployeeInScope: vi.fn(async () => true),
  resolveScopedDepartmentId: vi.fn(async () => null),
}));
vi.mock('../services/access-control.service.js', () => ({ hasPageView: vi.fn(async () => false) }));
vi.mock('../services/ai-receipt-recognition.service.js', () => ({ aiReceiptRecognitionService: { enqueueRecognition: vi.fn() } }));
vi.mock('../services/image-trim.service.js', () => ({ trimWhiteBorders: vi.fn(async (b: Buffer, m: string) => ({ buffer: b, mimeType: m, size: b.length })) }));

import { documentsController } from './documents.controller.js';

const makeRes = () => {
  const res = { statusCode: 200, body: undefined as unknown, status: vi.fn(), json: vi.fn() } as unknown as Response & { statusCode: number; body: unknown };
  (res.status as unknown as ReturnType<typeof vi.fn>).mockImplementation((code: number) => { res.statusCode = code; return res; });
  (res.json as unknown as ReturnType<typeof vi.fn>).mockImplementation((body: unknown) => { res.body = body; return res; });
  return res;
};

const req = (extra: Record<string, unknown> = {}): AuthenticatedRequest =>
  ({ user: { id: 'u1', employee_id: 7, role_code: 'worker', is_admin: false }, params: {}, query: {}, body: {}, ...extra } as unknown as AuthenticatedRequest);

beforeEach(() => {
  pgQuery.mockReset();
  pgQueryOne.mockReset();
  pgExecute.mockReset();
});

describe('Documents API: исключение hr_*', () => {
  it('/my и /employee/:id фильтруют hr_* и deleted_at в SQL', async () => {
    pgQuery.mockResolvedValue([]);
    await documentsController.getMy(req(), makeRes());
    await documentsController.getByEmployee(req({ params: { empId: '7' } }), makeRes());
    const sqls = pgQuery.mock.calls.map(c => String(c[0]));
    const docSelects = sqls.filter(s => s.includes('FROM documents'));
    expect(docSelects.length).toBeGreaterThan(0);
    for (const s of docSelects) {
      expect(s).toMatch(/category NOT LIKE 'hr\\_%'/);
      expect(s).toMatch(/deleted_at IS NULL/);
    }
  });

  it('/leave-request/:id тоже фильтрует', async () => {
    pgQueryOne.mockResolvedValueOnce({ id: 1, employee_id: 7 });
    pgQuery.mockResolvedValue([]);
    await documentsController.getByLeaveRequest(req({ params: { leaveRequestId: '1' } }), makeRes());
    const docSelects = pgQuery.mock.calls.map(c => String(c[0])).filter(s => s.includes('FROM documents'));
    expect(docSelects.length).toBeGreaterThan(0);
    for (const s of docSelects) expect(s).toMatch(/category NOT LIKE 'hr\\_%'/);
  });

  it('download по id hr_* → 404', async () => {
    pgQueryOne.mockResolvedValueOnce({ id: 5, employee_id: 7, r2_key: 'k', file_name: 'p.jpg', category: 'hr_passport', deleted_at: null });
    const res = makeRes();
    await documentsController.getDownloadUrl(req({ params: { id: '5' } }), res);
    expect(res.statusCode).toBe(404);
  });

  it('download soft-deleted → 404', async () => {
    pgQueryOne.mockResolvedValueOnce({ id: 5, employee_id: 7, r2_key: 'k', file_name: 'p.jpg', category: 'scan', deleted_at: '2026-01-01' });
    const res = makeRes();
    await documentsController.getDownloadUrl(req({ params: { id: '5' } }), res);
    expect(res.statusCode).toBe(404);
  });

  it('delete по id hr_* → 404 и ничего не удаляет', async () => {
    pgQueryOne.mockResolvedValueOnce({ r2_key: 'k', employee_id: 7, category: 'hr_kig', deleted_at: null });
    const res = makeRes();
    await documentsController.remove(req({ params: { id: '5' } }), res);
    expect(res.statusCode).toBe(404);
    expect(pgExecute).not.toHaveBeenCalled();
  });

  it('upload с категорией hr_* → 400', async () => {
    const res = makeRes();
    await documentsController.uploadFile(
      req({ body: { employee_id: '7', category: 'hr_passport' }, file: { buffer: Buffer.from('x'), mimetype: 'image/jpeg', size: 1, originalname: 'a.jpg' } }) as never,
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(pgQueryOne).not.toHaveBeenCalled();
  });
});
