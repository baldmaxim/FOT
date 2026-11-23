import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

const svc = vi.hoisted(() => ({
  listDormitories: vi.fn(),
  addDormitory: vi.fn(),
  updateDormitory: vi.fn(),
  deleteDormitory: vi.fn(),
}));
vi.mock('../services/dormitory-directory.service.js', () => svc);

const audit = vi.hoisted(() => ({ logFromRequest: vi.fn(async (..._args: unknown[]) => undefined) }));
vi.mock('../services/audit.service.js', () => ({ auditService: audit }));

import { dormitoryDirectoryController as c } from './dormitory-directory.controller.js';

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  return res as unknown as Response & { statusCode: number; body: any };
};

const makeReq = (over: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest => ({
  user: { id: 'user-1' }, params: {}, query: {}, body: {}, ...over,
} as unknown as AuthenticatedRequest);

const SVOBODY = { id: 3, address: 'Общ. Свободы 35', doc_date: '2025-09-22', doc_number: '000000009', place_price: '550.00' };

beforeEach(() => vi.clearAllMocks());

describe('справочник общежитий (377)', () => {
  it('добавить: пробелы схлопнуты, пустое — null, цена до копеек; аудит DORMITORY_ADDED', async () => {
    svc.addDormitory.mockResolvedValue(SVOBODY);
    const res = makeRes();
    await c.add(makeReq({ body: { address: '  Общ.  Свободы 35 ', doc_date: '2025-09-22', doc_number: ' 000000009 ', place_price: 550 } }), res);
    expect(res.statusCode).toBe(200);
    expect(svc.addDormitory).toHaveBeenCalledWith({
      address: 'Общ. Свободы 35', doc_date: '2025-09-22', doc_number: '000000009', place_price: 550,
    });
    expect(audit.logFromRequest).toHaveBeenCalledWith(expect.anything(), 'user-1', 'DORMITORY_ADDED', expect.objectContaining({ entityId: '3' }));

    await c.add(makeReq({ body: { address: 'Общ. База Химки', doc_number: '', place_price: null } }), makeRes());
    expect(svc.addDormitory).toHaveBeenLastCalledWith({ address: 'Общ. База Химки', doc_date: null, doc_number: null, place_price: null });
  });

  it('проверка ввода: без названия, «Кв. …», неверная дата, длинный номер, лишний знак цены, ноль — 400 без записи', async () => {
    for (const body of [
      {}, { address: '   ' }, { address: 'Кв. Ляпидевского 12-58' }, { address: 'Общ. 1', doc_date: '2026-02-30' },
      { address: 'Общ. 1', doc_number: '1'.repeat(31) }, { address: 'Общ. 1', place_price: 500.123 }, { address: 'Общ. 1', place_price: 0 },
    ]) {
      const res = makeRes();
      await c.add(makeReq({ body }), res);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(svc.addDormitory).not.toHaveBeenCalled();
  });

  it('дубль — 409; переименование — аудит «было → стало» со счётом записей; без изменений — без аудита; нет — 404', async () => {
    svc.addDormitory.mockResolvedValue('duplicate');
    const dup = makeRes();
    await c.add(makeReq({ body: { address: 'Общ. Свободы 35' } }), dup);
    expect(dup.statusCode).toBe(409);

    const renamed = { ...SVOBODY, address: 'Общ. Свободы 35А' };
    svc.updateDormitory.mockResolvedValue({ before: SVOBODY, after: renamed, readdressed: 46 });
    const res = makeRes();
    await c.update(makeReq({ params: { id: '3' }, body: { address: 'Общ. Свободы 35А', place_price: 550 } }), res);
    expect(res.body).toEqual({ success: true, data: renamed });
    expect(audit.logFromRequest).toHaveBeenCalledWith(expect.anything(), 'user-1', 'DORMITORY_UPDATED', expect.objectContaining({
      details: { from: SVOBODY, to: renamed, stays_readdressed: 46 },
    }));

    audit.logFromRequest.mockClear();
    svc.updateDormitory.mockResolvedValue({ before: SVOBODY, after: SVOBODY, readdressed: 0 });
    await c.update(makeReq({ params: { id: '3' }, body: { address: 'Общ. Свободы 35' } }), makeRes());
    expect(audit.logFromRequest).not.toHaveBeenCalled();

    svc.updateDormitory.mockResolvedValue(null);
    const missing = makeRes();
    await c.update(makeReq({ params: { id: '99' }, body: { address: 'Х' } }), missing);
    expect(missing.statusCode).toBe(404);
  });

  it('удалить: с жильцами или историей — 409; без — аудит DORMITORY_DELETED', async () => {
    svc.deleteDormitory.mockResolvedValue('has_stays');
    const busy = makeRes();
    await c.remove(makeReq({ params: { id: '3' } }), busy);
    expect(busy.statusCode).toBe(409);
    expect(audit.logFromRequest).not.toHaveBeenCalled();

    svc.deleteDormitory.mockResolvedValue(SVOBODY);
    const res = makeRes();
    await c.remove(makeReq({ params: { id: '3' } }), res);
    expect(res.statusCode).toBe(200);
    expect(audit.logFromRequest).toHaveBeenCalledWith(expect.anything(), 'user-1', 'DORMITORY_DELETED', expect.anything());
  });
});
