import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

/**
 * Контракт API для ЗУП3 «сотрудники месяца»: гейт ключа, разбор параметров, коды ошибок и конверт ответа.
 * Расчёт и снимки замоканы — их проверяют staff-month-1c.*.test.ts и scripts/check-staff-month-api.ts.
 */

const { getKeyTables, listEmployees, getSnapshot } = vi.hoisted(() => ({
  getKeyTables: vi.fn(),
  listEmployees: vi.fn(),
  getSnapshot: vi.fn(),
}));

vi.mock('../services/data-api-key.service.js', () => ({ dataApiKeyService: { getKeyTables } }));

vi.mock('../services/staff-month-1c.service.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../services/staff-month-1c.service.js')>()),
  listStaffMonthEmployees: listEmployees,
  getStaffMonthSnapshot: getSnapshot,
}));

import { StaffMonthApiError } from '../services/staff-month-1c.service.js';
import { parseStaffMonth, publicStaffMonthController } from './public-staff-month.controller.js';

const SNAPSHOT = {
  id: '3f1d2c4b-0000-4000-8000-000000000001',
  month: '2026-10',
  bounds: { month: '2026-10', start: '2026-10-01', end: '2026-10-31', until: '2026-10-31', open: false },
  generatedAt: '2026-11-19T10:00:00.000Z',
  preliminary: false,
  rows: [{ employee_id: 1 }, { employee_id: 2 }],
  brigades: [{ department_id: 'b1', name: 'бр.Амонов М.Н.', object: null, objects: [], members: [] }],
  objects: [{ object: { key: 'office', id: null, name: 'Офис', address: null }, employees_fact: 1, employees_main: 2, hours: 8 }],
  meta: { duplicate_days: 0, object_config_errors: 0, objects_not_frozen: 0 },
};

const makeReq = (query: Record<string, string | string[]>, withKey = true): Request => ({
  query,
  dataApiKey: withKey ? { id: 'key-1', name: 'api_1C', rate_limit_per_minute: 300, allow_timesheet_ack: false } : undefined,
}) as unknown as Request;

const makeRes = () => {
  const response = {
    statusCode: 200,
    payload: null as unknown,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) { this.headers[name] = value; return this; },
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.payload = body; return this; },
  };
  return response as unknown as Response & { statusCode: number; payload: any; headers: Record<string, string> };
};

