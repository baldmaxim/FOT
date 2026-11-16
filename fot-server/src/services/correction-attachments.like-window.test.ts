import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Журнал «Корректировки»: число файлов в строке = файлы, которые покажет окно дня (listCorrectionAttachments).
 * Одна и та же «база» отвечает обоим путям — сверяется не формула, а результат.
 */

const h = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('../config/postgres.js', () => ({
  query: h.query,
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

const { countCorrectionAttachmentsLikeWindow, listCorrectionAttachments } = await import('./correction-attachments.service.js');

interface IFakeDb {
  ownLinks: Array<{ adjustmentId: number; documentId: number }>;
  leaveLinks: Array<{ leaveId: number; documentId: number }>;
  legacyDocs: Array<{ leaveId: number; documentId: number }>;
  dayLeaves: Array<{ employeeId: number; date: string; leaveId: number }>;
  documents: number[];
}

const install = (db: IFakeDb): void => {
  const documentRow = (id: number) => ({
    id, file_name: `f${id}`, file_size: 1, mime_type: 'image/jpeg', r2_key: `k${id}`, uploaded_by: null, created_at: '2026-11-01',
  });
  h.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const text = String(sql);
    if (text.includes('unnest($1::int[], $2::date[]) AS p(employee_id, work_date)')) {
      const [employees, dates] = params as [number[], string[]];
      return employees.flatMap((employeeId, index) => db.dayLeaves
        .filter(row => row.employeeId === employeeId && row.date === dates[index])
        .map(row => ({ employee_id: employeeId, work_date: row.date, id: row.leaveId })));
    }
    if (text.includes('FROM leave_requests lr') && text.includes('lr.employee_id = $1')) {
      const [employeeId, date] = params as [number, string];
      return db.dayLeaves.filter(row => row.employeeId === employeeId && row.date === date).map(row => ({ id: row.leaveId }));
    }
    if (text.includes("entity_type = 'leave_request'")) {
      const ids = (params[0] as string[]).map(Number);
      return db.leaveLinks.filter(row => ids.includes(row.leaveId))
        .map(row => ({ entity_id: String(row.leaveId), document_id: row.documentId }));
    }
    if (text.includes('WHERE leave_request_id = ANY')) {
      const ids = params[0] as number[];
      return db.legacyDocs.filter(row => ids.includes(row.leaveId))
        .map(row => ({ leave_request_id: row.leaveId, id: row.documentId }));
    }
    if (text.includes('FROM document_links') && text.includes('entity_id = ANY($3::text[])')) {
      const ids = (params[2] as string[]).map(Number);
      return db.ownLinks.filter(row => ids.includes(row.adjustmentId))
        .map(row => ({ entity_id: String(row.adjustmentId), document_id: row.documentId }));
    }
    if (text.includes('FROM document_links') && text.includes('entity_id = $2')) {
      return db.ownLinks.filter(row => row.adjustmentId === Number(params[1])).map(row => ({ document_id: row.documentId }));
    }
    if (text.includes('FROM documents') && text.includes('WHERE id = ANY')) {
      const ids = params[0] as number[];
      return db.documents.filter(id => ids.includes(id)).map(documentRow);
    }
    if (text.includes('FROM user_profiles')) return [];
    throw new Error(`неожиданный запрос: ${text}`);
  });
};

beforeEach(() => {
  h.query.mockReset();
});

describe('countCorrectionAttachmentsLikeWindow', () => {
  const adjustments = [
    { id: 1, employee_id: 10, work_date: '2026-11-07', source_type: 'manual', source_id: 'manual' },
    { id: 2, employee_id: 11, work_date: '2026-11-08', source_type: 'leave_request', source_id: '901:time_correction' },
    { id: 3, employee_id: 12, work_date: '2026-11-09', source_type: 'manual_object', source_id: 'obj-1' },
  ];

  beforeEach(() => install({
    // 104 — ссылка на удалённый документ: окно его не покажет.
    ownLinks: [{ adjustmentId: 1, documentId: 100 }, { adjustmentId: 1, documentId: 101 }, { adjustmentId: 1, documentId: 104 }],
    // 101 — тот же документ и у заявки дня: один раз.
    leaveLinks: [{ leaveId: 900, documentId: 101 }, { leaveId: 900, documentId: 102 }, { leaveId: 901, documentId: 200 }],
    legacyDocs: [{ leaveId: 900, documentId: 103 }],
    dayLeaves: [{ employeeId: 10, date: '2026-11-07', leaveId: 900 }],
    documents: [100, 101, 102, 103, 200],
  }));

  it('свои файлы, исходного заявления, заявок дня; дубли и удалённые не считаются', async () => {
    const counts = await countCorrectionAttachmentsLikeWindow(adjustments);
    expect(Object.fromEntries(counts)).toEqual({ 1: 4, 2: 1, 3: 0 });
  });

  it('совпадает с тем, что покажет окно дня', async () => {
    const counts = await countCorrectionAttachmentsLikeWindow(adjustments);
    for (const adjustment of adjustments) {
      expect(counts.get(adjustment.id), String(adjustment.id)).toBe((await listCorrectionAttachments(adjustment)).length);
    }
  });

  it('постоянное число запросов, не на строку', async () => {
    await countCorrectionAttachmentsLikeWindow(adjustments);
    expect(h.query.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it('пусто — без запросов', async () => {
    expect((await countCorrectionAttachmentsLikeWindow([])).size).toBe(0);
    expect(h.query).not.toHaveBeenCalled();
  });
});
