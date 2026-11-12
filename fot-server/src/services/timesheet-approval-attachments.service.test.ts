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
vi.mock('./r2.service.js', () => ({
  r2Service: {
    isEnabledAsync: vi.fn().mockResolvedValue(false),
    generateDownloadUrl: vi.fn(),
  },
}));
vi.mock('./timesheet-approval-employees-snapshot.service.js', () => ({
  listVisibleApprovalEmployees: vi.fn(),
}));

import {
  createAttachmentRecord,
  deleteAttachmentRecord,
  isApprovalMemoUploadAllowed,
  listApprovalPeriodAttachments,
  resolveApprovalMemoDelete,
} from './timesheet-approval-attachments.service.js';
import { listVisibleApprovalEmployees } from './timesheet-approval-employees-snapshot.service.js';

/**
 * Один комплексный сценарий подачи: служебка руководителя + корректировка (она же
 * привязана к заявке = два источника) + отпуск на 3 дня одним файлом (без own-ссылки) +
 * legacy-файл заявления (documents.leave_request_id, без document_links).
 */
const setupHappyPath = (): void => {
  vi.mocked(listVisibleApprovalEmployees).mockResolvedValue([
    { employee_id: 100, full_name: 'Иванов Иван' },
    { employee_id: 200, full_name: 'Петров Пётр' },
  ]);

  pgQueryOne.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM timesheet_approvals')) {
      return { start_date: '2026-06-01', end_date: '2026-06-15', submitted_by: 'mgr-user' };
    }
    return null;
  });

  const docRows: Record<number, Record<string, unknown>> = {
    10: { id: 10, file_name: 'Служебка.pdf', file_size: 111, mime_type: 'application/pdf', r2_key: 'k10', uploaded_by: 'mgr-user', created_at: '2026-06-10T00:00:00Z' },
    20: { id: 20, file_name: 'Корр_Иванов.jpg', file_size: 222, mime_type: 'image/jpeg', r2_key: 'k20', uploaded_by: 'mgr-user', created_at: '2026-06-06T00:00:00Z' },
    30: { id: 30, file_name: 'Отпуск_Иванов.jpg', file_size: 333, mime_type: 'image/jpeg', r2_key: 'k30', uploaded_by: 'emp100-user', created_at: '2026-06-01T00:00:00Z' },
    40: { id: 40, file_name: 'Заявление_Петров.pdf', file_size: 444, mime_type: 'application/pdf', r2_key: 'k40', uploaded_by: 'emp200-user', created_at: '2026-06-07T00:00:00Z' },
  };

  pgQuery.mockImplementation(async (sql: string, params: unknown[]) => {
    // --- document_links ---
    if (sql.includes('SELECT document_id FROM document_links')) {
      return [{ document_id: 10 }]; // служебка о выходных
    }
    if (sql.includes('SELECT entity_id, document_id FROM document_links')) {
      if (sql.includes("entity_type = 'leave_request'")) {
        return [
          { entity_id: '55', document_id: 30 }, // отпуск emp100 → doc30
          { entity_id: '77', document_id: 20 }, // заявка дня корректировки emp100 → doc20 (второй источник)
        ];
      }
      return [{ entity_id: '1004', document_id: 20 }]; // own-корректировка adj1004 → doc20
    }

    // --- documents ---
    if (sql.includes('SELECT id, leave_request_id FROM documents')) {
      return [{ id: 40, leave_request_id: 66 }]; // legacy: doc40 для заявки 66
    }
    if (sql.includes('FROM documents') && sql.includes('SELECT id, file_name')) {
      const ids = (params[0] as number[]).map(Number);
      return ids.map(id => docRows[id]).filter(Boolean);
    }

    // --- attendance_adjustments ---
    if (sql.includes('FROM attendance_adjustments')) {
      return [
        { id: 1001, employee_id: 100, work_date: '2026-06-01', source_type: 'leave_request', source_id: '55:vac' },
        { id: 1002, employee_id: 100, work_date: '2026-06-02', source_type: 'leave_request', source_id: '55:vac' },
        { id: 1003, employee_id: 100, work_date: '2026-06-03', source_type: 'leave_request', source_id: '55:vac' },
        { id: 1004, employee_id: 100, work_date: '2026-06-05', source_type: 'leave_request', source_id: '77:x' },
        { id: 2001, employee_id: 200, work_date: '2026-06-07', source_type: 'manual', source_id: null },
      ];
    }

    // --- leave_requests ---
    if (sql.includes('FROM leave_requests')) {
      // Вид заявления по id (для подписи типа).
      if (sql.includes('SELECT id, request_type')) {
        const ids = (params[0] as number[]).map(Number);
        const types: Record<number, string> = { 55: 'vacation', 77: 'vacation', 66: 'time_correction' };
        return ids.filter(id => types[id]).map(id => ({ id, request_type: types[id] }));
      }
      // time_correction-заявки дня.
      return [{ id: 66, employee_id: 200, d: '2026-06-07' }];
    }

    // --- user_profiles ---
    if (sql.includes('FROM user_profiles')) {
      const ids = (params[0] as string[]).map(String);
      const withEmp = sql.includes('employee_id');
      const profiles: Record<string, { full_name: string; employee_id: number }> = {
        'mgr-user': { full_name: 'Сидоров С. (рук.)', employee_id: 300 },
        'emp100-user': { full_name: 'Иванов Иван', employee_id: 100 },
        'emp200-user': { full_name: 'Петров Пётр', employee_id: 200 },
      };
      return ids
        .filter(id => profiles[id])
        .map(id => withEmp
          ? { id, full_name: profiles[id].full_name, employee_id: profiles[id].employee_id }
          : { id, full_name: profiles[id].full_name });
    }

    // --- employees → position_id ---
    if (sql.includes('FROM employees')) {
      const ids = (params[0] as number[]).map(Number);
      const pos: Record<number, string> = { 100: 'p1', 200: 'p2', 300: 'p3' };
      return ids.filter(id => pos[id]).map(id => ({ id, position_id: pos[id] }));
    }

    // --- positions → name ---
    if (sql.includes('FROM positions')) {
      const ids = (params[0] as string[]).map(String);
      const names: Record<string, string> = { p1: 'Геодезист', p2: 'Инженер', p3: 'Начальник отдела' };
      return ids.filter(id => names[id]).map(id => ({ id, name: names[id] }));
    }

    return [];
  });
};

