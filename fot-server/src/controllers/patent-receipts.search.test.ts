import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * «Чеки за патент» → поиск по ФИО: ё = е (раньше «Семёнов» со строчной «ё» не находился), раскладка;
 * точных нет после фильтров дат и проверки — с одной ошибкой; выборка упёрлась в лимит 500 — опечатку не включаем.
 */

const { h } = vi.hoisted(() => ({ h: { query: vi.fn() } }));

vi.mock('../config/postgres.js', () => ({ query: h.query, queryOne: vi.fn(), execute: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../services/r2.service.js', () => ({ r2Service: { generateDownloadUrl: vi.fn(async () => 'https://r2/x') } }));
vi.mock('../services/ai-receipt-recognition.service.js', () => ({ aiReceiptRecognitionService: {} }));
vi.mock('../services/image-trim.service.js', () => ({ trimWhiteBorders: vi.fn() }));
vi.mock('../services/image-normalize.service.js', () => ({ ensureBrowserFriendlyImage: vi.fn() }));
vi.mock('../services/settings.service.js', () => ({ isAllowedOcrModel: vi.fn() }));
vi.mock('../services/patent-receipt-encryption.helper.js', () => ({
  decryptReceiptRow: (row: Record<string, unknown>) => row,
  decryptRawResponse: vi.fn(),
  encryptReceiptFields: vi.fn(),
}));
vi.mock('../services/realtime-broadcast.service.js', () => ({ emitDomainChange: vi.fn() }));
vi.mock('../services/recipients.service.js', () => ({ getEmployeeUserId: vi.fn() }));
vi.mock('../services/patent-missing-receipts.service.js', () => ({
  getMissingPatentReceipts: vi.fn(), getSu10Departments: vi.fn(),
}));

const { patentReceiptsController } = await import('./patent-receipts.controller.js');

const doc = (id: number, name: string, paymentDate = '2026-10-05') => ({
  id, employee_id: id, file_name: null, mime_type: null, r2_key: null, recognition_status: 'done',
  recognition_attempts: 0, recognized_at: null, recognition_error: null, created_at: '2026-10-05',
  employee_full_name: name, receipt_id: id, receipt_data: { id, payment_date: paymentDate, needs_review: false },
});

const call = async (query: Record<string, string>) => {
  const res = {
    body: null as unknown as { data: Array<{ employee_id: number }> },
    status() { return res; },
    json(body: unknown) { res.body = body as typeof res.body; return res; },
  };
  await patentReceiptsController.list({ query, user: { id: 'u', is_admin: true } } as unknown as AuthenticatedRequest, res as unknown as Response);
  return res.body.data.map(row => row.employee_id);
};

beforeEach(() => {
  h.query.mockReset();
});

describe('patentReceiptsController.list — поиск', () => {
  it('«Семёнов» находится по «семенов»: регулярное выражение по ФИО (ё = е, регистр)', async () => {
    h.query.mockResolvedValue([doc(1, 'Семёнов Иван')]);
    expect(await call({ search: 'семенов' })).toEqual([1]);
    const [sql, params] = h.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('(e.full_name ~* $1)');
    expect(params).toEqual(['с[её]м[её]нов']);
    expect(h.query).toHaveBeenCalledTimes(1);
  });

  it('точный убран фильтром дат — ищется с одной ошибкой', async () => {
    h.query
      .mockResolvedValueOnce([doc(1, 'Семёнов Иван', '2026-01-10')])
      .mockResolvedValueOnce([doc(1, 'Семёнов Иван', '2026-01-10'), doc(2, 'Семенав Олег', '2026-10-05')]);
    expect(await call({ search: 'семенов', from: '2026-10-01' })).toEqual([2]);
    expect(String(h.query.mock.calls[1][0])).toContain('e.id IN (SELECT fz.id FROM unnest($1::text[])');
  });

  it('выборка упёрлась в лимит 500 — точный мог остаться за ним, опечатку не включаем', async () => {
    h.query.mockResolvedValue(Array.from({ length: 500 }, (_, i) => doc(i + 1, 'Семёнов Иван', '2026-01-10')));
    expect(await call({ search: 'семенов', from: '2026-10-01' })).toEqual([]);
    expect(h.query).toHaveBeenCalledTimes(1);
  });
});
