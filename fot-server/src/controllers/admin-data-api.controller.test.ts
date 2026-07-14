import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

const getKey = vi.fn();
const deleteKey = vi.fn().mockResolvedValue(undefined);
const logFromRequest = vi.fn().mockResolvedValue(undefined);

vi.mock('../services/data-api-key.service.js', () => ({
  dataApiKeyService: {
    getKey: (...args: unknown[]) => getKey(...args),
    deleteKey: (...args: unknown[]) => deleteKey(...args),
  },
}));

vi.mock('../services/data-api-schema.service.js', () => ({
  dataApiSchemaService: { getFullSchema: vi.fn(), getTable: vi.fn() },
}));

vi.mock('../services/audit.service.js', () => ({
  auditService: { logFromRequest: (...args: unknown[]) => logFromRequest(...args) },
  AUDIT_ACTIONS: {},
}));

const { adminDataApiController } = await import('./admin-data-api.controller.js');

function createRes(): Response & { statusCode: number; body: unknown } {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

const req = {
  params: { id: 'key-1' },
  user: { id: 'admin-1' },
} as unknown as AuthenticatedRequest;

const baseKey = {
  id: 'key-1',
  name: 'Odintsov',
  key_prefix: 'abc',
  revoked_at: null as string | null,
  expires_at: null as string | null,
};

describe('adminDataApiController.deleteKey', () => {
  beforeEach(() => {
    getKey.mockReset();
    deleteKey.mockClear();
    logFromRequest.mockClear();
  });

  it('404, если ключа нет', async () => {
    getKey.mockResolvedValue(null);
    const res = createRes();

    await adminDataApiController.deleteKey(req, res);

    expect(res.statusCode).toBe(404);
    expect(deleteKey).not.toHaveBeenCalled();
  });

  it('400 для действующего ключа — сначала нужно отозвать', async () => {
    getKey.mockResolvedValue({ ...baseKey });
    const res = createRes();

    await adminDataApiController.deleteKey(req, res);

    expect(res.statusCode).toBe(400);
    expect(deleteKey).not.toHaveBeenCalled();
  });

  it('удаляет отозванный ключ и пишет аудит', async () => {
    getKey.mockResolvedValue({ ...baseKey, revoked_at: '2026-06-29T14:50:06.481Z' });
    const res = createRes();

    await adminDataApiController.deleteKey(req, res);

    expect(deleteKey).toHaveBeenCalledWith('key-1');
    expect(logFromRequest).toHaveBeenCalledWith(
      req, 'admin-1', 'DATA_API_KEY_DELETED', expect.objectContaining({ entityId: 'key-1' }),
    );
    expect(res.body).toEqual({ success: true });
  });

  it('удаляет истёкший ключ (без явного отзыва)', async () => {
    getKey.mockResolvedValue({ ...baseKey, expires_at: '2026-01-01T00:00:00.000Z' });
    const res = createRes();

    await adminDataApiController.deleteKey(req, res);

    expect(deleteKey).toHaveBeenCalledWith('key-1');
    expect(res.body).toEqual({ success: true });
  });
});
