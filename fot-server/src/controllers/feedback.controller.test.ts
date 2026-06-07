import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

const { pgQuery, pgQueryOne, pgExecute, pgTx } = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  pgQueryOne: vi.fn(),
  pgExecute: vi.fn(),
  pgTx: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: pgQueryOne,
  execute: pgExecute,
  withTransaction: pgTx,
}));

const scope = vi.hoisted(() => ({
  resolveAccessibleEmployeeIds: vi.fn(async () => 'all' as const),
  resolveCompanyScope: vi.fn(async () => ({ roots: 'all' as const })),
  resolveAccessibleDepartmentIds: vi.fn(async () => 'all' as const),
}));

vi.mock('../services/data-scope.service.js', () => scope);

const testsSvc = vi.hoisted(() => ({
  loadTestFull: vi.fn(),
  createTest: vi.fn(),
  updateTest: vi.fn(),
  listAvailableTests: vi.fn(),
  isTestAssignedToDepartmentChain: vi.fn(),
  loadMyResponse: vi.fn(),
  saveResponse: vi.fn(),
}));

vi.mock('../services/tests.service.js', () => testsSvc);

import { feedbackController } from './feedback.controller.js';
import { testsController } from './tests.controller.js';

function makeReq(overrides: Partial<AuthenticatedRequest>): AuthenticatedRequest {
  return {
    params: {},
    query: {},
    body: {},
    user: { id: 'u1', employee_id: 1, is_admin: true, two_factor_verified: true },
    ...overrides,
  } as AuthenticatedRequest;
}

function makeRes() {
  const response = {
    statusCode: 200,
    payload: null as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.payload = body; return this; },
  };
  return response as Response & { statusCode: number; payload: unknown };
}

const UUID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
  scope.resolveAccessibleEmployeeIds.mockResolvedValue('all');
});

describe('feedback.listMessages — анонимность', () => {
  it('скрывает ФИО и отдел анонимного обращения', async () => {
    pgQuery.mockResolvedValueOnce([
      { id: 1, content: 'Аноним', is_anonymous: true, created_at: '2026-01-01', full_name: 'Иван Иванов', department_name: 'Бухгалтерия' },
      { id: 2, content: 'Открыто', is_anonymous: false, created_at: '2026-01-02', full_name: 'Пётр Петров', department_name: 'Склад' },
    ]);

    const req = makeReq({ query: { kind: 'suggestion' } });
    const res = makeRes();
    await feedbackController.listMessages(req, res);

    const data = (res.payload as { data: Array<{ author: string; department_name: string | null }> }).data;
    expect(data[0].author).toBe('Анонимно');
    expect(data[0].department_name).toBeNull();
    // ФИО автора не должно утечь ни в одном поле анонимной записи.
    expect(JSON.stringify(data[0])).not.toContain('Иван');
    expect(data[1].author).toBe('Пётр Петров');
  });
});

describe('tests.submitResponse — валидация обязательных вопросов', () => {
  it('отклоняет финальную отправку с пропущенным обязательным вопросом', async () => {
    pgQueryOne.mockResolvedValue({ org_department_id: 'dep-1' });
    testsSvc.isTestAssignedToDepartmentChain.mockResolvedValue(true);
    testsSvc.loadTestFull.mockResolvedValue({
      id: UUID, is_active: true,
      questions: [{ id: 'q1', type: 'single', is_required: true, allow_custom: false, options: [{ id: 'o1' }] }],
    });

    const req = makeReq({ params: { id: UUID }, body: { status: 'submitted', answers: [] } });
    const res = makeRes();
    await testsController.submitResponse(req, res);

    expect(res.statusCode).toBe(400);
    expect(testsSvc.saveResponse).not.toHaveBeenCalled();
  });

  it('сохраняет черновик даже с пустыми ответами', async () => {
    pgQueryOne.mockResolvedValue({ org_department_id: 'dep-1' });
    testsSvc.isTestAssignedToDepartmentChain.mockResolvedValue(true);
    testsSvc.saveResponse.mockResolvedValue(undefined);

    const req = makeReq({ params: { id: UUID }, body: { status: 'draft', answers: [] } });
    const res = makeRes();
    await testsController.submitResponse(req, res);

    expect(res.statusCode).toBe(200);
    expect(testsSvc.saveResponse).toHaveBeenCalledOnce();
  });
});
