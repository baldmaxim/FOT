import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Дедуп дублей отделов Sigur: «Офис» отдела (миграция 291) переходит на оставшийся отдел,
 * а перенос идёт под локом режимов табелирования — как у окна «Режим табелирования».
 */

const h = vi.hoisted(() => ({
  calls: [] as Array<{ sql: string; params: unknown[] }>,
  pairs: 1,
}));

vi.mock('../config/postgres.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  withTransaction: async (fn: (client: unknown) => Promise<unknown>) => fn({
    query: async (sql: string, params: unknown[] = []) => {
      h.calls.push({ sql, params });
      if (sql.includes('FROM dept_dedup_map') && sql.includes('count(*)')) return { rows: [{ n: h.pairs }] };
      if (sql.includes('count(*)::int AS n FROM employees')) return { rows: [{ n: 2 }] };
      return { rows: [], rowCount: 0 };
    },
  }),
}));

const { consolidateDuplicateDepartments } = await import('./sigur-sync-structure.service.js');

const indexOf = (predicate: (sql: string) => boolean): number => h.calls.findIndex(call => predicate(call.sql));

beforeEach(() => {
  h.calls = [];
  h.pairs = 1;
});

describe('consolidateDuplicateDepartments', () => {
  it('лок режимов — до переносов; «Офис» дубля переходит на оставшийся отдел', async () => {
    await consolidateDuplicateDepartments();

    const lock = indexOf(sql => sql.includes('pg_advisory_xact_lock'));
    const firstMove = indexOf(sql => sql.startsWith('UPDATE employees'));
    expect(lock).toBeGreaterThan(-1);
    expect(h.calls[lock].params).toEqual([249_0001]);
    expect(lock).toBeLessThan(firstMove);

    const officeDelete = indexOf(sql => sql.startsWith('DELETE FROM timesheet_office_departments'));
    const officeUpdate = indexOf(sql => sql.startsWith('UPDATE timesheet_office_departments'));
    const orphanDelete = indexOf(sql => sql.startsWith('DELETE FROM org_departments'));
    expect(officeDelete).toBeGreaterThan(-1);
    // Сначала убираем столкновение с уже существующим правилом цели, потом переносим, и только
    // потом удаляем дубль: иначе ON DELETE CASCADE снёс бы правило вместе с отделом.
    expect(officeDelete).toBeLessThan(officeUpdate);
    expect(officeUpdate).toBeLessThan(orphanDelete);
    expect(h.calls[officeUpdate].sql).toContain('SET org_department_id = m.canonical_id');
  });

  it('дублей нет — ни лока, ни переносов', async () => {
    h.pairs = 0;
    await expect(consolidateDuplicateDepartments()).resolves.toEqual({ pairs: 0, employeesMoved: 0 });
    expect(indexOf(sql => sql.includes('pg_advisory_xact_lock'))).toBe(-1);
  });
});
