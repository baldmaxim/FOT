import { describe, expect, it } from 'vitest';
import {
  FIRED_HIDDEN_FROM_MONTH,
  firedEligibleSql,
  firedHiddenSql,
  isFiredHiddenForPeriod,
} from './timesheet-fired-cutoff.service.js';

/**
 * Уволенный не виден в месяце увольнения — с периодов от 01.09.2026; август и раньше —
 * как было (виден до даты увольнения).
 */
describe('isFiredHiddenForPeriod', () => {
  const fired = (dismissal: string | Date | null) => ({ employment_status: 'fired', dismissal_date: dismissal });

  it('уволен в месяце периода — скрыт, в том числе для 1–15 при увольнении 22-го', () => {
    expect(isFiredHiddenForPeriod(fired('2026-09-22'), '2026-09-01')).toBe(true);
    expect(isFiredHiddenForPeriod(fired('2026-09-22'), '2026-09-16')).toBe(true);
    expect(isFiredHiddenForPeriod(fired('2026-09-01'), '2026-09-01')).toBe(true);
    expect(isFiredHiddenForPeriod(fired('2026-09-30'), '2026-09-01')).toBe(true);
  });

  it('уволен раньше месяца периода — тоже скрыт', () => {
    expect(isFiredHiddenForPeriod(fired('2026-08-10'), '2026-10-01')).toBe(true);
  });

  it('уволен в следующем месяце — в периоде виден', () => {
    expect(isFiredHiddenForPeriod(fired('2026-10-01'), '2026-09-16')).toBe(false);
  });

  it('до сентября 2026 — никого не скрываем: там правило прежнее', () => {
    expect(FIRED_HIDDEN_FROM_MONTH).toBe('2026-09-01');
    expect(isFiredHiddenForPeriod(fired('2026-08-25'), '2026-08-16')).toBe(false);
  });

  it('работающий с отложенным увольнением, восстановленный и уволенный без даты — не скрыты', () => {
    expect(isFiredHiddenForPeriod({ employment_status: 'active', dismissal_date: '2026-09-10' }, '2026-09-01')).toBe(false);
    expect(isFiredHiddenForPeriod(fired(null), '2026-09-01')).toBe(false);
  });

  it('дата как Date (без парсера pg) — тоже понимается', () => {
    expect(isFiredHiddenForPeriod(fired(new Date('2026-09-22T00:00:00Z')), '2026-09-01')).toBe(true);
  });
});

describe('SQL-признаки', () => {
  it('состав периода: работающие или уволенные позже; граница — с сентября 2026 следующий месяц', () => {
    const sql = firedEligibleSql('e', '$2');
    expect(sql).toContain("e.employment_status = 'active'");
    expect(sql).toContain("e.dismissal_date >= (CASE WHEN $2::date >= DATE '2026-09-01'");
    expect(sql).toContain("+ interval '1 month'");
    expect(firedEligibleSql(null, '$1')).toContain("(employment_status = 'active'");
  });

  it('скрытый в ростере: только с сентября 2026 и только уволенный с датой', () => {
    const sql = firedHiddenSql('e', 'a.start_date');
    expect(sql).toContain("a.start_date::date >= DATE '2026-09-01'");
    expect(sql).toContain("e.employment_status IS NOT DISTINCT FROM 'fired'");
    expect(sql).toContain('e.dismissal_date IS NOT NULL');
  });
});
