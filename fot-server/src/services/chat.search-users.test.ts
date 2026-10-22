import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Чат → «Новый чат»: поиск по ФИО (ё = е, раскладка). Политика общения режет после SQL, поэтому разрешённый
 * точный не теряется за первыми 50, а опечатка ищется, только если среди разрешённых точных нет.
 */

const { h } = vi.hoisted(() => ({
  h: {
    query: vi.fn(),
    forbidden: new Set<string>(),
  },
}));

vi.mock('../config/postgres.js', () => ({ query: h.query, queryOne: vi.fn(), execute: vi.fn(), withTransaction: vi.fn() }));
vi.mock('./encryption.service.js', () => ({ encryptionService: {} }));
vi.mock('./notification.service.js', () => ({ notificationService: {} }));
vi.mock('./r2.service.js', () => ({ r2Service: {} }));
vi.mock('./chat-policy.service.js', () => ({
  chatPolicyService: {
    getUserContexts: vi.fn(async (ids: string[]) => new Map(ids.map(id => [id, {
      id, full_name: `ФИО ${id}`, role_code: 'worker', department_ids: [],
    }]))),
    getDecisionsForTargets: vi.fn(async (_me: string, ids: string[]) => new Map(ids.map(id => [id, {
      availability: h.forbidden.has(id) ? 'forbidden' : 'allowed', availability_reason: null, request_status: null,
    }]))),
  },
}));

const { chatService } = await import('./chat.service.js');

const ids = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}` }));

beforeEach(() => {
  h.query.mockReset();
  h.forbidden = new Set();
});

describe('chatService.searchUsers', () => {
  it('без поиска — первые 50 по ФИО, как раньше', async () => {
    h.query.mockResolvedValue(ids(50, 'u'));
    await chatService.searchUsers('  ', 'me');
    expect(String(h.query.mock.calls[0][0])).toContain('LIMIT 50');
  });

  it('разрешённый точный за первыми 50 запрещёнными не теряется', async () => {
    const rows = ids(60, 'u');
    for (const row of rows.slice(0, 55)) h.forbidden.add(row.id);
    h.query.mockResolvedValue(rows);
    const result = await chatService.searchUsers('гринев', 'me');
    expect(result.map(user => user.id)).toEqual(['u55', 'u56', 'u57', 'u58', 'u59']);
    const [sql, params] = h.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('AND (full_name ~* $3)');
    expect(sql).toContain('LIMIT 500');
    expect(params).toEqual(['me', expect.any(String), 'грин[её]в']);
    expect(h.query).toHaveBeenCalledTimes(1);
  });

  it('точные есть, но все запрещены политикой — ищется с одной ошибкой', async () => {
    h.forbidden.add('x1');
    h.query
      .mockResolvedValueOnce([{ id: 'x1' }])
      .mockResolvedValueOnce([{ id: 'x1' }, { id: 'y2' }]);
    const result = await chatService.searchUsers('гринев', 'me');
    expect(result.map(user => user.id)).toEqual(['y2']);
    expect(String(h.query.mock.calls[1][0])).toContain('full_name ~* ANY($3::text[])');
  });

  it('точных 500 и больше (упёрлись в лимит) — опечатку не включаем', async () => {
    const rows = ids(500, 'z');
    for (const row of rows) h.forbidden.add(row.id);
    h.query.mockResolvedValue(rows);
    expect(await chatService.searchUsers('гринев', 'me')).toEqual([]);
    expect(h.query).toHaveBeenCalledTimes(1);
  });
});
