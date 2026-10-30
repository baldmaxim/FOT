import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

const service = vi.hoisted(() => ({
  listSupplementReasons: vi.fn(),
  addSupplementReason: vi.fn(),
  renameSupplementReason: vi.fn(),
  removeSupplementReason: vi.fn(),
}));
vi.mock('../services/payroll/payroll-supplement-reasons.service.js', () => service);

const audit = vi.hoisted(() => ({ logFromRequest: vi.fn(async (..._args: unknown[]) => undefined) }));
vi.mock('../services/audit.service.js', () => ({ auditService: audit }));

import { payrollSupplementReasonsController as controller } from './payroll-supplement-reasons.controller.js';

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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('основания разовой доплаты: список и добавление', () => {
  it('список — как отдал сервис', async () => {
    service.listSupplementReasons.mockResolvedValue([{ id: 1, name: 'Премия' }]);
    const res = makeRes();
    await controller.list(makeReq(), res);
    expect(res.body).toEqual({ success: true, data: [{ id: 1, name: 'Премия' }] });
  });

  it('пробелы схлопываются, основание добавляется и пишется в аудит', async () => {
    service.addSupplementReason.mockResolvedValue({ id: 7, name: 'Премия квартальная' });
    const res = makeRes();
    await controller.add(makeReq({ body: { name: '  Премия   квартальная ' } }), res);
    expect(res.statusCode).toBe(200);
    expect(service.addSupplementReason).toHaveBeenCalledWith('Премия квартальная');
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'PAYROLL_SUPPLEMENT_REASON_ADDED',
      expect.objectContaining({ entityId: '7', details: { name: 'Премия квартальная' } }),
    );
  });

  it('пустое и длиннее 100 — 400 без записи; повтор — 409 DUPLICATE_REASON без аудита', async () => {
    for (const name of ['   ', 'а'.repeat(101)]) {
      const res = makeRes();
      await controller.add(makeReq({ body: { name } }), res);
      expect(res.statusCode).toBe(400);
    }
    expect(service.addSupplementReason).not.toHaveBeenCalled();

    service.addSupplementReason.mockResolvedValue(null);
    const res = makeRes();
    await controller.add(makeReq({ body: { name: 'Премия' } }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ error: 'Такое основание уже есть', code: 'DUPLICATE_REASON' });
    expect(audit.logFromRequest).not.toHaveBeenCalled();
  });
});

describe('основания разовой доплаты: переименование и удаление', () => {
  it('переименование — аудит «было → стало» с числом изменённых доплат', async () => {
    service.renameSupplementReason.mockResolvedValue({
      reason: { id: 3, name: 'Дополнительные работы' }, previousName: 'Допработы', supplements: 25,
    });
    const res = makeRes();
    await controller.rename(makeReq({ params: { id: '3' }, body: { name: 'Дополнительные работы' } }), res);
    expect(res.body.data).toEqual({ id: 3, name: 'Дополнительные работы' });
    expect(service.renameSupplementReason).toHaveBeenCalledWith(3, 'Дополнительные работы');
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'PAYROLL_SUPPLEMENT_REASON_RENAMED',
      expect.objectContaining({ details: { from: 'Допработы', to: 'Дополнительные работы', supplements: 25 } }),
    );
  });

  it('то же название — без аудита; нет основания — 404; занято — 409', async () => {
    service.renameSupplementReason.mockResolvedValueOnce({
      reason: { id: 3, name: 'Премия' }, previousName: 'Премия', supplements: 0,
    });
    const same = makeRes();
    await controller.rename(makeReq({ params: { id: '3' }, body: { name: 'Премия' } }), same);
    expect(same.statusCode).toBe(200);
    expect(audit.logFromRequest).not.toHaveBeenCalled();

    const badId = makeRes();
    await controller.rename(makeReq({ params: { id: 'x' }, body: { name: 'Премия' } }), badId);
    expect(badId.statusCode).toBe(404);

    service.renameSupplementReason.mockResolvedValueOnce(null);
    const missing = makeRes();
    await controller.rename(makeReq({ params: { id: '9' }, body: { name: 'Премия' } }), missing);
    expect(missing.statusCode).toBe(404);

    service.renameSupplementReason.mockResolvedValueOnce('duplicate');
    const taken = makeRes();
    await controller.rename(makeReq({ params: { id: '3' }, body: { name: 'Резерв' } }), taken);
    expect(taken.statusCode).toBe(409);
    expect(taken.body.code).toBe('DUPLICATE_REASON');
  });

  it('удаление — аудит с названием; нет основания — 404', async () => {
    service.removeSupplementReason.mockResolvedValueOnce({ id: 4, name: 'Резерв' });
    const res = makeRes();
    await controller.remove(makeReq({ params: { id: '4' } }), res);
    expect(res.body.data).toEqual({ id: 4, name: 'Резерв' });
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'PAYROLL_SUPPLEMENT_REASON_DELETED',
      expect.objectContaining({ entityId: '4', details: { name: 'Резерв' } }),
    );

    service.removeSupplementReason.mockResolvedValueOnce(null);
    const missing = makeRes();
    await controller.remove(makeReq({ params: { id: '5' } }), missing);
    expect(missing.statusCode).toBe(404);
    const badId = makeRes();
    await controller.remove(makeReq({ params: { id: '0' } }), badId);
    expect(badId.statusCode).toBe(404);
  });
});
