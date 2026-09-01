import { describe, expect, it, vi } from 'vitest';
import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

vi.mock('../config/features.js', () => ({ CRITICAL_2FA_ENABLED: false, LOGIN_2FA_ENABLED: false, IS_PRODUCTION: false }));
vi.mock('../services/access-control.service.js', () => ({ resolveEffectivePageAccess: vi.fn(async () => true) }));
vi.mock('../services/local-auth.service.js', () => ({}));

import { requireHr2FA } from './auth.js';

const run = (user: Partial<AuthenticatedRequest['user']> | null): { status: number; called: boolean; code?: string } => {
  let status = 200;
  let code: string | undefined;
  const res = {
    status: (s: number) => { status = s; return res; },
    json: (b: { code?: string }) => { code = b.code; return res; },
  } as unknown as Response;
  let called = false;
  const next: NextFunction = () => { called = true; };
  requireHr2FA({ user } as unknown as AuthenticatedRequest, res, next);
  return { status, called, code };
};

describe('requireHr2FA', () => {
  it('без 2FA у пользователя → 403 даже при выключенном CRITICAL_2FA_ENABLED', () => {
    const r = run({ two_factor_enabled: false, two_factor_verified: false });
    expect(r.status).toBe(403);
    expect(r.code).toBe('HR_2FA_REQUIRED');
    expect(r.called).toBe(false);
  });
  it('2FA включена, но не подтверждена → 403', () => {
    expect(run({ two_factor_enabled: true, two_factor_verified: false }).status).toBe(403);
  });
  it('включена и подтверждена → next', () => {
    expect(run({ two_factor_enabled: true, two_factor_verified: true }).called).toBe(true);
  });
  it('нет пользователя → 401', () => {
    expect(run(null).status).toBe(401);
  });
});