describe('listApprovalPeriodAttachments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('собирает служебку + корректировку + отпуск + legacy-заявление, дедупит и сортирует', async () => {
    setupHappyPath();
    const result = await listApprovalPeriodAttachments(1);

    expect(result.map(r => r.document_id)).toEqual([10, 20, 30, 40]);

    // Служебка руководителя — первая.
    const memo = result[0];
    expect(memo.kind).toBe('weekend_memo');
    expect(memo.reason_label).toBe('Служебка (выходные)');
    expect(memo.is_submitter_file).toBe(true);
    expect(memo.employee_name).toBeNull();
    expect(memo.uploaded_by_name).toBe('Сидоров С. (рук.)');
    expect(memo.uploader_position).toBe('Начальник отдела');
    expect(memo.work_dates).toEqual([]);

    // Корректировка руководителя — два источника, тип отпуска в подписи, adjustment_id для удаления.
    const corr = result[1];
    expect(corr.document_id).toBe(20);
    expect(corr.kind).toBe('correction');
    expect([...(corr.sources ?? [])].sort()).toEqual(['correction', 'leave_request']);
    expect(corr.reason_label).toBe('Корректировка, Отпуск');
    expect(corr.adjustment_id).toBe(1004);
    expect(corr.is_submitter_file).toBe(true);
    expect(corr.employee_name).toBe('Иванов Иван');
    expect(corr.employee_position).toBe('Геодезист');
    expect(corr.work_dates).toEqual(['2026-06-05']);

    // Отпуск: один файл без own-ссылки, дедуп на 3 дня, тип «Отпуск».
    const vacation = result[2];
    expect(vacation.document_id).toBe(30);
    expect(vacation.kind).toBe('leave_request');
    expect(vacation.reason_label).toBe('Отпуск');
    expect(vacation.is_submitter_file).toBe(false);
    expect(vacation.employee_name).toBe('Иванов Иван');
    expect(vacation.work_dates).toEqual(['2026-06-01', '2026-06-02', '2026-06-03']);

    // Legacy-файл заявления (documents.leave_request_id) тоже попал; тип time_correction.
    const legacy = result[3];
    expect(legacy.document_id).toBe(40);
    expect(legacy.kind).toBe('leave_request');
    expect(legacy.reason_label).toBe('Корректировка табеля');
    expect(legacy.employee_name).toBe('Петров Пётр');
    expect(legacy.employee_position).toBe('Инженер');
    expect(legacy.work_dates).toEqual(['2026-06-07']);
  });

  it('пустой период без файлов → пустой массив', async () => {
    vi.mocked(listVisibleApprovalEmployees).mockResolvedValue([]);
    pgQueryOne.mockResolvedValue({ start_date: '2026-06-01', end_date: '2026-06-15', submitted_by: 'mgr-user' });
    pgQuery.mockResolvedValue([]);
    const result = await listApprovalPeriodAttachments(1);
    expect(result).toEqual([]);
  });
});

