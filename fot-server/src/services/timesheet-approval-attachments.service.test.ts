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
  listApprovalEmployees: vi.fn(),
}));

import { listApprovalPeriodAttachments } from './timesheet-approval-attachments.service.js';
import { listApprovalEmployees } from './timesheet-approval-employees-snapshot.service.js';

/**
 * Один комплексный сценарий подачи: служебка руководителя + корректировка (она же
 * привязана к заявке = два источника) + отпуск на 3 дня одним файлом (без own-ссылки) +
 * legacy-файл заявления (documents.leave_request_id, без document_links).
 */
const setupHappyPath = (): void => {
  vi.mocked(listApprovalEmployees).mockResolvedValue([
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

    // --- leave_requests (time_correction) ---
    if (sql.includes('FROM leave_requests')) {
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

    // Корректировка руководителя — два источника.
    const corr = result[1];
    expect(corr.document_id).toBe(20);
    expect(corr.kind).toBe('correction');
    expect([...(corr.sources ?? [])].sort()).toEqual(['correction', 'leave_request']);
    expect(corr.reason_label).toBe('Корректировка, заявление');
    expect(corr.is_submitter_file).toBe(true);
    expect(corr.employee_name).toBe('Иванов Иван');
    expect(corr.employee_position).toBe('Геодезист');
    expect(corr.work_dates).toEqual(['2026-06-05']);

    // Отпуск: один файл без own-ссылки, дедуп на 3 дня.
    const vacation = result[2];
    expect(vacation.document_id).toBe(30);
    expect(vacation.kind).toBe('leave_request');
    expect(vacation.reason_label).toBe('Заявление');
    expect(vacation.is_submitter_file).toBe(false);
    expect(vacation.employee_name).toBe('Иванов Иван');
    expect(vacation.work_dates).toEqual(['2026-06-01', '2026-06-02', '2026-06-03']);

    // Legacy-файл заявления (documents.leave_request_id) тоже попал.
    const legacy = result[3];
    expect(legacy.document_id).toBe(40);
    expect(legacy.kind).toBe('leave_request');
    expect(legacy.employee_name).toBe('Петров Пётр');
    expect(legacy.employee_position).toBe('Инженер');
    expect(legacy.work_dates).toEqual(['2026-06-07']);
  });

  it('пустой период без файлов → пустой массив', async () => {
    vi.mocked(listApprovalEmployees).mockResolvedValue([]);
    pgQueryOne.mockResolvedValue({ start_date: '2026-06-01', end_date: '2026-06-15', submitted_by: 'mgr-user' });
    pgQuery.mockResolvedValue([]);
    const result = await listApprovalPeriodAttachments(1);
    expect(result).toEqual([]);
  });
});
