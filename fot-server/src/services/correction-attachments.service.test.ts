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
  listCorrectionAttachments,
  listDaysWithTimeCorrectionMemo,
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

/** SQL-условие по work-заявке: дискретные selected_dates, диапазон — только legacy. */
const expectWorkDayCondition = (sql: string, day: string) => {
  expect(sql).toContain(`lr.request_type = 'work'`);
  expect(sql).toContain(`lr.status IN ('pending', 'approved')`);
  expect(sql).toContain(`WHEN cardinality(lr.selected_dates) > 0`);
  expect(sql).toContain(`THEN ${day} = ANY(lr.selected_dates)`);
  expect(sql).toContain(`ELSE ${day} BETWEEN lr.start_date AND COALESCE(lr.end_date, lr.start_date)`);
  // time_correction-ветка сохранена без изменений.
  expect(sql).toContain(`lr.request_type = 'time_correction'`);
  expect(sql).toContain(`COALESCE(lr.correction_date, lr.start_date) = ${day}`);
};

describe('listCorrectionAttachments', () => {
  it('подмешивает файл work-заявки дня к manual_object-корректировке как source=leave_request', async () => {
    const calls: ClientCall[] = [];
    pgQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('entity_type = $1 AND entity_id = $2')) return [];
      if (sql.includes('FROM leave_requests lr')) return [{ id: 7634 }];
      if (sql.includes(`entity_type = 'leave_request' AND entity_id = ANY`)) return [{ document_id: 13477 }];
      if (sql.includes('WHERE leave_request_id = ANY')) return [{ id: 13477 }];
      if (sql.includes('FROM documents')) {
        return [{
          id: 13477, file_name: 'Работа01.pdf', file_size: 1000, mime_type: 'application/pdf',
          r2_key: 'k', uploaded_by: null, created_at: '2026-09-04T11:36:36.814Z',
        }];
      }
      return [];
    });

    const items = await listCorrectionAttachments({
      id: 1109597, employee_id: 2156, work_date: '2026-09-06',
      source_type: 'manual_object', source_id: '5e919f10-f345-4f85-ac7e-1a41890aa008',
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 13477, source: 'leave_request', original_name: 'Работа01.pdf' });
    const leaveCall = calls.find(c => c.sql.includes('FROM leave_requests lr'))!;
    expectWorkDayCondition(leaveCall.sql, '$2::date');
    expect(leaveCall.params).toEqual([2156, '2026-09-06']);
  });

  it('без заявок дня (rejected/cancelled отсекаются в SQL) файлов нет', async () => {
    pgQuery.mockImplementation(async () => []);
    const items = await listCorrectionAttachments({
      id: 1113527, employee_id: 1122, work_date: '2026-09-12',
      source_type: 'manual_object', source_id: null,
    });
    expect(items).toEqual([]);
    const leaveSql = pgQuery.mock.calls.map(c => String(c[0])).find(s => s.includes('FROM leave_requests lr'))!;
    expect(leaveSql).not.toContain(`'cancelled'`);
    expect(leaveSql).toContain(`IN ('pending', 'approved')`);
  });
});

describe('listDaysWithTimeCorrectionMemo', () => {
  it('разворачивает запрошенные даты и возвращает каждый покрытый день', async () => {
    // work на 06 и 08 (не подряд): БД по ANY(selected_dates) вернёт только 06 и 08, не 07.
    pgQuery.mockResolvedValueOnce([
      { employee_id: '2156', d: '2026-09-06' },
      { employee_id: 2156, d: '2026-09-08' },
      { employee_id: 1122, d: '2026-09-11' },
    ]);

    const covered = await listDaysWithTimeCorrectionMemo(
      [2156, 2156, 1122],
      ['2026-09-06', '2026-09-07', '2026-09-08', '2026-09-11'],
    );

    expect([...covered].sort()).toEqual(['1122|2026-09-11', '2156|2026-09-06', '2156|2026-09-08']);
    expect(covered.has('2156|2026-09-07')).toBe(false);
    const [sql, params] = pgQuery.mock.calls[0]!;
    expect(sql).toContain('CROSS JOIN unnest($2::date[]) AS x(d)');
    expect(sql).toContain('x.d::text AS d');
    expectWorkDayCondition(String(sql), 'x.d');
    expect(params).toEqual([[2156, 1122], ['2026-09-06', '2026-09-07', '2026-09-08', '2026-09-11']]);
  });

  it('пустые входы — без запроса', async () => {
    expect((await listDaysWithTimeCorrectionMemo([], ['2026-09-06'])).size).toBe(0);
    expect((await listDaysWithTimeCorrectionMemo([2156], [])).size).toBe(0);
    expect(pgQuery).not.toHaveBeenCalled();
  });
});