describe('public-staff-month.controller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getKeyTables.mockResolvedValue([{ table_name: 'employees' }]);
    listEmployees.mockResolvedValue({ snapshot: SNAPSHOT, rows: [{ employee_id: 1 }], total: 2, nextCursor: 'c1' });
    getSnapshot.mockResolvedValue(SNAPSHOT);
  });

  it('месяц: настоящий YYYY-MM, с 2026-06, не будущий (по Москве)', () => {
    const now = new Date('2026-11-19T10:00:00Z');
    const code = (raw: string | null) => {
      try {
        parseStaffMonth(raw, now);
        return 'ok';
      } catch (err) {
        return (err as StaffMonthApiError).code;
      }
    };
    expect(code('2026-10')).toBe('ok');
    expect(code('2026-11')).toBe('ok');
    expect(code('2026-13')).toBe('invalid_month');
    expect(code('2026-12')).toBe('invalid_month');
    expect(code('2026-05')).toBe('month_not_supported');
    expect(code(null)).toBe('invalid_month');
    // 30.11 21:30 UTC — уже 1 декабря по Москве.
    expect((() => { try { parseStaffMonth('2026-12', new Date('2026-11-30T21:30:00Z')); return 'ok'; } catch { return 'err'; } })()).toBe('ok');
  });

  it('без ключа — 401, ключу не открыта employees — 403', async () => {
    const res401 = makeRes();
    await publicStaffMonthController.employees(makeReq({ month: '2026-10' }, false), res401);
    expect(res401.statusCode).toBe(401);
    getKeyTables.mockResolvedValue([{ table_name: 'org_departments' }]);
    const res403 = makeRes();
    await publicStaffMonthController.employees(makeReq({ month: '2026-10' }), res403);
    expect(res403.statusCode).toBe(403);
    expect(listEmployees).not.toHaveBeenCalled();
  });

  it('сотрудники: конверт ответа и фильтры', async () => {
    const res = makeRes();
    await publicStaffMonthController.employees(makeReq({
      month: '2026-10', object_key: 'OFFICE', category: 'worker', employee_id: '42', days: '1', limit: '500',
    }), res);
    expect(res.statusCode).toBe(200);
    expect(listEmployees).toHaveBeenCalledWith({
      month: '2026-10',
      filters: { object_key: 'office', category: 'worker', employee_id: 42, days: true },
      limit: 500,
      cursor: null,
      snapshotId: null,
    });
    expect(res.payload).toEqual({
      success: true,
      period: { month: '2026-10', from: '2026-10-01', to: '2026-10-31', as_of: '2026-10-31' },
      snapshot: { id: SNAPSHOT.id, generated_at: SNAPSHOT.generatedAt, preliminary: false },
      data: [{ employee_id: 1 }],
      meta: { employees_count: 2, duplicate_days: 0, object_config_errors: 0, objects_not_frozen: 0 },
      next_cursor: 'c1',
    });
  });

  it.each([
    [{ month: '2026-10', limit: '0' }],
    [{ month: '2026-10', limit: '501' }],
    [{ month: '2026-10', category: 'boss' }],
    [{ month: '2026-10', object_key: 'ЖК Ситибэй' }],
    [{ month: '2026-10', employee_id: '-1' }],
    [{ month: '2026-10', snapshot_id: 'abc' }],
    [{ month: '2026-10', days: 'yes' }],
    [{ month: ['2026-10', '2026-11'] }],
  ])('400 invalid_* на %o', async query => {
    const res = makeRes();
    await publicStaffMonthController.employees(makeReq(query), res);
    expect(res.statusCode).toBe(400);
    expect(res.payload.success).toBe(false);
    expect(res.payload.retryable).toBe(false);
    expect(String(res.payload.code)).toMatch(/^invalid_/);
  });

  it('ошибки сервиса: 409 snapshot_expired, 503 snapshot_building с Retry-After', async () => {
    listEmployees.mockRejectedValueOnce(new StaffMonthApiError(409, 'snapshot_expired', 'устарел', false));
    const res409 = makeRes();
    await publicStaffMonthController.employees(makeReq({ month: '2026-10', cursor: 'x' }), res409);
    expect(res409.statusCode).toBe(409);
    expect(res409.payload).toMatchObject({ success: false, code: 'snapshot_expired', retryable: false });

    getSnapshot.mockRejectedValueOnce(new StaffMonthApiError(503, 'snapshot_building', 'собирается', true));
    const res503 = makeRes();
    await publicStaffMonthController.brigades(makeReq({ month: '2026-10' }), res503);
    expect(res503.statusCode).toBe(503);
    expect(res503.headers['Retry-After']).toBe('15');
    expect(res503.payload).toMatchObject({ code: 'snapshot_building', retryable: true });
  });

  it('бригады и объекты — из того же снимка (snapshot_id)', async () => {
    const res = makeRes();
    await publicStaffMonthController.objects(makeReq({ month: '2026-10', snapshot_id: SNAPSHOT.id.toUpperCase() }), res);
    expect(getSnapshot).toHaveBeenCalledWith('2026-10', SNAPSHOT.id);
    expect(res.payload.data).toEqual(SNAPSHOT.objects);
    expect(res.payload.meta.employees_count).toBe(2);
    const resBrigades = makeRes();
    await publicStaffMonthController.brigades(makeReq({ month: '2026-10' }), resBrigades);
    expect(resBrigades.payload.data).toEqual(SNAPSHOT.brigades);
    expect(resBrigades.payload.next_cursor).toBeNull();
  });
});
