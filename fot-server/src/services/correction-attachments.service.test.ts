import { describe, expect, it, vi, beforeEach } from 'vitest';

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

import {
  createCorrectionAttachmentForMany,
  deleteCorrectionAttachment,
  purgeCorrectionAttachments,
} from './correction-attachments.service.js';

/** Транзакционный клиент с настраиваемым query; собирает вызовы для проверок. */
type ClientCall = { sql: string; params: unknown[] };
const makeTxClient = (handler: (sql: string, params: unknown[]) => { rows: unknown[] }) => {
  const calls: ClientCall[] = [];
  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return handler(sql, params);
    }),
  };
  return { client, calls };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createCorrectionAttachmentForMany', () => {
  it('создаёт один документ и N ссылок на все adjustmentIds', async () => {
    const { client, calls } = makeTxClient((sql) => {
      if (sql.includes('INSERT INTO documents')) {
        return {
          rows: [{
            id: 500, file_name: 'Отпуск.jpg', file_size: 1000, mime_type: 'image/jpeg',
            r2_key: 'k500', uploaded_by: 'mgr', created_at: '2026-06-01T00:00:00Z',
          }],
        };
      }
      return { rows: [] };
    });
    pgTx.mockImplementation(async (cb: (c: typeof client) => unknown) => cb(client));

    const res = await createCorrectionAttachmentForMany({
      adjustmentIds: [11, 12, 12, 13], // дубль 12 схлопывается
      employeeId: 42,
      fileName: 'Отпуск.jpg',
      fileSize: 1000,
      mimeType: 'image/jpeg',
      r2Key: 'k500',
      uploadedBy: 'mgr',
    });

    expect(res.id).toBe(500);
    const linkInsert = calls.find(c => c.sql.includes('INSERT INTO document_links'));
    expect(linkInsert).toBeTruthy();
    // unnest получает уникальные id (документ один — params[0]).
    expect(linkInsert?.params[0]).toBe(500);
    expect(linkInsert?.params[3]).toEqual([11, 12, 13]);
  });
});

describe('deleteCorrectionAttachment', () => {
  it('полностью удаляет документ со всех дней и возвращает r2Key', async () => {
    pgQueryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT document_id FROM document_links')) return { document_id: 500 };
      if (sql.includes('NOT (entity_type')) return { cnt: 0 };
      if (sql.includes('SELECT r2_key FROM documents')) return { r2_key: 'k500' };
      return null;
    });
    const { client, calls } = makeTxClient(() => ({ rows: [] }));
    pgTx.mockImplementation(async (cb: (c: typeof client) => unknown) => cb(client));

    const res = await deleteCorrectionAttachment(99, 500);

    expect(res).toEqual({ owned: true, r2Key: 'k500' });
    // Удаление ссылок — по document_id целиком, без фильтра по конкретному дню.
    const linkDelete = calls.find(c => c.sql.includes('DELETE FROM document_links'));
    expect(linkDelete?.sql).toContain('WHERE document_id = $1');
    expect(linkDelete?.sql).not.toContain('entity_id');
    expect(calls.some(c => c.sql.includes('DELETE FROM documents'))).toBe(true);
  });

  it('не трогает документ, если у него есть ссылки иного типа (leave_request)', async () => {
    pgQueryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT document_id FROM document_links')) return { document_id: 500 };
      if (sql.includes('NOT (entity_type')) return { cnt: 1 };
      return null;
    });

    const res = await deleteCorrectionAttachment(99, 500);

    expect(res).toEqual({ owned: false, r2Key: null });
    expect(pgTx).not.toHaveBeenCalled();
  });

  it('возвращает owned:false, если ссылки на эту корректировку нет', async () => {
    pgQueryOne.mockResolvedValue(null);
    const res = await deleteCorrectionAttachment(99, 500);
    expect(res).toEqual({ owned: false, r2Key: null });
    expect(pgTx).not.toHaveBeenCalled();
  });
});

describe('purgeCorrectionAttachments', () => {
  it('сохраняет общий файл: при остаточных ссылках r2_key НЕ возвращается', async () => {
    pgQuery.mockResolvedValue([{ document_id: 20, r2_key: 'k20' }]);
    const { client } = makeTxClient((sql) => {
      // Документ ещё привязан к другим дням → не сирота.
      if (sql.includes('SELECT document_id FROM document_links WHERE document_id = ANY')) {
        return { rows: [{ document_id: 20 }] };
      }
      return { rows: [] };
    });
    pgTx.mockImplementation(async (cb: (c: typeof client) => unknown) => cb(client));

    const keys = await purgeCorrectionAttachments(101);

    expect(keys).toEqual([]);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM documents'))).toBe(false);
  });

  it('возвращает r2_key только для осиротевших документов', async () => {
    pgQuery.mockResolvedValue([{ document_id: 20, r2_key: 'k20' }]);
    const { client } = makeTxClient((sql) => {
      // Других ссылок не осталось → сирота.
      if (sql.includes('SELECT document_id FROM document_links WHERE document_id = ANY')) {
        return { rows: [] };
      }
      return { rows: [] };
    });
    pgTx.mockImplementation(async (cb: (c: typeof client) => unknown) => cb(client));

    const keys = await purgeCorrectionAttachments(101);

    expect(keys).toEqual(['k20']);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM documents'))).toBe(true);
  });
});
