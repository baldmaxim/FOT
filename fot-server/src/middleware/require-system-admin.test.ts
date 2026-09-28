import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * requireSystemAdmin: только is_admin без ограничения компанией. Админ компании обходит
 * page-access по is_admin, поэтому действия по всей организации (импорт окладов, выдача
 * доступа к «Зарплате») ему закрыты.
 */

const h = vi.hoisted(() => ({
  resolveCompanyScope: vi.fn(async (): Promise<{ roots: 'all' | string[] }> => ({ roots: 'all' })),
}));

vi.mock('../config/postgres.js', () => ({ query: vi.fn(), queryOne: vi.fn() }));
vi.mock('../services/access-control.service.js', () => ({ resolveEffectivePageAccess: vi.fn() }));
vi.mock('../services/data-scope.service.js', () => ({ resolveCompanyScope: h.resolveCompanyScope }));

import { requireSystemAdmin } from './auth.js';

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  return res as unknown as Response & { statusCode: number };
};

const run = async (user: Partial<AuthenticatedRequest['user']> | undefined) => {
  const res = makeRes();
  const next = vi.fn() as unknown as NextFunction & ReturnType<typeof vi.fn>;
  await requireSystemAdmin({ user } as unknown as AuthenticatedRequest, res, next);
  return { res, next };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.resolveCompanyScope.mockResolvedValue({ roots: 'all' });
});

describe('requireSystemAdmin', () => {
  it('системный администратор проходит', async () => {
    const { res, next } = await run({ id: 'a', is_admin: true });
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });

  it('администратор компании — 403', async () => {
    h.resolveCompanyScope.mockResolvedValue({ roots: ['company-root'] });
    const { res, next } = await run({ id: 'a', is_admin: true });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it('не-админ (в том числе с персональным доступом к «Зарплате») — 403 без запроса скоупа', async () => {
    const { res, next } = await run({ id: 'u', is_admin: false });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(h.resolveCompanyScope).not.toHaveBeenCalled();
  });

  it('без пользователя — 401', async () => {
    const { res, next } = await run(undefined);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});
