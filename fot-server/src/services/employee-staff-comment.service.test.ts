import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

const h = vi.hoisted(() => ({
  clientQuery: vi.fn(),
  logFromRequestWithClient: vi.fn(),
}));
vi.mock('../config/postgres.js', () => ({
  withTransaction: async <T>(fn: (client: { query: typeof h.clientQuery }) => Promise<T>) => fn({ query: h.clientQuery }),
}));
vi.mock('./audit.service.js', () => ({ auditService: { logFromRequestWithClient: h.logFromRequestWithClient } }));

const { decideStaffCommentChange, saveStaffComment } = await import('./employee-staff-comment.service.js');

const V1 = '2026-09-15T10:00:00.123456Z';
const current = { comment: 'Старый', updated_at: V1, updated_by_name: 'Иванова' };

describe('decideStaffCommentChange', () => {
  it('версия не совпала — конфликт (в т. ч. удаление уже удалённого и «первое» создание поверх чужого)', () => {
    expect(decideStaffCommentChange(current, null, 'Новый')).toEqual({ kind: 'conflict' });
    expect(decideStaffCommentChange(current, '2026-09-15T10:00:00.123Z', 'Новый')).toEqual({ kind: 'conflict' });
    expect(decideStaffCommentChange(null, V1, '')).toEqual({ kind: 'conflict' });
  });

  it('пусто без строки и тот же текст — без изменений', () => {
    expect(decideStaffCommentChange(null, null, '')).toEqual({ kind: 'noop' });
    expect(decideStaffCommentChange(current, V1, 'Старый')).toEqual({ kind: 'noop' });
  });

  it('пусто — удаление; новый текст — запись', () => {
    expect(decideStaffCommentChange(current, V1, '')).toEqual({ kind: 'delete' });
    expect(decideStaffCommentChange(null, null, 'Первый')).toEqual({ kind: 'upsert' });
    expect(decideStaffCommentChange(current, V1, 'Новый')).toEqual({ kind: 'upsert' });
  });
});

describe('saveStaffComment', () => {
  const req = { ip: '127.0.0.1', headers: {}, socket: {} } as unknown as Request;
  let commentRow: typeof current | null;

  beforeEach(() => {
    commentRow = null;
    h.logFromRequestWithClient.mockReset().mockResolvedValue(undefined);
    h.clientQuery.mockReset().mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('FOR UPDATE')) return { rowCount: params[0] === 404 ? 0 : 1, rows: [] };
      if (sql.includes('FROM employee_staff_comments c')) return { rows: commentRow ? [commentRow] : [] };
      if (sql.startsWith('DELETE')) { commentRow = null; return { rowCount: 1, rows: [] }; }
      if (sql.includes('INSERT INTO employee_staff_comments')) {
        commentRow = { comment: String(params[1]), updated_at: '2026-09-15T11:00:00.000001Z', updated_by_name: 'Петров' };
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
  });

  const save = (comment: string, expectedUpdatedAt: string | null, employeeId = 7) =>
    saveStaffComment({ req, userId: 'u-1', employeeId, comment, expectedUpdatedAt });

  it('блокирует строку сотрудника до чтения комментария', async () => {
    await save('Текст', null);
    const sqls = h.clientQuery.mock.calls.map(call => String(call[0]));
    expect(sqls[0]).toContain('FROM employees WHERE id = $1 FOR UPDATE');
  });

  it('сотрудника нет — not_found без записи', async () => {
    expect(await save('Текст', null, 404)).toEqual({ status: 'not_found' });
    expect(h.logFromRequestWithClient).not.toHaveBeenCalled();
  });

  it('создание: trim, запись с автором, аудит в той же транзакции, канонический ответ', async () => {
    const result = await save('  Текст  ', null);
    const insert = h.clientQuery.mock.calls.find(call => String(call[0]).includes('INSERT'));
    expect(insert?.[1]).toEqual([7, 'Текст', 'u-1']);
    expect(result).toEqual({
      status: 'ok', changed: true,
      current: { comment: 'Текст', updated_at: '2026-09-15T11:00:00.000001Z', updated_by_name: 'Петров' },
    });
    expect(h.logFromRequestWithClient).toHaveBeenCalledWith(
      expect.anything(), req, 'u-1', 'UPDATE_STAFF_COMMENT',
      expect.objectContaining({ entityId: '7', details: { employee_id: 7, old: null, new: 'Текст' } }),
    );
  });

  it('повтор того же запроса — no-op без аудита (идемпотентно)', async () => {
    commentRow = { ...current };
    expect(await save('Старый', V1)).toEqual({ status: 'ok', changed: false, current });
    expect(h.logFromRequestWithClient).not.toHaveBeenCalled();
    expect(h.clientQuery.mock.calls.some(call => /INSERT|DELETE/.test(String(call[0])))).toBe(false);
  });

  it('пусто без комментария — no-op без аудита', async () => {
    expect(await save('   ', null)).toEqual({ status: 'ok', changed: false, current: null });
    expect(h.logFromRequestWithClient).not.toHaveBeenCalled();
  });

  it('устаревшая версия — конфликт с актуальным значением, без записи', async () => {
    commentRow = { ...current };
    expect(await save('Новый', null)).toEqual({ status: 'conflict', current });
    expect(h.clientQuery.mock.calls.some(call => /INSERT|DELETE/.test(String(call[0])))).toBe(false);
    expect(h.logFromRequestWithClient).not.toHaveBeenCalled();
  });

  it('удаление: DELETE, аудит old→null, ответ current null', async () => {
    commentRow = { ...current };
    expect(await save('', V1)).toEqual({ status: 'ok', changed: true, current: null });
    expect(h.logFromRequestWithClient.mock.calls[0][4].details).toEqual({ employee_id: 7, old: 'Старый', new: null });
  });

  it('ошибка аудита пробрасывается (транзакция откатится)', async () => {
    h.logFromRequestWithClient.mockRejectedValue(new Error('audit down'));
    await expect(save('Текст', null)).rejects.toThrow('audit down');
  });
});
