import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

/** Контракт приёма увольнений из 1С: право ключа, ошибки разбора с путями, 409 с Retry-After, пробный режим. */

const { applyDismissalBatch } = vi.hoisted(() => ({ applyDismissalBatch: vi.fn() }));

vi.mock('../services/payroll/payroll-1c-dismissals.service.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../services/payroll/payroll-1c-dismissals.service.js')>()),
  applyDismissalBatch,
}));

import { DismissalApiError } from '../services/payroll/payroll-1c-dismissals.service.js';
import { publicDismissalsController } from './public-dismissals.controller.js';

const GUID = '11111111-1111-4111-8111-111111111111';
const DOC = {
  guid: GUID, source_revision: 17, posted: true, number: '0000-002016', date: '2026-11-20', month: '2026-11',
  organization_inn: '7736255508', employee: { employee_id: 1544, id_all: 'aaaaaaaa-0000-4000-8000-000000000001' },
  order: { dismissal_date: '2026-11-20', basis: 'п. 3 ч. 1 ст. 77' },
  accruals: { vacation_compensation: '35602.21', vacation_compensation_days: null, severance: '0.00' },
};

const makeReq = (body: unknown, query: Record<string, string> = {}, allow: boolean | null = true): Request => ({
  body, query,
  dataApiKey: allow === null ? undefined : { id: 'key-1', name: 'api_1C', rate_limit_per_minute: 60, allow_timesheet_ack: true, allow_payroll_dismissal_import: allow },
}) as unknown as Request;

const makeRes = () => {
  const response = {
    statusCode: 200, payload: null as unknown, headers: {} as Record<string, string>,
    setHeader(name: string, value: string) { this.headers[name] = value; return this; },
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.payload = body; return this; },
  };
  return response as unknown as Response & { statusCode: number; payload: any; headers: Record<string, string> };
};

describe('public-dismissals.controller', () => {
  beforeEach(() => vi.clearAllMocks());

  it('без ключа — 401, без права — 403', async () => {
    const unauthorized = makeRes();
    await publicDismissalsController.post(makeReq({ documents: [DOC] }, {}, null), unauthorized);
    expect(unauthorized.statusCode).toBe(401);
    const forbidden = makeRes();
    await publicDismissalsController.post(makeReq({ documents: [DOC] }, {}, false), forbidden);
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.payload).toMatchObject({ code: 'forbidden', retryable: false });
    expect(applyDismissalBatch).not.toHaveBeenCalled();
  });

  it('ошибка разбора — 400 invalid_body с номером документа и путём поля', async () => {
    const res = makeRes();
    await publicDismissalsController.post(makeReq({ documents: [{ ...DOC, accruals: { ...DOC.accruals, severance: 0 } }] }), res);
    expect(res.statusCode).toBe(400);
    expect(res.payload).toMatchObject({
      code: 'invalid_body', retryable: false,
      errors: [{ index: 0, guid: GUID, path: 'documents[0].accruals.severance' }],
    });
  });

  it('занято — 409 busy с Retry-After; отказ сервиса — его код и ошибки', async () => {
    applyDismissalBatch.mockRejectedValueOnce(new DismissalApiError(409, 'busy', 'занято', true));
    const busy = makeRes();
    await publicDismissalsController.post(makeReq({ documents: [DOC] }), busy);
    expect(busy.statusCode).toBe(409);
    expect(busy.headers['Retry-After']).toBe('5');
    expect(busy.payload).toMatchObject({ code: 'busy', retryable: true });

    applyDismissalBatch.mockRejectedValueOnce(new DismissalApiError(400, 'unknown_employee', 'нет', false, [
      { index: 0, guid: GUID, path: 'documents[0].employee.employee_id', message: 'нет' },
    ]));
    const unknown = makeRes();
    await publicDismissalsController.post(makeReq({ documents: [DOC] }), unknown);
    expect(unknown.statusCode).toBe(400);
    expect(unknown.payload.errors[0].path).toBe('documents[0].employee.employee_id');
  });

  it('200: пробный режим передаётся сервису, ответ — документы', async () => {
    applyDismissalBatch.mockResolvedValueOnce([{ index: 0, guid: GUID, action: 'new', employee_id: 1544, month: '2026-11', cells: [], warnings: [] }]);
    const res = makeRes();
    await publicDismissalsController.post(makeReq({ documents: [DOC] }, { dry_run: '1' }), res);
    expect(res.statusCode).toBe(200);
    expect(applyDismissalBatch).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true, keyId: 'key-1' }));
    expect(res.payload).toMatchObject({ success: true, dry_run: true, documents: [{ action: 'new' }] });
  });
});
