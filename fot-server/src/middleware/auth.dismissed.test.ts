/**
 * Блокировка портала для уволенных и неактивных (миграция 381).
 *
 * Инцидент: сотрудник уволен 31.08, но продолжал заходить и согласовывать заявления
 * подчинённых — статус сотрудника не проверялся ни в одной точке входа, а access-токен
 * живёт 7 дней. Проверка динамическая: увольнение ничего не стирает, восстановление
 * (employment_status → 'active') открывает доступ само, вместе со всеми данными.
 *
 * Неактивный («Декрет»/«Архив» или ручная метка) тоже не допускается, кроме служебной учётки
 * с login_when_staff_inactive. Блокировка проверяется ДО сверки token_version: перевод в неактивные
 * отзывает токены, и человек должен получить 403 с причиной, а не 401.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { NextFunction, Response } from 'express';
import jwt from 'jsonwebtoken';

const h = vi.hoisted(() => ({ queryOne: vi.fn(), query: vi.fn() }));

vi.mock('../config/postgres.js', () => ({ queryOne: h.queryOne, query: h.query }));
vi.mock('@sentry/node', () => ({
  getCurrentScope: () => ({ setUser: vi.fn(), setContext: vi.fn(), setTag: vi.fn() }),
  setUser: vi.fn(), setContext: vi.fn(), captureException: vi.fn(), captureMessage: vi.fn(),
}));

import { authenticate } from './auth.js';
import { invalidateDeptTreeCache } from '../services/skud-shared.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

const SECRET = process.env.JWT_SECRET || 'test-secret';

const DECRET_ID = '7a0c3e8e-0000-4000-8000-000000000001';
const DECRET_CHILD_ID = '7a0c3e8e-0000-4000-8000-000000000002';

const makeToken = (over: Record<string, unknown> = {}) => jwt.sign({
  sub: '3098891c-3de1-4c20-a7a4-e07b52d9ec68',
  email: 'user@example.com',
  is_approved: true,
  token_version: 0,
  two_factor_enabled: false,
  two_factor_verified: true,
  ...over,
}, SECRET, { algorithm: 'HS256' });

interface IFreshRow {
  employment_status: string | null;
  staff_inactive?: boolean | null;
  login_when_staff_inactive?: boolean | null;
  token_version?: number;
}

const run = async (
  row: string | null | IFreshRow,
  tokenOver: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown>; passed: boolean }> => {
  const fresh = typeof row === 'object' && row !== null ? row : { employment_status: row };
  h.queryOne.mockResolvedValue({ token_version: 0, staff_inactive: false, login_when_staff_inactive: false, ...fresh });
  let status = 200;
  let body: Record<string, unknown> = {};
  const res = {
    status: (s: number) => { status = s; return res; },
    json: (payload: Record<string, unknown>) => { body = payload; return res; },
  } as unknown as Response;
  let passed = false;
  const next: NextFunction = () => { passed = true; };
  const req = { headers: { authorization: `Bearer ${makeToken(tokenOver)}` } } as unknown as AuthenticatedRequest;

  await authenticate(req, res, next);
  return { status, body, passed };
};

beforeEach(() => {
  h.queryOne.mockReset();
  h.query.mockReset();
  h.query.mockResolvedValue([
    { id: 'root', parent_id: null, name: 'Объект', sigur_department_id: null },
    { id: DECRET_ID, parent_id: 'root', name: ' Декрет ', sigur_department_id: 1 },
    { id: DECRET_CHILD_ID, parent_id: DECRET_ID, name: 'Группа', sigur_department_id: 2 },
  ]);
  invalidateDeptTreeCache();
});

describe('authenticate: уволенный на портал не допускается', () => {
  it('fired → 403 EMPLOYEE_DISMISSED', async () => {
    const r = await run('fired');
    expect(r.passed).toBe(false);
    // 403, а не 401: токен валиден, обновлять его незачем — клиент повторяет только 401.
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('EMPLOYEE_DISMISSED');
  });

  it('active → проходит', async () => {
    const r = await run('active');
    expect(r.passed).toBe(true);
    expect(r.status).toBe(200);
  });

  it('профиль без карточки сотрудника → проходит (подрядчики и сервисные учётки)', async () => {
    const r = await run(null);
    expect(r.passed).toBe(true);
  });

  it('статус читается тем же запросом, что и token_version — лишнего похода в БД нет', async () => {
    await run('active');
    expect(h.queryOne).toHaveBeenCalledTimes(1);
    const [sql, params] = h.queryOne.mock.calls[0] as [string, unknown[]];
    expect(String(sql)).toContain('LEFT JOIN employees');
    expect(String(sql)).toContain('token_version');
    expect(String(sql)).toContain('login_when_staff_inactive');
    // Отделы «Декрет»/«Архив» — с потомками, вторым параметром того же запроса.
    expect(params[1]).toEqual([DECRET_ID, DECRET_CHILD_ID]);
  });
});

describe('authenticate: неактивный (миграция 381)', () => {
  it('неактивный → 403 EMPLOYEE_INACTIVE', async () => {
    const r = await run({ employment_status: 'active', staff_inactive: true });
    expect(r.passed).toBe(false);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('EMPLOYEE_INACTIVE');
    expect(r.body.error).toBe('Учётная запись отключена: сотрудник переведён в неактивные');
  });

  it('служебная учётка с login_when_staff_inactive → проходит', async () => {
    const r = await run({ employment_status: 'active', staff_inactive: true, login_when_staff_inactive: true });
    expect(r.passed).toBe(true);
  });

  it('служебная учётка уволенного → 403 EMPLOYEE_DISMISSED: исключение только от неактивности', async () => {
    const r = await run({ employment_status: 'fired', staff_inactive: false, login_when_staff_inactive: true });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('EMPLOYEE_DISMISSED');
  });

  it('перевод отозвал токен → 403 с причиной, а не 401 (блокировка раньше сверки версии)', async () => {
    const r = await run({ employment_status: 'active', staff_inactive: true, token_version: 5 }, { token_version: 4 });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('EMPLOYEE_INACTIVE');
  });

  it('уволенный с отозванным токеном → 403 EMPLOYEE_DISMISSED', async () => {
    const r = await run({ employment_status: 'fired', token_version: 3 }, { token_version: 2 });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('EMPLOYEE_DISMISSED');
  });

  it('после «Вернуть в активные» старый токен → 401 Token revoked', async () => {
    const r = await run({ employment_status: 'active', staff_inactive: false, token_version: 5 }, { token_version: 4 });
    expect(r.passed).toBe(false);
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('Token revoked');
  });
});
