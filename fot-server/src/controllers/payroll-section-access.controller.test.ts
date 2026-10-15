import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

const { pgQuery } = vi.hoisted(() => ({ pgQuery: vi.fn() }));

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

import { payrollSectionAccessController } from './payroll-section-access.controller.js';

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { res.statusCode = code; return res; },
    json(payload: unknown) { res.body = payload; return res; },
  };
  return res;
};

const req = { user: { id: 'u1' } } as unknown as AuthenticatedRequest;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/payroll/section-access', () => {
  it('отдаёт список как есть: ФИО учёток по алфавиту, без ФИО — в конце', async () => {
    const rows = [
      { user_id: 'a', full_name: 'Масеева Алла Амировна' },
      { user_id: 'b', full_name: null },
    ];
    pgQuery.mockResolvedValue(rows);
    const res = makeRes();
    await payrollSectionAccessController.list(req, res as unknown as Response);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, data: rows });
    const [sql] = pgQuery.mock.calls[0] as [string];
    expect(sql).toMatch(/FROM payroll_section_access a\s+JOIN user_profiles up ON up\.id = a\.user_id/);
    expect(sql).toMatch(/ORDER BY up\.full_name NULLS LAST/);
  });

  it('ошибка БД — 500', async () => {
    pgQuery.mockRejectedValue(new Error('boom'));
    const res = makeRes();
    await payrollSectionAccessController.list(req, res as unknown as Response);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ success: false, error: 'Ошибка получения списка доступа' });
  });
});
