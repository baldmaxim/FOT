import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Пересборка объектов подач месяца: фильтр по сотрудникам (пересчёт фиксации отдела) берёт
 * только подачи с ними; без фильтра — все, как ночью.
 */

const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../config/postgres.js', () => ({ query: db.query }));
vi.mock('../middleware/cacheResponse.js', () => ({ invalidateCaches: vi.fn() }));
vi.mock('./audit.service.js', () => ({ AUDIT_ACTIONS: {}, auditService: { log: vi.fn() } }));
vi.mock('./timesheet-snapshot-tx.js', () => ({ withTimesheetSnapshotTransaction: vi.fn() }));
vi.mock('./timesheet-version.service.js', () => ({ monthAnchorsInRange: vi.fn(() => []), rebuildVersionObjects: vi.fn() }));
vi.mock('./employee-timesheet-object.service.js', () => ({ monthEnd: () => '2026-09-30' }));

const { rebuildVersionObjectsForMonth } = await import('./timesheet-version-objects-rebuild.service.js');

beforeEach(() => {
  db.query.mockReset();
  db.query.mockResolvedValue([]);
});

describe('rebuildVersionObjectsForMonth', () => {
  it('без фильтра — все подачи месяца ($3 = NULL)', async () => {
    await rebuildVersionObjectsForMonth('2026-09-01');
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0][1]).toEqual(['2026-09-01', '2026-09-30', null]);
  });

  it('с фильтром — только подачи с этими сотрудниками', async () => {
    await rebuildVersionObjectsForMonth('2026-09-01', { employeeIds: [54, 483] });
    const [sql, params] = db.query.mock.calls[0];
    expect(params).toEqual(['2026-09-01', '2026-09-30', [54, 483]]);
    expect(sql).toContain('timesheet_approval_employees');
  });

  it('пустой фильтр — ничего не пересобирается и в БД не ходим', async () => {
    expect(await rebuildVersionObjectsForMonth('2026-09-01', { employeeIds: [] }))
      .toEqual({ approvals: 0, created: 0, failures: 0 });
    expect(db.query).not.toHaveBeenCalled();
  });
});
