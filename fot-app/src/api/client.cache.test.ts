import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from './client';

/**
 * Регресс: GET /patent-receipts* обязан обходить браузерный HTTP-кэш.
 * Глобальный `private, max-age=30` из app.ts отдавал список, снятый ДО мутации:
 * удалённый чек возвращался в таблицу на ~30 сек, и его удаляли по три раза.
 * Серверный no-store не вычищает уже прогретый у пользователя кэш — добивает
 * клиентский `cache: 'no-store'`.
 */

const okResponse = (): Response => ({
  ok: true,
  status: 200,
  headers: { get: () => 'application/json' },
  json: async () => ({ success: true, data: [] }),
} as unknown as Response);

const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => okResponse());

const initOf = (call: number): RequestInit => fetchMock.mock.calls[call][1] as RequestInit;
const headersOf = (call: number): Record<string, string> =>
  initOf(call).headers as Record<string, string>;

describe('shouldBypassHttpCache — чеки за патент', () => {
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('админский список идёт мимо HTTP-кэша', async () => {
    await apiClient.get('/patent-receipts?employee_id=1');
    expect(initOf(0).cache).toBe('no-store');
    expect(headersOf(0)['Cache-Control']).toBe('no-cache');
    expect(headersOf(0)['Pragma']).toBe('no-cache');
  });

  it('список ЛК рабочего идёт мимо HTTP-кэша', async () => {
    await apiClient.get('/patent-receipts/my');
    expect(initOf(0).cache).toBe('no-store');
  });

  it('соседний путь с тем же префиксом под обход не попадает', async () => {
    await apiClient.get('/patent-receipts-archive');
    expect(initOf(0).cache).toBeUndefined();
  });

  it('контроль: обычный эндпоинт кэш не обходит', async () => {
    await apiClient.get('/structure');
    expect(initOf(0).cache).toBeUndefined();
    expect(headersOf(0)['Cache-Control']).toBeUndefined();
  });

  it('мутация DELETE не трогает cache (там уже no-store от сервера)', async () => {
    await apiClient.delete('/patent-receipts/by-document/1');
    expect(initOf(0).cache).toBeUndefined();
  });
});

/**
 * Регресс: панель назначений сотрудника перечитывает вкладки сразу после «Сохранить».
 * С кэшем max-age=30 браузер отдавал состав до сохранения — добавленный подчинённый
 * висел несохранённым, и его назначали по 2–4 раза.
 */
describe('shouldBypassHttpCache — панель назначений', () => {
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    '/direct-reports?manager_employee_id=1532',
    '/admin/employees/department-access',
    '/admin/employees/1532/skud-objects',
    '/admin/employees/1532/payroll-access',
    '/admin/weekend-approvals/1532',
    '/admin/weekend-approvals/eligible',
  ])('%s идёт мимо HTTP-кэша', async (endpoint) => {
    await apiClient.get(endpoint);
    expect(initOf(0).cache).toBe('no-store');
  });

  it('справочник объектов кэш не обходит', async () => {
    await apiClient.get('/admin/skud-objects');
    expect(initOf(0).cache).toBeUndefined();
  });
});

/** Окно «Режим табелирования» (291): после «Сохранить» список «Назначено» — с сервера. */
describe('shouldBypassHttpCache — режим табелирования', () => {
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    '/admin/timesheet-office',
    '/admin/timesheet-office/employees?search=%D0%A1%D0%B5%D0%BC',
    '/admin/timesheet-office/departments/11111111-1111-4111-8111-111111111111/employees',
  ])('%s идёт мимо HTTP-кэша', async (endpoint) => {
    await apiClient.get(endpoint);
    expect(initOf(0).cache).toBe('no-store');
  });
});