const UNLOCKED_AT = '2026-11-12T08:24:28.592Z';

describe('правила служебки: черновик и «Открыть табель»', () => {
  it('загрузка: черновик / отклонён / на доработке — всегда; подан и согласован — только открытый', () => {
    for (const status of ['draft', 'rejected', 'returned']) {
      expect(isApprovalMemoUploadAllowed({ status, unlocked_at: null })).toBe(true);
    }
    for (const status of ['submitted', 'approved']) {
      expect(isApprovalMemoUploadAllowed({ status, unlocked_at: null })).toBe(false);
      expect(isApprovalMemoUploadAllowed({ status, unlocked_at: UNLOCKED_AT })).toBe(true);
    }
  });

  it('удаление: в открытом — только приложенная после текущего открытия', () => {
    for (const status of ['draft', 'rejected', 'returned']) {
      expect(resolveApprovalMemoDelete({ status, unlocked_at: null }, false)).toBe('ok');
    }
    for (const status of ['submitted', 'approved']) {
      expect(resolveApprovalMemoDelete({ status, unlocked_at: null }, true)).toBe('period_closed');
      expect(resolveApprovalMemoDelete({ status, unlocked_at: UNLOCKED_AT }, true)).toBe('ok');
      expect(resolveApprovalMemoDelete({ status, unlocked_at: UNLOCKED_AT }, false)).toBe('uploaded_before_unlock');
    }
  });

  it('закрыли и открыли снова: файл прошлого открытия раньше нового unlocked_at — не удаляется', () => {
    // after_unlock считает SQL против ТЕКУЩЕГО unlocked_at; файл первого окна даёт false.
    expect(resolveApprovalMemoDelete({ status: 'approved', unlocked_at: '2026-11-13T09:00:00Z' }, false))
      .toBe('uploaded_before_unlock');
  });
});

/** Клиент транзакции: отвечает по SQL и запоминает запросы. */
const makeTxClient = (responses: { approval?: Record<string, unknown> | null; link?: string | null; doc?: Record<string, unknown> | null }) => {
  const calls: string[] = [];
  const client = {
    query: vi.fn(async (sql: string) => {
      calls.push(sql);
      if (/FROM document_links/i.test(sql) && /SELECT/i.test(sql)) {
        return { rows: responses.link ? [{ entity_id: responses.link }] : [] };
      }
      if (/FROM timesheet_approvals WHERE id = \$1 FOR UPDATE/i.test(sql)) {
        return { rows: responses.approval ? [responses.approval] : [] };
      }
      if (/FROM documents d/i.test(sql)) {
        return { rows: responses.doc ? [responses.doc] : [] };
      }
      if (/INSERT INTO documents/i.test(sql)) {
        return { rows: [{ id: 900, file_name: 'Служебка.pdf', file_size: 1, mime_type: 'application/pdf', r2_key: 'k', uploaded_by: 'u', created_at: 'now' }] };
      }
      return { rows: [] };
    }),
  };
  pgTx.mockImplementation(async (fn: (c: typeof client) => Promise<unknown>) => fn(client));
  return calls;
};

describe('createAttachmentRecord — проверка под блокировкой подачи', () => {
  beforeEach(() => vi.clearAllMocks());

  const params = { approvalId: 2269, fileName: 'Служебка.pdf', fileSize: 1, mimeType: 'application/pdf', r2Key: 'k', uploadedBy: 'u' };

  it('табель закрыли до записи: period_closed, документ не создан', async () => {
    const calls = makeTxClient({ approval: { status: 'approved', unlocked_at: null } });
    await expect(createAttachmentRecord(params)).resolves.toEqual({ ok: false, reason: 'period_closed' });
    expect(calls.some(sql => /INSERT/i.test(sql))).toBe(false);
  });

  it('открытый согласованный: документ и ссылка созданы', async () => {
    const calls = makeTxClient({ approval: { status: 'approved', unlocked_at: UNLOCKED_AT } });
    const result = await createAttachmentRecord(params);
    expect(result.ok).toBe(true);
    expect(calls[0]).toMatch(/FOR UPDATE/);
    expect(calls.filter(sql => /INSERT/i.test(sql))).toHaveLength(2);
  });
});

