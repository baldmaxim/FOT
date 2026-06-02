import { describe, expect, it } from 'vitest';
import type { TimesheetApproval, TimesheetApprovalStatus } from '../types/index.js';
import { resolveOverlapSubmission } from './timesheet-approval-overlap.service.js';

const mk = (
  id: number,
  start: string,
  end: string,
  status: TimesheetApprovalStatus,
): TimesheetApproval => ({
  id,
  department_id: 'dept-1',
  manager_employee_id: null,
  start_date: start,
  end_date: end,
  status,
  submitted_by: null,
  submitted_at: null,
  reviewed_by: null,
  reviewed_at: null,
  review_comment: null,
  created_at: '2026-06-01T00:00:00.000Z',
  updated_at: '2026-06-01T00:00:00.000Z',
});

const MONTH = { startDate: '2026-05-01', endDate: '2026-05-31' };

describe('resolveOverlapSubmission', () => {
  it('нет пересечений → INSERT, ничего не удаляем', () => {
    const r = resolveOverlapSubmission([], MONTH);
    expect(r.reuseRow).toBeNull();
    expect(r.approvedOverlap).toBeNull();
    expect(r.exactSame).toBeNull();
    expect(r.toDeleteIds).toEqual([]);
  });

  it('полупериод submitted → месяц: переиспользуем активную строку, ничего не удаляем', () => {
    const half = mk(10, '2026-05-16', '2026-05-31', 'submitted');
    const r = resolveOverlapSubmission([half], MONTH);
    expect(r.reuseRow?.id).toBe(10);
    expect(r.toDeleteIds).toEqual([]);
    expect(r.approvedOverlap).toBeNull();
  });

  it('returned-полупериод → месяц: переиспользуем returned-строку', () => {
    const half = mk(11, '2026-05-16', '2026-05-31', 'returned');
    const r = resolveOverlapSubmission([half], MONTH);
    expect(r.reuseRow?.id).toBe(11);
    expect(r.toDeleteIds).toEqual([]);
  });

  it('точное совпадение submitted → idempotent (exactSame проставлен)', () => {
    const same = mk(12, '2026-05-01', '2026-05-31', 'submitted');
    const r = resolveOverlapSubmission([same], MONTH);
    expect(r.exactSame?.id).toBe(12);
    expect(r.reuseRow?.id).toBe(12);
  });

  it('approved-пересечение → блокировка, переиспользования нет', () => {
    const appr = mk(13, '2026-05-16', '2026-05-31', 'approved');
    const r = resolveOverlapSubmission([appr], MONTH);
    expect(r.approvedOverlap?.id).toBe(13);
    expect(r.reuseRow).toBeNull();
    expect(r.toDeleteIds).toEqual([]); // approved не удаляем
  });

  it('активная строка + draft-дубль → переиспользуем активную, draft вытесняем', () => {
    const active = mk(20, '2026-05-16', '2026-05-31', 'submitted');
    const draft = mk(21, '2026-05-01', '2026-05-10', 'draft');
    const r = resolveOverlapSubmission([active, draft], MONTH);
    expect(r.reuseRow?.id).toBe(20);
    expect(r.toDeleteIds).toEqual([21]);
  });

  it('нет активной/точной, только rejected-дубли → INSERT, все вытесняем', () => {
    const rej1 = mk(30, '2026-05-01', '2026-05-10', 'rejected');
    const rej2 = mk(31, '2026-05-20', '2026-05-25', 'rejected');
    const r = resolveOverlapSubmission([rej1, rej2], MONTH);
    expect(r.reuseRow).toBeNull();
    expect(r.toDeleteIds).toEqual([30, 31]);
  });
});
