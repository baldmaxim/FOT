import { beforeEach, describe, expect, it, vi } from 'vitest';

// Кэш профилей пар: считаются только недостающие пары, одинаковые вычисления в полёте общие, TTL 2 минуты.
// Сам расчёт (атрибуция, категория, объект) подставляется — он сверяется со «Сводом» в payroll-summary.pg.test.ts.

const calls = vi.hoisted(() => ({ attribute: [] as string[][] }));

vi.mock('../../config/postgres.js', () => ({
  query: async (_sql: string, params: unknown[]) => (params[0] as number[]).map(id => ({
    id, org_department_id: null, employment_status: 'active',
  })),
}));
vi.mock('./payroll-month-attribution.service.js', () => ({
  loadMonthBreakdown: async () => new Map(),
  attributeMonths: async (pairs: Array<{ employeeId: number; month: string }>) => {
    calls.attribute.push(pairs.map(pair => `${pair.employeeId}|${pair.month}`));
    return new Map(pairs.map(pair => [
      `${pair.employeeId}|${pair.month}`,
      { object: { key: 'office', name: 'Офис' }, departmentId: null, mode: undefined },
    ]));
  },
}));
vi.mock('./payroll-staff-category.js', () => ({
  resolveMonthStaffCategories: async (items: Array<{ officeObject: boolean }>) => items.map(item => (item.officeObject ? 'office' : 'worker')),
}));
vi.mock('./payroll-summary-object.service.js', () => ({ resolveSummaryObjects: async () => new Map() }));

import { clearMonthProfileCache, loadMonthProfiles } from './payroll-month-profile.service.js';

const pair = (employeeId: number, month = '2026-09') => ({ employeeId, month });

describe('loadMonthProfiles', () => {
  beforeEach(() => {
    clearMonthProfileCache();
    calls.attribute.length = 0;
  });

  it('профиль — категория и объект атрибуции', async () => {
    const profiles = await loadMonthProfiles([pair(1)]);
    expect(profiles.get('1|2026-09')).toEqual({ category: 'office', object: { key: 'office', name: 'Офис' } });
  });

  it('закэшированные пары не считаются заново, повторы во входе — один раз', async () => {
    await loadMonthProfiles([pair(1), pair(2)]);
    const profiles = await loadMonthProfiles([pair(2), pair(3), pair(3), pair(1, '2026-10')]);
    expect(calls.attribute).toEqual([['1|2026-09', '2|2026-09'], ['3|2026-09', '1|2026-10']]);
    expect([...profiles.keys()].sort()).toEqual(['1|2026-10', '2|2026-09', '3|2026-09']);
  });

  it('одинаковые запросы в полёте — одно вычисление', async () => {
    const [first, second] = await Promise.all([loadMonthProfiles([pair(1), pair(2)]), loadMonthProfiles([pair(2), pair(1)])]);
    expect(calls.attribute).toEqual([['1|2026-09', '2|2026-09']]);
    expect(second).toEqual(first);
  });

  it('через 2 минуты — считается заново', async () => {
    let now = 1_000_000;
    const clock = () => now;
    await loadMonthProfiles([pair(1)], clock);
    now += 2 * 60_000;
    await loadMonthProfiles([pair(1)], clock);
    expect(calls.attribute).toHaveLength(1);
    now += 1;
    await loadMonthProfiles([pair(1)], clock);
    expect(calls.attribute).toHaveLength(2);
  });
});