describe('deleteAttachmentRecord — решение в одной транзакции', () => {
  beforeEach(() => vi.clearAllMocks());

  const deletes = (calls: string[]) => calls.filter(sql => /DELETE/i.test(sql));

  it('табель закрыт: period_closed, ничего не удалено', async () => {
    const calls = makeTxClient({ link: '2269', approval: { status: 'approved', unlocked_at: null }, doc: { r2_key: 'k', after_unlock: null } });
    await expect(deleteAttachmentRecord(900)).resolves.toEqual({ ok: false, reason: 'period_closed' });
    expect(deletes(calls)).toHaveLength(0);
  });

  it('служебка до открытия: uploaded_before_unlock, ничего не удалено', async () => {
    const calls = makeTxClient({ link: '2269', approval: { status: 'approved', unlocked_at: UNLOCKED_AT }, doc: { r2_key: 'k', after_unlock: false } });
    await expect(deleteAttachmentRecord(900)).resolves.toEqual({ ok: false, reason: 'uploaded_before_unlock' });
    expect(deletes(calls)).toHaveLength(0);
  });

  it('нет ссылки на подачу: not_found', async () => {
    const calls = makeTxClient({ link: null });
    await expect(deleteAttachmentRecord(900)).resolves.toEqual({ ok: false, reason: 'not_found' });
    expect(deletes(calls)).toHaveLength(0);
  });

  it('служебка после открытия: удалена, подача заблокирована раньше чтения документа', async () => {
    const calls = makeTxClient({ link: '2269', approval: { status: 'approved', unlocked_at: UNLOCKED_AT }, doc: { r2_key: 'k', after_unlock: true } });
    await expect(deleteAttachmentRecord(900)).resolves.toEqual({ ok: true, r2Key: 'k', approvalId: 2269 });
    const lockIdx = calls.findIndex(sql => /FOR UPDATE/.test(sql));
    const docIdx = calls.findIndex(sql => /FROM documents d/.test(sql));
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(lockIdx).toBeLessThan(docIdx);
    expect(deletes(calls)).toHaveLength(2);
  });
});

describe('listApprovalPeriodAttachments — deletable у служебок', () => {
  beforeEach(() => vi.clearAllMocks());

  const setup = (approval: Record<string, unknown>, afterUnlockIds: number[]) => {
    vi.mocked(listVisibleApprovalEmployees).mockResolvedValue([]);
    pgQueryOne.mockResolvedValue({ start_date: '2026-10-16', end_date: '2026-10-31', submitted_by: 'mgr', ...approval });
    pgQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT document_id FROM document_links')) return [{ document_id: 10 }, { document_id: 11 }];
      if (sql.includes('FROM documents d')) return afterUnlockIds.map(id => ({ id }));
      if (sql.includes('FROM documents') && sql.includes('SELECT id, file_name')) {
        return [10, 11].map(id => ({ id, file_name: `${id}.pdf`, file_size: 1, mime_type: 'application/pdf', r2_key: `k${id}`, uploaded_by: 'u', created_at: 'x' }));
      }
      return [];
    });
  };

  it('открытый согласованный: только служебка после открытия', async () => {
    setup({ status: 'approved', unlocked_at: UNLOCKED_AT }, [11]);
    const result = await listApprovalPeriodAttachments(2269);
    const byId = new Map(result.map(item => [item.document_id, item.deletable]));
    expect(byId.get(10)).toBe(false);
    expect(byId.get(11)).toBe(true);
  });

  it('согласованный без открытия: ни одна', async () => {
    setup({ status: 'approved', unlocked_at: null }, []);
    const result = await listApprovalPeriodAttachments(2269);
    expect(result.every(item => item.deletable === false)).toBe(true);
    expect(pgQuery.mock.calls.some(call => String(call[0]).includes('FROM documents d'))).toBe(false);
  });

  it('черновик: все', async () => {
    setup({ status: 'draft', unlocked_at: null }, []);
    const result = await listApprovalPeriodAttachments(2269);
    expect(result.every(item => item.deletable === true)).toBe(true);
  });
});
